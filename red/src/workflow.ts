import { readPars, parName } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";
import { finalize_backend } from "colors-compute-red";
import * as compute from "./compute.ts";
import * as sshConfig from "./ssh-config.ts";
import * as storage from "./storage.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": "vultr", "provider-dns": "cloudflare",
  "provider-backend": "r2", "compute-prevent-destroy": true,
  workdir: ".colors",
};

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
): Promise<Opts> {
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      (current, _environment, { event, real }) =>
        real && (event === "create" || event === "delete")
          ? validate.secretErrors(current, event)
          : [],
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
    afterValidate: (current, _environment, {event,real}) => real && event==='create' ? sshConfig.preflight({...current,'red/exit':0}) : {...current,'red/exit':0},
  }, env);
}

export const managedBackend = (opts: Opts): boolean => opts["s3-bucket-mode"] === "managed";

export const loadStep = (opts: Opts): Promise<Opts> => compute.loadStep(opts, tools.environment(opts));

// Remove the deployment-owned S3 state bucket, last of all. The library
// refuses while any live state or unowned object remains in it.
export async function backendFinalizeStep(opts: Opts): Promise<Opts> {
  try {
    const result = await finalize_backend(opts, tools.environment(opts));
    return ["destroyed", "absent", "skipped"].includes(result.status)
      ? { ...opts, "red/exit": 0 }
      : { ...opts, "red/exit": 1, "red/err": "managed backend finalization refused" };
  } catch {
    return { ...opts, "red/exit": 1, "red/err": "managed backend finalization refused; live or unowned state remains" };
  }
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "n8n/start": [startStep, "n8n/load"],
      "n8n/load": [loadStep, "n8n/ansible"],
      "n8n/ansible": [tools.ansibleStep, "n8n/ssh-config"],
      // The `~/.ssh/config` block goes before the destroy, the opposite of the
      // keypair below. A block that outlives its host is stale but harmless; a
      // key that predeceases its host locks the operator out of a machine that
      // still exists. Both orders are deliberate; see standards/ssh-config.md.
      "n8n/ssh-config": [tools.ansibleLocalStep, "n8n/dns"],
      // DNS goes before the compute destroy: a record pointing at an address
      // that no longer answers is a live outage for anything still resolving
      // it, while a record removed slightly early merely 404s.
      "n8n/dns": [tools.dnsStep, storage.managed(runOpts) ? "n8n/storage" : "n8n/infrastructure"],
      // Managed buckets go after the host is stopped and before the compute
      // destroy, so nothing is still writing into a bucket being emptied.
      "n8n/storage": [storage.storageStep, "n8n/infrastructure"],
      "n8n/infrastructure": managedBackend(runOpts)
        ? [tools.infrastructureStep, "n8n/backend-finalize"]
        : [tools.infrastructureStep],
      "n8n/backend-finalize": [backendFinalizeStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "n8n/start": [startStep, "n8n/infrastructure"],
    // After compute, which is where the address first exists, and before the
    // stage that converges the machine — the converge and the acceptance both
    // ride the alias this stage writes.
    "n8n/infrastructure": [tools.infrastructureStep, storage.managed(runOpts) ? "n8n/storage" : "n8n/dns"],
    // The buckets and their scoped credentials exist before the converge that
    // hands them to the host.
    "n8n/storage": [storage.storageStep, "n8n/dns"],
    // DNS before the converge, not after: Caddy provisions its certificate
    // over ACME on first start, and the HTTP-01 challenge needs the name to
    // already resolve to this host. Converging first would make the first boot
    // fail its certificate and retry on ACME's backoff.
    "n8n/dns": [tools.dnsStep, "n8n/ssh-config"],
    "n8n/ssh-config": [tools.ansibleLocalStep, "n8n/ansible"],
    "n8n/ansible": [tools.ansibleStep, "n8n/acceptance"],
    "n8n/acceptance": [tools.acceptanceStep],
  };
  return graph[step];
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile ?? ""}/${tool}.tfstate`,
  });
}

export const sideEffecting = [
  "n8n/backend-finalize", "n8n/storage", "n8n/infrastructure", "n8n/dns", "n8n/ssh-config",
  "n8n/ansible", "n8n/acceptance", "n8n/load",
];

// Static successors, except after a delete's load step that found no live
// compute under a managed state bucket: then only finalization remains.
export function nextFn(step: string, successors: string[] | null | undefined, opts: Opts): Array<[string, Opts]> {
  if (failed(opts)) return [];
  if (step === "n8n/load" && opts["n8n/finalize-only"]) return [["n8n/backend-finalize", opts]];
  return (successors ?? []).map((next) => [next, opts]);
}

function create() {
  let wf = workflow({ start: "n8n/start", wireFn, nextFn });
  wf = adviceAdd(wf,"n8n/dns","before","n8n.workflow/backend",backendAdvice(tools.dnsTool));
  wf = adviceAdd(wf,"n8n/storage","before","n8n.workflow/storage-backend",backendAdvice(storage.tool));
  return dryRun.advise(progress.advise(wf), sideEffecting);
}

export const n8nWorkflow = create();
