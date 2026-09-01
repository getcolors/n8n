import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Opts } from "red/workflow";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");
const optoutFile = join(import.meta.dir, "../../test/fixtures/optout.yml");

function readFixture(path: string, overrides: Opts): Opts {
  const text = readFileSync(path, "utf8").replaceAll("WORKDIR", ".colors");
  return { ...(Bun.YAML.parse(text) as Opts), ...overrides };
}

const fixture = (overrides: Opts = {}) => readFixture(fixtureFile, overrides);
const optout = (overrides: Opts = {}) => readFixture(optoutFile, overrides);

// A minimal valid desired state. Kept complete on purpose: `stateErrors`
// reports every problem at once, so a fixture missing keys makes every test
// read as a pass-by-accident. The committed fixture is that complete state, so
// it is the base rather than a second hand-maintained copy of it.
const base = (overrides: Opts = {}) => fixture(overrides);

const errs = (overrides: Opts = {}) => validate.stateErrors(base(overrides));
const has = (overrides: Opts, needle: string) =>
  errs(overrides).some((error) => new RegExp(needle).test(error));

// --- desired state -----------------------------------------------------------

describe("validate", () => {
  test("a complete desired state validates", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
    expect(validate.stateErrors(optout())).toEqual([]);
  });

  test("reports every problem at once", () => {
    // Exit code 2 lists all problems; a validator that stops at the first
    // makes a fresh colors.yml a guessing game.
    expect(errs({ "neon-pg-version": 12, "n8n-port": null, "vultr-os-id": "x" }).length)
      .toBeGreaterThanOrEqual(3);
  });

  test("the machine key is not required, and its absence selects keygen", () => {
    // The standard makes absence meaningful: requiring vultr-ssh-keys would
    // make every conforming keygen deployment invalid.
    expect(errs().some((e) => e.includes("vultr-ssh-keys"))).toBe(false);
    expect(validate.keygen(fixture())).toBe(true);
    expect(validate.keygen(optout())).toBe(false);
  });

  // --- version-specific regressions -----------------------------------------

  test("rejects the deprecated webhook-url spelling", () => {
    // WEBHOOK_URL is a deprecated alias from n8n 2.35.0. Every secondary
    // source still names it, and so did the adversarial review.
    expect(has({ "webhook-url": "https://n8n.example.com/" }, ":webhook-url")).toBe(true);
  });

  test("rejects keys removed in n8n 2", () => {
    for (const key of ["n8n-config-files", "queue-worker-max-stalled-count",
                       "n8n-available-binary-data-modes"]) {
      expect(has({ [key]: "x" }, key)).toBe(true);
    }
  });

  test("rejects the deprecated runners-enabled flag", () => {
    expect(has({ "n8n-runners-enabled": true }, ":n8n-runners-enabled")).toBe(true);
  });

  test("runner image version must equal the n8n image version", () => {
    // Upstream requires it, and a mismatch fails when a Code node first
    // executes -- long after a converge reports success.
    expect(has({ "n8n-runners-image": "docker.io/n8nio/runners:2.35.0@sha256:99811ba57933dd77895f5fedbb555ce105bac8a82812205f6396d52a30b32e66" },
      "must equal")).toBe(true);
    expect(errs()).toEqual([]);
  });

  test("binary data must not be held in memory", () => {
    // n8n's own default is `default`, which keeps payloads in RAM on a host
    // that also runs a pageserver and a Postgres compute.
    expect(has({ "n8n-binary-data-mode": "default" }, "holds binary payloads in memory")).toBe(true);
  });

  test("concurrency must be bounded", () => {
    // n8n defaults to -1, unbounded.
    expect(has({ "n8n-concurrency-production-limit": -1 }, "positive integer")).toBe(true);
    expect(has({ "n8n-concurrency-production-limit": 0 }, "positive integer")).toBe(true);
  });

  test("security settings must be explicitly true", () => {
    // All three default to FALSE in n8n's reference, contradicting the 2.0
    // breaking-changes page.
    for (const key of ["n8n-block-env-access-in-node",
                       "n8n-enforce-settings-file-permissions",
                       "n8n-git-node-disable-bare-repos"]) {
      expect(has({ [key]: false }, key)).toBe(true);
    }
  });

  // --- the coupling that only fails later ------------------------------------

  test("cloudflare-only ingress requires a proxied record", () => {
    // Unproxied, the ACME HTTP-01 challenge arrives from Let's Encrypt's own
    // addresses and is dropped by the firewall -- the converge still succeeds
    // and the first HTTPS request finds no certificate.
    expect(has({ "cloudflare-proxied": false }, "ACME HTTP-01")).toBe(true);
    expect(errs({ "cloudflare-proxied": true })).toEqual([]);
    // An explicit range list is unaffected by the rule.
    expect(errs({ "vultr-http-sources": ["1.2.3.0/24"], "cloudflare-proxied": false }))
      .toEqual([]);
  });

  test("proxy hops must account for both proxies", () => {
    // Cloudflare, then Caddy. n8n's default of 0 trusts the nearest hop.
    expect(has({ "n8n-proxy-hops": 1 }, "at least 2")).toBe(true);
    expect(errs({ "n8n-proxy-hops": 3 })).toEqual([]);
  });

  // --- blast radius -----------------------------------------------------------

  test("live data must not share a bucket with tofu state", () => {
    expect(has({ "neon-r2-bucket": String(fixture()["r2-bucket"]) },
      "must not be the OpenTofu state bucket")).toBe(true);
  });

  test("backups must not share a bucket with state or live data", () => {
    expect(has({ "n8n-backup-r2-bucket": String(fixture()["r2-bucket"]) },
      "must not be the state or live-data bucket")).toBe(true);
    expect(has({ "n8n-backup-r2-bucket": String(fixture()["neon-r2-bucket"]) },
      "must not be the state or live-data bucket")).toBe(true);
  });

  // --- storage tier identity --------------------------------------------------

  test("tenant and timeline are fixed desired state", () => {
    for (const key of ["neon-tenant-id", "neon-timeline-id"]) {
      expect(has({ [key]: "not-hex" }, "32 lowercase hex")).toBe(true);
    }
  });

  test("the application role must not be cloud_admin", () => {
    expect(has({ "neon-role": "cloud_admin" }, "must not be cloud_admin")).toBe(true);
  });

  test("images must be digest pinned", () => {
    expect(has({ "n8n-image": "docker.io/n8nio/n8n:2.36.9" }, "pinned by digest")).toBe(true);
  });

  // --- soak thresholds --------------------------------------------------------

  test("soak mix must sum to one hundred", () => {
    expect(has({ "n8n-soak-mix-api-percent": 50 }, "must sum to 100")).toBe(true);
  });

  // --- credentials ------------------------------------------------------------

  test("the split R2 pair is preferred and the shared pair is the fallback", () => {
    const shared = validate.effectiveR2(base({ "r2-access-key-id": "a", "r2-secret-access-key": "b" }));
    const split = validate.effectiveR2(base({
      "r2-access-key-id": "a", "r2-secret-access-key": "b",
      "neon-r2-access-key-id": "c", "neon-r2-secret-access-key": "d",
    }));
    expect(shared.split).toBe(false);
    expect(shared.accessKeyId).toBe("a");
    expect(split.split).toBe(true);
    expect(split.accessKeyId).toBe("c");
  });

  test("sharing one R2 credential must be a deliberate choice", () => {
    // The package already refuses to let backups share a BUCKET with state or
    // live data; letting them silently share a CREDENTIAL was the same
    // property enforced on one axis and ignored on the other.
    const creds: Opts = {
      "vultr-api-key": "v", "cloudflare-api-token": "c",
      "r2-access-key-id": "a", "r2-secret-access-key": "b",
      "n8n-encryption-key": "k".repeat(32),
    };
    const secretErrs = (overrides: Opts = {}) =>
      validate.secretErrors(base({ ...creds, ...overrides }), "create");

    // The shared pair alone is refused.
    expect(secretErrs().some((e) => /same R2 credential as OpenTofu state and live/.test(e))).toBe(true);
    expect(secretErrs().some((e) => /live Neon data would use the same R2 credential/.test(e))).toBe(true);

    // Scoped pairs satisfy it with no opt-out.
    expect(secretErrs({
      "neon-r2-access-key-id": "c", "neon-r2-secret-access-key": "d",
      "n8n-backup-r2-access-key-id": "e", "n8n-backup-r2-secret-access-key": "f",
    }).filter((e) => /same R2 credential/.test(e))).toEqual([]);

    // The shared pair is reachable only as a recorded, committed choice.
    expect(secretErrs({ "r2-credential-sharing": "shared-accepted" })
      .filter((e) => /same R2 credential/.test(e))).toEqual([]);

    // And the opt-out itself is validated.
    expect(has({ "r2-credential-sharing": "yes-whatever" },
      "must be split or shared-accepted")).toBe(true);
    expect(errs({ "r2-credential-sharing": "split" })).toEqual([]);
  });

  test("the backup scoping gate is conditional", () => {
    // Making it mandatory would fail every converge on the shared credential,
    // which is the credential model actually in use.
    expect(validate.backupCredentialScoped(base())).toBe(false);
    expect(validate.backupCredentialScoped(base({
      "n8n-backup-r2-access-key-id": "a", "n8n-backup-r2-secret-access-key": "b",
    }))).toBe(true);
  });

  test("the encryption key must be long enough", () => {
    const creds: Opts = {
      "vultr-api-key": "v", "cloudflare-api-token": "c",
      "r2-access-key-id": "a", "r2-secret-access-key": "b",
    };
    expect(validate.secretErrors(base({ ...creds, "n8n-encryption-key": "short" }), "create")
      .some((e) => /at least 32 characters/.test(e))).toBe(true);
    expect(validate.secretErrors(base({ ...creds, "n8n-encryption-key": "a".repeat(32) }), "create")
      .filter((e) => /N8N_ENCRYPTION_KEY/.test(e))).toEqual([]);
  });

  test("profile may not be overlaid from the environment", () => {
    expect(validate.envErrors({ [validate.profilePar]: "somewhere-else" }).length).toBeGreaterThan(0);
    expect(validate.envErrors({})).toEqual([]);
  });
});

// --- rendering ---------------------------------------------------------------

describe("tools", () => {
  test("the neon bundle renders from the dependency, not a local copy", () => {
    // Every storage-tier template must be the installed `package-neon-red`'s
    // bytes. Name-checking alone would not catch a second copy, because one of
    // these — `cleanup.yml` — shares a basename with a file this package owns;
    // that collision is the whole reason the bundle renders into its own
    // directory, where relative `src:` names in the upstream play cannot
    // resolve to an n8n file.
    const dependency = join(
      dirname(Bun.resolveSync("package-neon-red", import.meta.dir)),
      "..", "resources", "tools", "ansible",
    );
    const specs = tools.neonSpecs("/tmp/stage", {});
    expect(specs.length).toBe(12);
    for (const spec of specs) {
      const template = spec.template as { name: string; content: string };
      expect(template.name.startsWith("neon/ansible/")).toBe(true);
      expect(spec.target).toContain("/neon/");
      const file = template.name.slice("neon/ansible/".length);
      expect(template.content).toBe(readFileSync(join(dependency, file), "utf8"));
    }
    // And the colliding name really does differ, so the check above is not
    // passing by accident.
    const local = join(import.meta.dir, "../resources/tools/ansible/cleanup.yml");
    expect(existsSync(local)).toBe(true);
    expect(readFileSync(local, "utf8"))
      .not.toBe(readFileSync(join(dependency, "cleanup.yml"), "utf8"));
  });

  test("the ansible-local stage is the dependency's too", () => {
    // Writing our own dropped its `<% if ssh-keygen %> private_key_file`
    // conditional, and the deployment then had no identity to offer.
    for (const spec of tools.ansibleLocalSpecs(fixture())) {
      expect((spec.template as { name: string }).name.startsWith("neon/ansible-local/")).toBe(true);
    }
    expect(existsSync(join(import.meta.dir, "../resources/tools/ansible-local"))).toBe(false);
  });

  test("the inventory places one host in both groups", () => {
    // The imported neon play targets `neon`, this package's targets `n8n`, and
    // both converge the same machine.
    const inv = JSON.parse(tools.inventory({ profile: "p", ip: "10.0.0.1" }));
    expect(Object.keys(inv.all.children).sort()).toEqual(["n8n", "neon"]);
    expect(inv.all.children.neon.hosts).toHaveProperty("p");
    expect(inv.all.children.n8n.hosts).toHaveProperty("p");
    // Variables are HOST vars, never group vars -- group_vars precedence
    // between two groups on one host would be a live hazard.
    expect(inv.all.hosts.p.ansible_host).toBe("10.0.0.1");
    expect(inv.all.children.neon.vars).toBeUndefined();
    expect(inv.all.children.n8n.vars).toBeUndefined();
  });

  test("http sources resolve explicit lists verbatim", async () => {
    const resolved = await tools.httpSources({ "vultr-http-sources": ["1.2.3.0/24", "::/0"] });
    expect(resolved.source).toBe("explicit");
    expect(resolved.ranges).toEqual(["1.2.3.0/24", "::/0"]);
  });

  test("the cloudflare fallback is never permissive", () => {
    // A failed range fetch must not widen to 0.0.0.0/0.
    expect(tools.cloudflareRangesFallback).not.toContain("0.0.0.0/0");
    expect(tools.cloudflareRangesFallback).not.toContain("::/0");
    expect(tools.cloudflareRangesFallback.length).toBeGreaterThan(10);
  });

  test("the range checksum is order independent", () => {
    // The recorded checksum identifies the SET, so a provider reordering its
    // published list is not a firewall change.
    expect(tools.rangesChecksum(["a", "b"])).toBe(tools.rangesChecksum(["b", "a"]));
    expect(tools.rangesChecksum(["a", "b"])).not.toBe(tools.rangesChecksum(["a", "c"]));
  });

  test("the dns record is proxied with an automatic ttl", () => {
    // Cloudflare rejects an explicit TTL on a proxied record, and the zone
    // data source is named `zone` with attribute `id` -- both were wrong on
    // the first live converge and only failed at apply time.
    const doc = JSON.parse(tools.dnsJson({
      "n8n-host": "n8n.example.com", ip: "203.0.113.5", "cloudflare-proxied": true,
    }));
    const body = doc.resource.cloudflare_dns_record.n8n;
    expect(body.zone_id).toBe("${data.cloudflare_zone.zone.id}");
    expect(body.name).toBe("n8n.example.com");
    expect(body.ttl).toBe(1);
    expect(body.proxied).toBe(true);
  });
});

// --- the graph ---------------------------------------------------------------

describe("workflow", () => {
  test("create renders DNS before the converge and delete removes it before the destroy", () => {
    // Caddy's ACME HTTP-01 challenge needs the name to resolve already, and a
    // record outliving its host is a live outage rather than a 404.
    const createGraph = (step: string) => workflow.wireFn(step, { "red/event": "create" });
    expect(createGraph("n8n/infrastructure")?.[1]).toBe("n8n/dns");
    expect(createGraph("n8n/dns")?.[1]).toBe("n8n/ssh-config");
    const deleteGraph = (step: string) => workflow.wireFn(step, { "red/event": "delete" });
    expect(deleteGraph("n8n/ssh-config")?.[1]).toBe("n8n/dns");
    expect(deleteGraph("n8n/dns")?.[1]).toBe("n8n/infrastructure");
    // The keypair goes after the compute destroy, the config block before it.
    expect(deleteGraph("n8n/infrastructure")?.[1]).toBe("n8n/ssh-cleanup");
  });

  test("both tofu stages carry their own backend key", () => {
    const opts = { profile: "n8n-fixture" };
    expect(workflow.backendAdvice(tools.dnsTool)).toBeDefined();
    expect(tools.toolDir({ ...opts, workdir: ".colors" }, tools.dnsTool))
      .toContain("n8n-fixture/n8n-dns");
  });
});
