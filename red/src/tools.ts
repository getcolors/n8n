import { createHash } from "node:crypto";
import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime } from "red/runtime";
import type { Opts } from "red/workflow";
import { failed } from "red/workflow";
import { neonResource } from "./neon.ts";
import * as sshConfig from "./ssh-config.ts";
import * as validate from "./validate.ts";

import ansibleSiteYml from "../resources/tools/ansible/site.yml" with { type: "text" };
import ansibleN8nYml from "../resources/tools/ansible/n8n.yml" with { type: "text" };
import ansibleCleanupYml from "../resources/tools/ansible/cleanup.yml" with { type: "text" };
import ansibleComposeOverride from "../resources/tools/ansible/compose.override.yml" with { type: "text" };
import ansibleCaddyfile from "../resources/tools/ansible/Caddyfile" with { type: "text" };
import ansibleEnvSh from "../resources/tools/ansible/n8n-env.sh" with { type: "text" };
import ansibleBackupSh from "../resources/tools/ansible/n8n-backup.sh" with { type: "text" };
import ansibleRestoreSh from "../resources/tools/ansible/n8n-restore.sh" with { type: "text" };
import ansibleMonitorSh from "../resources/tools/ansible/n8n-monitor.sh" with { type: "text" };
import ansibleSmokeSh from "../resources/tools/ansible/n8n-smoke.sh" with { type: "text" };
import ansibleClaimOwnerSh from "../resources/tools/ansible/n8n-claim-owner.sh" with { type: "text" };
import ansibleSoakSh from "../resources/tools/ansible/n8n-soak.sh" with { type: "text" };
import ansibleSoakJs from "../resources/tools/ansible/soak.js" with { type: "text" };
import ansibleAcceptanceJs from "../resources/tools/ansible/acceptance.js" with { type: "text" };
import ansibleRehearsalJs from "../resources/tools/ansible/rehearsal.js" with { type: "text" };
import ansibleRehearsalSh from "../resources/tools/ansible/n8n-rehearsal.sh" with { type: "text" };
import ansiblePruneDrillSh from "../resources/tools/ansible/n8n-prune-drill.sh" with { type: "text" };
import ansibleRestartDrillSh from "../resources/tools/ansible/n8n-restart-drill.sh" with { type: "text" };
import dnsMainTf from "../resources/tools/dns/main.tf" with { type: "text" };
import infrastructureMainTf from "../resources/tools/infrastructure/main.tf" with { type: "text" };

export const infrastructureTool = "n8n-infrastructure";
export const dnsTool = "n8n-dns";
export const ansibleTool = "n8n-ansible";
export const ansibleLocalTool = "n8n-ansible-local";
export const templateOpts = PRESERVE_JINJA_DELIMITERS;

export function toolDir(opts: Opts, tool: string): string {
  return stageDir(opts, tool, { defaultProfile: "n8n" });
}

const template = (name: string, content: string): Template => ({ name, content });

// The storage tier's templates come from the SHA-pinned `package-neon-red`
// dependency, not from this repository. See neon.ts: they are read off the
// installed package and never copied in here, never edited. A copy of a tier
// this subtle drifts, and the drift is silent.
const neonTemplate = (path: string, file: string): Template =>
  template(`neon/${path}/${file}`, neonResource(path, file));

function spec(source: Template, target: string, data: Opts): Spec {
  return { template: source, target, data, opts: templateOpts };
}

const rawSpec = (target: string, content: string): Spec => contentSpec(target, content);

export function cidrs(opts: Opts, key: string): string[] {
  const value = opts[key];
  const parts = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/);
  return parts.map((part) => String(part).trim()).filter((part) => part.length > 0);
}

export function credentialEnv(opts: Opts, ...slots: string[]): Record<string, string> | undefined {
  const mapping: Record<string, string> = Object.assign(
    {},
    ...[...slots, "provider-backend"].map((slot) => validate.tofuEnv(opts, slot)),
  );
  const env: Record<string, string> = {};
  for (const [key, envVar] of Object.entries(mapping)) {
    const value = String(opts[key] ?? "");
    if (value.length > 0) env[envVar] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export const backendCredentialEnv = (opts: Opts) => credentialEnv(opts);

export function fallbackParams(opts: Opts): Record<string, unknown> {
  return { ip: "192.0.2.10", user: "root", sudoer: "root", name: validate.computeName(opts) };
}

export function outputParams(result: Opts): Record<string, unknown> | undefined {
  const params = (result["tofu/outputs"] as Record<string, unknown> | undefined)?.params;
  return params && typeof params === "object" ? params as Record<string, unknown> : undefined;
}

// The Neon data prefix inside the R2 bucket. Everything the pageserver and
// safekeeper write — and the ownership markers guarding adoption — lives
// under `<profile>/data/`. The tofu state for the same deployment lives at
// `<profile>/<stage>.tfstate` in the same bucket, a sibling key space that
// never collides with this one.
export function r2Prefix(opts: Opts): string {
  return `${opts.profile}/data`;
}

// Cheshire's pretty printer, in insertion order — Green's byte-level artifact
// contract for the two documents this package writes itself. `tofu.constructs`
// sorts keys, which is right for a Terraform document and wrong here: the
// inventory's two groups must stay in the order they are declared.
function pretty(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => pretty(item, indent)).join(", ")} ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{ }";
    const pad = " ".repeat(indent + 2);
    return `{\n${entries
      .map(([key, nested]) => `${pad}${JSON.stringify(key)} : ${pretty(nested, indent + 2)}`)
      .join(",\n")}\n${" ".repeat(indent)}}`;
  }
  return JSON.stringify(value ?? null);
}

// ---------------------------------------------------------------- compute

// Cloudflare's published ranges, current as of 2026-09-01. Used when
// `vultr-http-sources` is the symbolic value `cloudflare` and the live fetch is
// unavailable — a `build` on a fresh checkout with no network must still
// render, or the offline-render guarantee this workspace relies on is gone.
// A real converge prefers the fetch and FAILS rather than silently widening.
export const cloudflareRangesFallback = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];

export const USER_AGENT = "colors-n8n";

// Cloudflare's published ranges, or undefined when they cannot be fetched.
//
// Never widens on failure: the caller decides, and on a real event it stops.
export async function fetchCloudflareRanges(): Promise<string[] | undefined> {
  try {
    const pull = async (url: string) => {
      // An explicit User-Agent, because Cloudflare answers some runtime
      // defaults with 403 Forbidden — blue's did, and the fallback list then
      // rendered on every build, so the colours disagreed on `origin` for one
      // desired state. Nothing here should depend on which runtime a colour is
      // written in, so both name themselves the same way.
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return (await response.text()).split("\n")
        .map((line) => line.trim()).filter((line) => line.length > 0);
    };
    const ranges = [
      ...await pull("https://www.cloudflare.com/ips-v4"),
      ...await pull("https://www.cloudflare.com/ips-v6"),
    ];
    return ranges.length > 0 ? ranges : undefined;
  } catch {
    return undefined;
  }
}

export interface HttpSources {
  source: "explicit" | "fetched" | "fallback";
  ranges: string[];
}

// The origin ingress list.
//
// `cloudflare` is a symbolic source this package RESOLVES — not a pinned list
// in desired state, which an earlier draft wrongly called it. Returns the
// resolved set plus how it was obtained, so the caller can record a checksum
// and so a real converge can refuse to proceed on a stale fallback.
export async function httpSources(opts: Opts): Promise<HttpSources> {
  if (validate.s(opts["vultr-http-sources"]) !== "cloudflare") {
    return { source: "explicit", ranges: cidrs(opts, "vultr-http-sources") };
  }
  const live = await fetchCloudflareRanges();
  return live
    ? { source: "fetched", ranges: live }
    : { source: "fallback", ranges: cloudflareRangesFallback };
}

export function rangesChecksum(values: string[]): string {
  return createHash("sha256").update([...values].sort().join("\n"))
    .digest("hex").slice(0, 16);
}

export async function infrastructureData(opts: Opts): Promise<Opts> {
  const { source, ranges } = await httpSources(opts);
  return {
    ...opts,
    "compute-name": validate.computeName(opts),
    "ssh-keygen": validate.keygen(opts),
    "ssh-sources-hcl": tofu.hclList(cidrs(opts, "vultr-ssh-sources")),
    "http-sources-hcl": tofu.hclList(ranges),
    "http-sources-origin": source,
    "http-sources-ranges": ranges,
    "http-sources-checksum": rangesChecksum(ranges),
  };
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, infrastructureTool);
  const data = await infrastructureData(opts);
  const specs = [
    spec(template("infrastructure/main.tf", infrastructureMainTf), `${dir}/main.tf`, data),
    // The resolved range set is recorded, with a checksum, so a firewall
    // change is explainable after the fact rather than an unattributable diff
    // in a provider plan.
    rawSpec(`${dir}/http-sources.json`, pretty({
      origin: data["http-sources-origin"],
      checksum: data["http-sources-checksum"],
      ranges: data["http-sources-ranges"],
    })),
  ];
  const result = await tofu.tofuWithSpec(opts, specs,
    { dir, env: credentialEnv(opts, "provider-compute") });
  if (failed(result)) return result;
  if (opts["red/event"] === "build") return { ...result, ...fallbackParams(opts) };
  if (opts["red/event"] === "delete") return result;
  return { ...result, ...fallbackParams(opts), ...outputParams(result) };
}

// ---------------------------------------------------------- ansible (local)

// Only what a `build` genuinely knows. The address, the user and the alias are
// run-time facts and reach the play as extra-vars instead, so the rendered
// playbook carries no IP and is identical on every workstation (SSH Config
// Standard §6).
export function ansibleLocalData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "ssh-config-identity-file": sshConfig.identityFile(opts),
  };
}

export function ansibleLocalSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleLocalTool);
  const data = ansibleLocalData(opts);
  // Also the dependency's, unchanged: the ~/.ssh/config block this writes is
  // the SSH Config Standard's, and it is parameterised by profile and address
  // alone. A second implementation here would be a second thing to keep
  // conformant with a standard that already has a reference implementation.
  return ["ansible.cfg", "inventory.ini", "main.yml"].map((name) =>
    spec(neonTemplate("ansible-local", name), `${dir}/${name}`, data));
}

// Write or remove the `~/.ssh/config` block. The same playbook serves both
// events; `block_state` is what distinguishes them.
export async function ansibleLocalStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleLocalTool);
  const isDelete = opts["red/event"] === "delete";
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.ini",
    playbooks: { create: "main.yml", delete: "main.yml" },
    extraVars: {
      host_alias: sshConfig.hostAlias(opts),
      ip: opts.ip ?? fallbackParams(opts).ip,
      user: opts.user ?? "root",
      block_state: isDelete ? "absent" : "present",
    },
  }, ansibleLocalSpecs(opts));
}

// ---------------------------------------------------------------- ansible

// One host in two groups.
//
// The imported getcolors/neon play targets `hosts: neon` and this package's
// play targets `hosts: n8n`; both converge the same machine. Ansible supports a
// host in several groups, but group_vars precedence between them would be a
// live hazard, so every value is a HOST var here and neither group carries
// variables at all. Nothing can then depend on which group won.
export function inventory(opts: Opts): string {
  const profile = String(opts.profile);
  return pretty({
    all: {
      children: {
        neon: { hosts: { [profile]: null } },
        n8n: { hosts: { [profile]: null } },
      },
      hosts: {
        [profile]: {
          ansible_host: opts.ip ?? "192.0.2.10",
          ansible_user: "root",
        },
      },
    },
  });
}

// Template values for the Ansible stage.
//
// Deliberately carries neither operator secret. The R2 pair reaches the host
// as Ansible `lookup('env', ...)` expressions written literally into main.yml,
// where `preserve-jinja-delimiters` passes them through untouched — routing
// them through this map instead would let the template engine HTML-escape the
// quotes and hand Ansible `&#39;`. The secret therefore exists only in the
// process that needs it: not in `.colors/`, not in a golden, not in this map.
export function ansibleData(opts: Opts): Opts {
  return {
    ...opts,
    ip: opts.ip ?? "192.0.2.10",
    "ssh-keygen": validate.keygen(opts),
    "neon-r2-prefix": opts["neon-r2-prefix"] ?? r2Prefix(opts),
  };
}

// The storage tier, rendered UNCHANGED from the pinned dependency into its own
// `neon/` subdirectory.
//
// The subdirectory is not tidiness. The upstream play copies its files by
// relative `src:` name (`main.yml:106`), so rendering them flat beside this
// package's templates would let an n8n file with the same basename win
// silently. Keeping the bundle whole and separate is what makes
// `import_playbook neon/main.yml` mean the dependency's play and nothing else.
export const neonFiles = [
  "ansible.cfg", "main.yml", "cleanup.yml", "compose.yml",
  "pageserver.toml", "identity.toml", "config.json", "scramgen.py",
  "bootstrap.sh", "smoke.sh", "status.sh", "rotate.sh",
];

export function neonSpecs(dir: string, data: Opts): Spec[] {
  const sub = `${dir}/neon`;
  return neonFiles.map((file) =>
    spec(neonTemplate("ansible", file), `${sub}/${file}`, data));
}

const n8nAnsibleFiles: Array<[string, string]> = [
  ["site.yml", ansibleSiteYml],
  ["n8n.yml", ansibleN8nYml],
  ["cleanup.yml", ansibleCleanupYml],
  // Installed on the host as /opt/neon/compose.override.yml, beside the
  // dependency's compose.yml — never passed with -f. See the header of that
  // template for why that is load-bearing rather than stylistic.
  ["compose.override.yml", ansibleComposeOverride],
  ["Caddyfile", ansibleCaddyfile],
  ["n8n-env.sh", ansibleEnvSh],
  ["n8n-backup.sh", ansibleBackupSh],
  ["n8n-restore.sh", ansibleRestoreSh],
  ["n8n-monitor.sh", ansibleMonitorSh],
  ["n8n-smoke.sh", ansibleSmokeSh],
  ["n8n-claim-owner.sh", ansibleClaimOwnerSh],
  ["n8n-soak.sh", ansibleSoakSh],
  // Plain JavaScript with no template markers, but rendered through the same
  // path so one mechanism installs everything.
  ["soak.js", ansibleSoakJs],
  ["acceptance.js", ansibleAcceptanceJs],
  ["rehearsal.js", ansibleRehearsalJs],
  ["n8n-rehearsal.sh", ansibleRehearsalSh],
  ["n8n-prune-drill.sh", ansiblePruneDrillSh],
  ["n8n-restart-drill.sh", ansibleRestartDrillSh],
];

export function ansibleSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleTool);
  const data = ansibleData(opts);
  return [
    ...neonSpecs(dir, data),
    // The dependency's, not a local copy. Writing our own dropped its
    // `<% if ssh-keygen %> private_key_file` conditional, and the deployment
    // then had no identity to offer -- `Permission denied (publickey)` after a
    // ten-minute wait_for_connection timeout. Reusing it is both less code and
    // the only version that stays correct when the standard moves.
    spec(neonTemplate("ansible", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    ...n8nAnsibleFiles.map(([name, content]) =>
      spec(template(`ansible/${name}`, content), `${dir}/${name}`, data)),
    rawSpec(`${dir}/inventory.json`, inventory(data)),
  ];
}

// ------------------------------------------------------------------- dns

export function dnsData(opts: Opts): Opts {
  return { ...opts, ip: opts.ip ?? "192.0.2.10" };
}

// The data source in dns/main.tf is named `zone`, and the attribute is `id`.
// `data.cloudflare_zone.this.zone_id` -- the shape that reads most naturally --
// is wrong on both counts and fails only at apply time, after the compute
// stage has already created a billable instance.
export const zoneId = "${data.cloudflare_zone.zone.id}";

export function dnsJson(data: Opts): string {
  return tofu.constructsJson([
    tofu.construct("resource", "cloudflare_dns_record", "n8n", {
      zone_id: zoneId,
      // The full name, not the leaf label.
      name: data["n8n-host"],
      type: "A",
      content: data.ip,
      // 1 means "automatic". Cloudflare rejects any explicit TTL on a proxied
      // record, because the edge controls it.
      ttl: 1,
      proxied: Boolean(data["cloudflare-proxied"]),
    }),
  ]);
}

export async function dnsStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, dnsTool);
  const data = dnsData(opts);
  const specs = [
    spec(template("dns/main.tf", dnsMainTf), `${dir}/main.tf`, data),
    rawSpec(`${dir}/record.tf.json`, dnsJson(data)),
  ];
  return tofu.tofuWithSpec(opts, specs, { dir, env: credentialEnv(opts, "provider-dns") });
}

export async function ansibleStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleTool);
  if (opts["red/event"] === "delete" && !opts.ip) {
    // No compute in state: there is no host to stop, and the cleanup play
    // would only fail against the placeholder address.
    return { ...opts, "red/exit": 0 };
  }
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.json",
    playbooks: { create: "site.yml", delete: "cleanup.yml" },
    hostKeyChecking: false,
  }, ansibleSpecs(opts));
}

// ------------------------------------------------------------- acceptance

// Run `args` with `env` overlaid, returning the result map. Nothing from the
// child is echoed; callers decide what becomes an error message, so a secret
// passed through `env` can never leak into output by default.
async function runQuiet(args: string[], env: Record<string, string>, timeoutMs: number) {
  return runtime.exec(args, { env, timeoutMs });
}

// A psql invocation with an explicit everything: host, port, role, database,
// and `-w` so a missing password fails instead of prompting. `env -i` clears
// the environment and re-admits only PATH, the password handed over through
// the runner, and a dead PGPASSFILE — so no ambient PG* variable, service
// file, or ~/.pgpass can alter what the probe proves.
export function psqlArgs(opts: Opts, port: number, sql: string): string[] {
  const quoted = `'${sql.replaceAll("'", `'\\''`)}'`;
  return ["bash", "-c",
    'exec env -i PATH="$PATH" PGPASSFILE=/dev/null PGPASSWORD="$PGPASSWORD" psql' +
    ` 'postgresql://${opts["neon-role"]}@127.0.0.1:${port}/${opts["neon-database"]}?connect_timeout=10'` +
    ` -w -v ON_ERROR_STOP=1 -tAc ${quoted}`];
}

// An ssh tunnel through the generated `~/.ssh/config` alias — the supported
// client path, exercised end to end: the alias, the identity file, and the
// forward. `-f` returns once the forward is up; the remote `sleep` bounds its
// lifetime so nothing needs killing on the way out.
// The bash wrapper exists for the streams: the daemonized child inherits
// stdout/stderr, and a runner that waits for the pipes to close would
// otherwise block until the sleep expires — returning exactly when the
// tunnel dies.
export function tunnelArgs(opts: Opts, port: number): string[] {
  return ["bash", "-c",
    "ssh -f -o ExitOnForwardFailure=yes -o BatchMode=yes" +
    ` -L ${port}:127.0.0.1:55433 ` +
    `${sshConfig.hostAlias(opts)} sleep 45 >/dev/null 2>&1`];
}

// One deployment-scoped row, updated deterministically: the same statement on
// every converge, so a second create reconciles instead of accumulating.
export const smokeSql =
  "INSERT INTO colors_smoke (id, note, at) VALUES (1, 'operator-path', now())" +
  " ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note, at = EXCLUDED.at;" +
  " SELECT count(*) FROM colors_smoke;";

// The generated application-role password, read over SSH and held only in this
// process. Never merged into opts, never printed.
export async function readRemotePassword(opts: Opts): Promise<string | undefined> {
  const result = await runQuiet(["ssh", "-o", "BatchMode=yes", sshConfig.hostAlias(opts),
    "cat", "/etc/neon/secrets/neon_role_password"], {}, 20000);
  if (result.exit !== 0) return undefined;
  const password = String(result.out ?? "").trim();
  return password.length > 0 ? password : undefined;
}

// The operator-path gate, after a real create.
//
// The server-side gates already ran inside the playbook (health, the SQL
// round-trip, the auth negatives, the R2 object listings). What is checked
// from here is the one thing only this side can check: that an operator on
// this workstation reaches the database through the generated SSH config and
// a tunnel — the supported client path — with the generated password, and
// not without it.
export async function acceptanceStep(opts: Opts): Promise<Opts> {
  if (opts["red/event"] !== "create") return { ...opts, "red/exit": 0 };
  const password = await readRemotePassword(opts);
  if (!password) {
    return { ...opts, "red/exit": 1,
      "red/err": "acceptance: could not read the generated role password over ssh" };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    const tunnel = await runQuiet(tunnelArgs(opts, port), {}, 30000);
    if (tunnel.exit !== 0) continue;
    const ok = await runQuiet(psqlArgs(opts, port, smokeSql), { PGPASSWORD: password }, 30000);
    const denied = await runQuiet(psqlArgs(opts, port, "SELECT 1;"),
      { PGPASSWORD: "not-the-password" }, 30000);
    if (ok.exit !== 0) {
      return { ...opts, "red/exit": 1,
        "red/err": "acceptance: the tunnelled smoke round-trip failed: " +
          String(ok.err ?? "").trim() };
    }
    // psql prints the INSERT command tag before the count; the count is the
    // last line.
    const rows = String(ok.out ?? "").trim().split("\n").at(-1);
    if (rows !== "1") {
      return { ...opts, "red/exit": 1,
        "red/err": "acceptance: colors_smoke should hold exactly one row, got " +
          String(ok.out ?? "").trim() };
    }
    if (denied.exit === 0) {
      return { ...opts, "red/exit": 1,
        "red/err": "acceptance: a wrong password was accepted through the tunnel" };
    }
    return { ...opts, "red/exit": 0,
      "neon/acceptance": { tunnel: "ok", "smoke-rows": "1", "wrong-password": "refused" } };
  }
  return { ...opts, "red/exit": 1,
    "red/err": "acceptance: no local port could carry the ssh tunnel after three attempts" };
}
