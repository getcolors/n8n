// Opt-in deployment-owned S3 buckets for Neon data and backups, each with its
// own bucket-scoped IAM identity.
//
// Modelled on the langfuse package's storage stage. The stage exists only when
// `n8n-storage-managed` is true; otherwise every function here is a no-op and
// the operator supplies the two credential pairs by hand, as before.
import {stageDir} from "red/cli";
import {runtime} from "red/runtime";
import {scaffold, PRESERVE_JINJA_DELIMITERS, type Spec} from "red/scaffold";
import * as tofu from "red/tofu";
import type {Opts} from "red/workflow";
import mainTf from "../resources/tools/storage/main.tf" with {type: "text"};

export const tool = "n8n-storage";
export const managed = (opts: Opts): boolean => opts["n8n-storage-managed"] === true;
export const directory = (opts: Opts): string => stageDir(opts, tool, {defaultProfile: "n8n"});

// AWS credentials supplied as COLORS_PAR_AWS_* overlays, mapped onto the
// variable names the AWS SDK reads. Empty when the operator relies on the
// ambient credential chain instead.
export function awsEnv(opts: Opts): Record<string, string> {
  return Object.fromEntries(Object.entries({"aws-access-key-id":"AWS_ACCESS_KEY_ID", "aws-secret-access-key":"AWS_SECRET_ACCESS_KEY", "aws-session-token":"AWS_SESSION_TOKEN"}).filter(([key]) => String(opts[key] ?? "").length > 0).map(([key, variable]) => [variable, String(opts[key])]));
}

// Bucket roles, in the order the template declares them, each paired with the
// desired-state key naming its bucket and the COLORS_PAR_ prefix its
// credential reaches Ansible under.
export const roles: Array<{role: string; bucketKey: string; prefix: string}> = [
  {role: "neon", bucketKey: "neon-r2-bucket", prefix: "NEON_R2"},
  {role: "backup", bucketKey: "n8n-backup-r2-bucket", prefix: "N8N_BACKUP_R2"},
];

export function specs(opts: Opts): Spec[] {
  return [{template:{name:"tools/storage/main.tf", content:mainTf}, target:directory(opts)+"/main.tf", data:opts, opts:PRESERVE_JINJA_DELIMITERS}];
}

// Refuse existing buckets unless this stage already owns their Terraform
// address. A bucket that answers anything but 404 to a head-bucket probe is
// someone's, or unreachable; both fail closed.
export async function ownershipPreflight(opts: Opts): Promise<void> {
  const config = {cwd:directory(opts), env:awsEnv(opts)};
  const init = await runtime.exec(["tofu", "init", "-input=false", "-no-color"], config);
  if (init.exit !== 0) throw new Error("managed storage state operation failed");
  const state = await runtime.exec(["tofu", "state", "list"], config);
  const emptyState = state.exit === 1 && /No state file was found!/.test(state.err);
  if (state.exit !== 0 && !emptyState) throw new Error("managed storage state unavailable");
  let resources: Array<{address:string, values?:{bucket?:string}}> = [];
  if (state.exit === 0 && state.out.trim()) {
    const shown = await runtime.exec(["tofu", "show", "-json"], config);
    if (shown.exit !== 0) throw new Error("managed storage state operation failed");
    resources = JSON.parse(shown.out).values?.root_module?.resources ?? [];
  }
  for (const {role, bucketKey} of roles) {
    const bucket = opts[bucketKey];
    if (resources.some(resource => resource.address === `aws_s3_bucket.application["${role}"]` && resource.values?.bucket === bucket)) continue;
    const probe = await runtime.exec(["aws","s3api","head-bucket","--bucket",String(bucket),"--region",String(opts["neon-r2-region"])],config);
    // 403, network failures, and a successful probe all fail closed.
    if (!(probe.exit > 0 && /\(404\)|Not Found|NoSuchBucket/.test(probe.err))) throw new Error("managed storage refuses to adopt an existing or inaccessible bucket");
  }
}

export async function storageStep(opts: Opts): Promise<Opts> {
  if (!managed(opts)) return {...opts,"red/exit":0};
  try {
    const documents = specs(opts);
    if (opts["red/event"] === "create") { scaffold(opts,documents); await ownershipPreflight(opts); }
    // Scoped credentials stay in memory and in the encrypted backend state.
    // They are never copied into template values or printed.
    return await tofu.tofuWithSpec(opts,documents,{dir:directory(opts),env:awsEnv(opts),outputKey:"n8n/storage-credentials"});
  } catch { return {...opts,"red/exit":1,"red/err":"managed S3 storage failed; inspect bucket ownership, state access, and AWS permissions"}; }
}

// The minted pairs as the COLORS_PAR_ variables the plays already look up,
// for the Ansible subprocess environment only. Throws when a pair is absent,
// so a converge never runs with an empty credential.
export function credentialEnv(opts: Opts): Record<string,string> {
  const credentials = (opts["n8n/storage-credentials"] as {credentials?: Record<string, {access_key_id?: unknown; secret_access_key?: unknown}>} | undefined)?.credentials ?? {};
  const environment: Record<string,string> = {ANSIBLE_HOST_KEY_CHECKING:"False"};
  for (const {role, prefix} of roles) {
    const {access_key_id, secret_access_key} = credentials[role] ?? {};
    if (!String(access_key_id ?? "").trim() || !String(secret_access_key ?? "").trim()) throw new Error("managed storage credentials unavailable");
    environment[`COLORS_PAR_${prefix}_ACCESS_KEY_ID`] = String(access_key_id);
    environment[`COLORS_PAR_${prefix}_SECRET_ACCESS_KEY`] = String(secret_access_key);
  }
  return environment;
}
