import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import { providers } from "package-once-red";
import { onceSsh } from "./once.ts";

export const profilePar = parName("profile");

// Every key desired state must carry.
//
// Two deliberate absences carried over from `neon`: `vultr-ssh-keys` selects
// opt-out mode by being present (SSH Keypair Standard), so requiring it would
// make every conforming keygen deployment invalid, and `vultr-name` is the
// Compute Name Standard's optional override.
//
// Unlike `neon`, this package DOES require `provider-dns`. Neon publishes
// nothing and is reached through an SSH tunnel; n8n is a public application
// whose whole purpose is receiving webhooks from third parties, so a name and a
// certificate are not optional extras here.
export const required = [
  "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
  "compute-prevent-destroy",
  // storage tier — neon's own vocabulary, because this package renders
  // neon's templates rather than copying them (see neon.ts)
  "neon-image", "neon-compute-image", "neon-pg-version",
  "neon-tenant-id", "neon-timeline-id",
  "neon-database", "neon-role",
  "neon-r2-bucket", "neon-r2-endpoint", "neon-r2-region", "neon-r2-prefix",
  // application tier
  "n8n-image", "n8n-runners-image", "n8n-host", "n8n-port",
  "n8n-owner-email", "n8n-proxy-hops", "n8n-timezone", "n8n-data-dir",
  "n8n-binary-data-mode", "n8n-concurrency-production-limit",
  "n8n-executions-data-max-age", "n8n-executions-data-prune-max-count",
  "n8n-block-env-access-in-node", "n8n-enforce-settings-file-permissions",
  "n8n-git-node-disable-bare-repos", "n8n-restrict-file-access-to",
  "caddy-image",
  // backups — the only whole-host recovery source
  "n8n-backup-r2-bucket", "n8n-backup-oncalendar", "n8n-backup-retention-days",
  "n8n-backup-dir",
  // public name and TLS
  "cloudflare-zone", "cloudflare-record-name", "cloudflare-proxied",
  // compute
  "vultr-region", "vultr-plan", "vultr-os-id",
  "vultr-ssh-sources", "vultr-http-sources",
  "r2-bucket", "r2-endpoint",
];

export const imageKeys = [
  "neon-image", "neon-compute-image", "n8n-image", "n8n-runners-image",
  "caddy-image",
];

export const soakKeys = [
  "n8n-soak-concurrent-workflows", "n8n-soak-duration-seconds",
  "n8n-soak-mix-api-percent", "n8n-soak-mix-code-node-percent",
  "n8n-soak-mix-binary-percent",
  "n8n-soak-code-node-payload-mb", "n8n-soak-binary-payload-mb",
  "n8n-soak-max-p95-sql-roundtrip-ms", "n8n-soak-max-p99-sql-roundtrip-ms",
  "n8n-soak-max-p95-execution-ms", "n8n-soak-max-p99-execution-ms",
  "n8n-soak-min-executions-completed",
  "n8n-soak-max-host-memory-percent", "n8n-soak-max-disk-percent",
];

const imageRe = /^[^\s:@]+(?:\/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64}|:[^\s:@]+@sha256:[0-9a-f]{64})$/;
const hex32Re = /^[0-9a-f]{32}$/;
const identRe = /^[a-z_][a-z0-9_]*$/;
const urlRe = /^https:\/\/[^\s]+$/;
const hostRe = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const versionTagRe = /:([^\s:@/]+)@sha256:/;

// Clojure's `str`: nil renders empty, booleans lowercase, a vector as its
// literal. Green compares stringified values in several rules, and a bare
// JavaScript `String()` disagrees with it on exactly the inputs those rules
// exist to catch — `String(["cloudflare"])` is `cloudflare`, which would make a
// one-element list of ranges read as the symbolic source.
export function s(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export function missing(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "");
}

export function placeholder(value: unknown): boolean {
  return missing(value) || s(value).trim() === "REPLACE_ME";
}

// What this deployment calls its machine. The one function that answers it —
// every label, including the firewall's, derives from this and never from the
// raw override key or a second copy of the profile (Compute Name Standard §3).
export function computeName(opts: Opts): string {
  const override = opts["vultr-name"];
  return placeholder(override) ? s(opts.profile) : s(override).trim();
}

// Whether this deployment owns its machine keypair. Delegates to ONCE, the
// standard's reference implementation, so one rule decides it everywhere.
export function keygen(opts: Opts): boolean {
  return onceSsh.keygen(opts);
}

// The human-readable tag out of a `repo:tag@sha256:...` pin, or undefined.
export function imageVersion(value: unknown): string | undefined {
  return versionTagRe.exec(s(value))?.[1];
}

export interface EffectiveR2 {
  split: boolean;
  accessKeyId: unknown;
  secretAccessKey: unknown;
}

// Which credential pair reaches the host for Neon remote storage.
//
// A split `COLORS_PAR_NEON_R2_*` pair is preferred; when it is absent the
// shared `COLORS_PAR_R2_*` pair is used instead. That fallback is what the
// deployment currently runs on, and it is the reason the backup-credential
// scoping gate reports SKIPPED rather than passing — one credential reaching
// state, live data and backups alike is a real weakness, so it is named here
// rather than hidden behind a default.
export function effectiveR2(opts: Opts): EffectiveR2 {
  if (!missing(opts["neon-r2-access-key-id"]) &&
      !missing(opts["neon-r2-secret-access-key"])) {
    return {
      split: true,
      accessKeyId: opts["neon-r2-access-key-id"],
      secretAccessKey: opts["neon-r2-secret-access-key"],
    };
  }
  return {
    split: false,
    accessKeyId: opts["r2-access-key-id"],
    secretAccessKey: opts["r2-secret-access-key"],
  };
}

// Whether a backup-only credential was supplied. Gate R2 is conditional on
// this and reports its reason when false.
export function backupCredentialScoped(opts: Opts): boolean {
  return !missing(opts["n8n-backup-r2-access-key-id"]) &&
    !missing(opts["n8n-backup-r2-secret-access-key"]);
}

// Whether desired state explicitly accepts one R2 credential reaching
// OpenTofu state, live Neon data, and backups alike.
export function credentialSharingAccepted(opts: Opts): boolean {
  return s(opts["r2-credential-sharing"]) === "shared-accepted";
}

export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "").length
    ? [`${profilePar} is set; profile must come from colors.yml only`]
    : [];
}

function intLike(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value);
  return typeof value === "string" && /^-?\d+$/.test(value);
}

function asInt(value: unknown): number | undefined {
  if (!intLike(value)) return undefined;
  return typeof value === "number" ? value : Number.parseInt(value as string, 10);
}

export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of required) {
    if (missing(opts[key])) errors.push(`:${key} is required`);
  }
  for (const key of soakKeys) {
    if (missing(opts[key])) errors.push(`:${key} is required`);
  }

  if (opts["provider-compute"] !== "vultr") {
    errors.push(":provider-compute must be vultr");
  }
  if (opts["provider-dns"] !== "cloudflare") {
    errors.push(":provider-dns must be cloudflare");
  }
  if (!["local", "s3", "r2"].includes(String(opts["provider-backend"]))) {
    errors.push(":provider-backend must be local, s3, or r2");
  }
  if (typeof opts["compute-prevent-destroy"] !== "boolean") {
    errors.push(":compute-prevent-destroy must be true or false");
  }

  // --- images --------------------------------------------------------------
  for (const key of imageKeys) {
    const value = opts[key];
    if (!missing(value) && !imageRe.test(s(value))) {
      errors.push(`:${key} must carry an explicit image tag or digest`);
    }
  }
  for (const key of imageKeys) {
    if (!missing(opts[key]) && !s(opts[key]).includes("@sha256:")) {
      errors.push(`:${key} must be pinned by digest (tag@sha256:...)`);
    }
  }

  // Upstream requires the task runner image version to equal the n8n image
  // version. A mismatch is a protocol mismatch between the broker and the
  // runner, and it fails at workflow-execution time rather than at boot —
  // long after a converge would have reported success.
  const n8nVersion = imageVersion(opts["n8n-image"]);
  const runnerVersion = imageVersion(opts["n8n-runners-image"]);
  if (n8nVersion && runnerVersion && n8nVersion !== runnerVersion) {
    errors.push(`:n8n-runners-image version ${runnerVersion} must equal :n8n-image version ${n8nVersion}`);
  }

  // --- storage tier ---------------------------------------------------------
  const pgVersion = opts["neon-pg-version"];
  if (!(missing(pgVersion) ||
        (typeof pgVersion === "number" && [14, 15, 16, 17].includes(pgVersion)))) {
    errors.push(":neon-pg-version must be 14, 15, 16, or 17");
  }
  for (const key of ["neon-tenant-id", "neon-timeline-id"]) {
    const value = opts[key];
    if (!missing(value) && !hex32Re.test(s(value))) {
      errors.push(`:${key} must be 32 lowercase hex characters`);
    }
  }
  for (const key of ["neon-database", "neon-role"]) {
    const value = opts[key];
    if (!missing(value) && !identRe.test(s(value))) {
      errors.push(`:${key} must be a lowercase identifier`);
    }
  }
  if (s(opts["neon-role"]) === "cloud_admin") {
    errors.push(":neon-role must not be cloud_admin");
  }
  if (!missing(opts["neon-r2-endpoint"]) && !urlRe.test(s(opts["neon-r2-endpoint"]))) {
    errors.push(":neon-r2-endpoint must be an https URL");
  }
  // Live Neon data and OpenTofu state must not share a bucket. neon-vultr put
  // data inside the state bucket as a bootstrap deviation; repeating it here
  // would mean one lifecycle mistake could take out both.
  if (!missing(opts["neon-r2-bucket"]) &&
      s(opts["neon-r2-bucket"]) === s(opts["r2-bucket"])) {
    errors.push(":neon-r2-bucket must not be the OpenTofu state bucket");
  }
  if (!missing(opts["n8n-backup-r2-bucket"]) &&
      new Set([s(opts["r2-bucket"]), s(opts["neon-r2-bucket"])])
        .has(s(opts["n8n-backup-r2-bucket"]))) {
    errors.push(":n8n-backup-r2-bucket must not be the state or live-data bucket");
  }

  // --- application tier -----------------------------------------------------
  if (!(missing(opts["n8n-host"]) || hostRe.test(s(opts["n8n-host"])))) {
    errors.push(":n8n-host must be a fully qualified hostname");
  }
  if (!(missing(opts["n8n-owner-email"]) || emailRe.test(s(opts["n8n-owner-email"])))) {
    errors.push(":n8n-owner-email must be an email address");
  }
  if (!(missing(opts["n8n-port"]) || intLike(opts["n8n-port"]))) {
    errors.push(":n8n-port must be a port number");
  }

  // Two proxies sit in front of n8n here (Cloudflare, then Caddy). n8n's
  // default is 0, which makes it trust the nearest hop and mis-attribute every
  // client address.
  const hops = asInt(opts["n8n-proxy-hops"]);
  if (!(missing(opts["n8n-proxy-hops"]) ||
        (hops !== undefined && hops >= 0 && hops <= 10))) {
    errors.push(":n8n-proxy-hops must be an integer between 0 and 10");
  }
  if (opts["cloudflare-proxied"] === true && hops !== undefined && hops < 2) {
    errors.push(":n8n-proxy-hops must be at least 2 when cloudflare-proxied is true (Cloudflare, then Caddy)");
  }

  // n8n's own default holds binary payloads in memory, and a Code node
  // duplicates its payload twice. `filesystem` is the only safe value on a
  // single host that also runs the database.
  if (!(missing(opts["n8n-binary-data-mode"]) ||
        ["filesystem", "default"].includes(s(opts["n8n-binary-data-mode"])))) {
    errors.push(":n8n-binary-data-mode must be filesystem or default");
  }
  if (s(opts["n8n-binary-data-mode"]) === "default") {
    errors.push(":n8n-binary-data-mode must be filesystem here: `default` holds binary payloads in memory and this host also runs the database");
  }

  // n8n defaults this to -1, i.e. unbounded concurrent production executions.
  // Peak memory is roughly 3x the largest payload times this number.
  const concurrency = asInt(opts["n8n-concurrency-production-limit"]);
  if (!(missing(opts["n8n-concurrency-production-limit"]) ||
        (concurrency !== undefined && concurrency > 0))) {
    errors.push(":n8n-concurrency-production-limit must be a positive integer (n8n's -1 default is unbounded and will OOM this host)");
  }

  const maxAge = asInt(opts["n8n-executions-data-max-age"]);
  if (!(missing(opts["n8n-executions-data-max-age"]) ||
        (maxAge !== undefined && maxAge > 0))) {
    errors.push(":n8n-executions-data-max-age must be a positive number of HOURS");
  }
  const pruneMax = asInt(opts["n8n-executions-data-prune-max-count"]);
  if (!(missing(opts["n8n-executions-data-prune-max-count"]) ||
        (pruneMax !== undefined && pruneMax >= 0))) {
    errors.push(":n8n-executions-data-prune-max-count must be zero or a positive integer");
  }

  // These three default to false upstream, contradicting the 2.0
  // breaking-changes page. Desired state must say so explicitly, and must not
  // be allowed to say `false` quietly.
  for (const key of ["n8n-block-env-access-in-node",
                     "n8n-enforce-settings-file-permissions",
                     "n8n-git-node-disable-bare-repos"]) {
    const value = opts[key];
    if (!missing(value) && value !== true) errors.push(`:${key} must be true`);
  }

  // --- deprecated spellings -------------------------------------------------
  // WEBHOOK_URL is a deprecated alias of N8N_WEBHOOK_URL from n8n 2.35.0.
  // Every secondary source still names the old one, so refuse it by name rather
  // than letting it render into a deprecation warning nobody reads.
  if (!missing(opts["webhook-url"])) {
    errors.push(":webhook-url is the deprecated spelling; n8n 2.35.0+ uses :n8n-webhook-url (derived from :n8n-host here, so remove the key)");
  }
  if (!missing(opts["n8n-runners-enabled"])) {
    errors.push(":n8n-runners-enabled is deprecated from n8n 2.0; remove the key");
  }
  for (const key of ["n8n-config-files", "queue-worker-max-stalled-count",
                     "n8n-available-binary-data-modes"]) {
    if (!missing(opts[key])) errors.push(`:${key} was removed in n8n 2.0; remove the key`);
  }
  // n8n 2.0 dropped MySQL and MariaDB. There is no key that could select them
  // here, but a stale colors.yml carrying one should say why.
  if (["mysql", "mariadb", "mysqldb"].includes(s(opts["db-type"]).toLowerCase())) {
    errors.push(":db-type mysql/mariadb support was removed in n8n 2.0");
  }

  // --- soak thresholds ------------------------------------------------------
  const percentages = ["n8n-soak-mix-api-percent", "n8n-soak-mix-code-node-percent",
                       "n8n-soak-mix-binary-percent"]
    .map((key) => asInt(opts[key]))
    .filter((n): n is number => n !== undefined);
  if (percentages.length === 3 &&
      percentages.reduce((a, b) => a + b, 0) !== 100) {
    errors.push(":n8n-soak-mix-* percentages must sum to 100");
  }
  for (const key of ["n8n-soak-max-host-memory-percent", "n8n-soak-max-disk-percent"]) {
    const n = asInt(opts[key]);
    if (n !== undefined && !(n >= 1 && n <= 100)) {
      errors.push(`:${key} must be a percentage between 1 and 100`);
    }
  }

  // Restricting the origin to Cloudflare's ranges and NOT proxying the record
  // are mutually exclusive, and the failure is silent until the certificate is
  // needed: Caddy answers the ACME HTTP-01 challenge on :80, and with the
  // record unproxied that challenge arrives from Let's Encrypt's own addresses,
  // which the firewall drops. The converge then succeeds, and the first HTTPS
  // request fails on a certificate that was never issued. Proxied, the
  // challenge arrives from a Cloudflare address and is admitted.
  if (s(opts["vultr-http-sources"]) === "cloudflare" &&
      opts["cloudflare-proxied"] !== true) {
    errors.push(":vultr-http-sources cloudflare requires :cloudflare-proxied true, or ACME HTTP-01 is firewalled off and no certificate is ever issued");
  }

  if (!(missing(opts["r2-credential-sharing"]) ||
        ["split", "shared-accepted"].includes(s(opts["r2-credential-sharing"])))) {
    errors.push(":r2-credential-sharing must be split or shared-accepted");
  }

  const osId = opts["vultr-os-id"];
  if (!(missing(osId) || (typeof osId === "number" && Number.isInteger(osId)))) {
    errors.push(":vultr-os-id must be Vultr's numeric operating-system id");
  }
  return errors;
}

export function backendSecrets(opts: Opts): string[] {
  return providers["provider-backend"]?.[String(opts["provider-backend"])]?.secrets ?? [];
}

// What talking to the providers needs, on any real event.
export const providerSecrets = ["vultr-api-key", "cloudflare-api-token"];

// What converging the machine needs, and therefore only a create.
//
// The database role passwords, the n8n owner password and the task-runner auth
// token are deliberately absent: all three are generated on the server, once,
// and are never supplied by the operator. The encryption key is the opposite —
// it must outlive the host, so it is the operator's to hold and escrow.
export const applicationSecrets = ["n8n-encryption-key"];

// The Neon remote-storage pair, honouring the split/shared fallback.
export function r2SecretErrors(opts: Opts): string[] {
  const { accessKeyId, secretAccessKey, split } = effectiveR2(opts);
  if (missing(accessKeyId) && missing(secretAccessKey)) {
    return [`required credential is not set: ${parName("neon-r2-access-key-id")}` +
      ` (or the shared ${parName("r2-access-key-id")} pair)`];
  }
  if (missing(accessKeyId)) {
    return [`required credential is not set: ${parName(split ? "neon-r2-access-key-id" : "r2-access-key-id")}`];
  }
  if (missing(secretAccessKey)) {
    return [`required credential is not set: ${parName(split ? "neon-r2-secret-access-key" : "r2-secret-access-key")}`];
  }
  return [];
}

// Credentials a real event needs. A delete tears down infrastructure and never
// converges anything, so it asks for the provider credentials only.
export function secretErrors(opts: Opts, event: string): string[] {
  const keys = [...new Set([
    ...providerSecrets,
    ...(event === "create" ? applicationSecrets : []),
    ...backendSecrets(opts),
  ])];
  const errors = keys.filter((key) => missing(opts[key]))
    .map((key) => `required credential is not set: ${parName(key)}`);
  if (event !== "create") return errors;
  errors.push(...r2SecretErrors(opts));

  // Blast radius, enforced rather than merely observed.
  //
  // This package already refuses to let backups share a BUCKET with state or
  // live data. Letting them silently share a CREDENTIAL was the same property
  // enforced on one axis and ignored on the other -- which is worse than
  // enforcing neither, because the visible rule implies the invisible one is
  // handled too.
  //
  // Measured on a live host: the shared pair could list, write and DELETE in
  // the OpenTofu state bucket and delete backup sets. A backup a compromised
  // host can erase is not a backup, and the host has no legitimate reason to
  // touch state at all.
  //
  // The shared pair stays reachable, because a first converge may predate the
  // scoped tokens -- but only as a DELIBERATE, committed choice that shows up
  // in a colors.yml diff, never as a silent default.
  if (!backupCredentialScoped(opts) && !credentialSharingAccepted(opts)) {
    errors.push("backups would use the same R2 credential as OpenTofu state and live " +
      `Neon data. Supply ${parName("n8n-backup-r2-access-key-id")}` +
      ` and ${parName("n8n-backup-r2-secret-access-key")}` +
      " scoped to the backup bucket alone, or set " +
      ":r2-credential-sharing: shared-accepted in colors.yml to record " +
      "that the blast radius is accepted");
  }
  if (!effectiveR2(opts).split && !credentialSharingAccepted(opts)) {
    errors.push("live Neon data would use the same R2 credential as OpenTofu state. " +
      `Supply ${parName("neon-r2-access-key-id")} and ` +
      `${parName("neon-r2-secret-access-key")}` +
      " scoped to the data bucket alone, or set " +
      ":r2-credential-sharing: shared-accepted in colors.yml");
  }
  // n8n requires at least 32 characters. A shorter key is accepted by n8n
  // itself and then silently weakens every credential in the database.
  if (!missing(opts["n8n-encryption-key"]) && s(opts["n8n-encryption-key"]).length < 32) {
    errors.push(`${parName("n8n-encryption-key")} must be at least 32 characters`);
  }
  return errors;
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  switch (slot) {
    case "provider-compute":
      return { "vultr-api-key": "VULTR_API_KEY" };
    case "provider-dns":
      return { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" };
    case "provider-backend":
      return providers["provider-backend"]?.[String(opts["provider-backend"])]?.tofuEnv ?? {};
    default:
      return {};
  }
}
