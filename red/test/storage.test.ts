// The managed S3 storage stage: what it requires, what it hands the converge,
// and what it refuses to adopt.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ansible from "red/ansible";
import { runtime } from "red/runtime";
import * as tofu from "red/tofu";
import type { Opts } from "red/workflow";
import * as storage from "../src/storage.ts";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";

function readFixture(name: string, overrides: Opts): Opts {
  const text = readFileSync(join(import.meta.dir, "../../test/fixtures", name), "utf8").replaceAll("WORKDIR", "/tmp/unused-storage-test");
  return { ...(Bun.YAML.parse(text) as Opts), ...overrides };
}
const base = (overrides: Opts = {}) => readFixture("colors.yml", overrides);
// The committed AWS fixture manages its storage; `aws` is the same state
// without the flag, as green's test map is.
const managed = (overrides: Opts = {}) => readFixture("aws.yml", overrides);
const aws = (overrides: Opts = {}) => { const { "n8n-storage-managed": _m, ...rest } = managed(); return { ...rest, ...overrides }; };

const credentials = {
  credentials: Object.fromEntries(["neon", "backup"].map((role) =>
    [role, { access_key_id: `${role}-id`, secret_access_key: `${role}-secret` }])),
};

let mocked: ReturnType<typeof spyOn> | undefined;
afterEach(() => { mocked?.mockRestore(); mocked = undefined; });

describe("storage", () => {
  test("managed storage requires aws compute and s3 state", () => {
    expect(validate.stateErrors(managed())).toEqual([]);
    // The message names the requirement, so a Vultr deployment that flips the
    // flag learns what the flag means.
    expect(validate.stateErrors(base({ "n8n-storage-managed": true })))
      .toContain("managed storage requires :provider-compute aws");
    expect(validate.stateErrors(base({ "n8n-storage-managed": true })))
      .toContain("managed storage requires :provider-backend s3");
    for (const change of [
      { "n8n-storage-managed": "true" },
      { "neon-r2-region": "auto" },
      { "n8n-backup-r2-region": "eu-west-1" },
      { "neon-r2-bucket": "Not_A_Bucket" },
      { "n8n-backup-r2-bucket": aws()["neon-r2-bucket"] },
      { "s3-bucket": aws()["neon-r2-bucket"] },
    ] as Opts[]) {
      expect(validate.stateErrors(managed(change)).length, JSON.stringify(change)).toBeGreaterThan(0);
    }
  });

  test("managed storage exempts the operator pairs and the sharing gate", () => {
    // The pairs are minted and scoped by construction, so neither the
    // COLORS_PAR_NEON_R2_* requirement nor the blast-radius gate applies.
    expect(new Set(validate.secretErrors(managed(), "create"))).toEqual(new Set([
      "required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN",
      "required credential is not set: COLORS_PAR_N8N_ENCRYPTION_KEY",
    ]));
    expect(validate.secretErrors(managed({ "cloudflare-api-token": "c", "n8n-encryption-key": "k".repeat(32) }), "create")).toEqual([]);
    // Unmanaged AWS desired state still asks for the pairs.
    expect(validate.secretErrors(aws(), "create").some((e) => /COLORS_PAR_NEON_R2_ACCESS_KEY_ID/.test(e))).toBe(true);
    expect(validate.secretErrors(aws({
      "cloudflare-api-token": "c", "n8n-encryption-key": "k".repeat(32),
      "r2-access-key-id": "a", "r2-secret-access-key": "b",
    }), "create").some((e) => /same R2 credential/.test(e))).toBe(true);
  });

  test("the storage step is a no-op when unmanaged", async () => {
    mocked = spyOn(runtime, "exec").mockImplementation(async () => { throw new Error("unmanaged storage must not provision"); });
    expect((await storage.storageStep(base({ "red/event": "create" })))["red/exit"]).toBe(0);
    expect((await storage.storageStep(aws({ "red/event": "delete" })))["red/exit"]).toBe(0);
    expect(mocked).toHaveBeenCalledTimes(0);
  });

  test("minted pairs reach the existing lookups and nothing else", () => {
    const env = storage.credentialEnv(managed({ "n8n/storage-credentials": credentials }));
    expect(env.COLORS_PAR_NEON_R2_ACCESS_KEY_ID).toBe("neon-id");
    expect(env.COLORS_PAR_NEON_R2_SECRET_ACCESS_KEY).toBe("neon-secret");
    expect(env.COLORS_PAR_N8N_BACKUP_R2_ACCESS_KEY_ID).toBe("backup-id");
    expect(env.COLORS_PAR_N8N_BACKUP_R2_SECRET_ACCESS_KEY).toBe("backup-secret");
    expect(env.ANSIBLE_HOST_KEY_CHECKING).toBe("False");
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    // An absent pair is a refusal, never an empty variable.
    expect(() => storage.credentialEnv(managed())).toThrow("unavailable");
  });

  test("sensitive tofu JSON decodes into two scoped Ansible credential pairs", async () => {
    // The shape `tofu output -json` hands back, as the step records it.
    mocked = spyOn(runtime, "exec").mockResolvedValue({ exit: 0, out: JSON.stringify({ credentials: { sensitive: true, type: ["object", {}], value: credentials.credentials } }), err: "" });
    const decoded = await tofu.outputs("/unused");
    const env = storage.credentialEnv(managed({ "n8n/storage-credentials": decoded }));
    expect(env.COLORS_PAR_NEON_R2_ACCESS_KEY_ID).toBe("neon-id");
    expect(env.COLORS_PAR_N8N_BACKUP_R2_SECRET_ACCESS_KEY).toBe("backup-secret");
    expect(mocked.mock.calls[0]![0]).toEqual(["tofu", "output", "-json"]);
  });

  test("ownership rejects existing buckets and unreadable state", async () => {
    for (const probe of [{ exit: 0, out: "", err: "" }, { exit: 1, out: "", err: "(403) Forbidden" }]) {
      mocked = spyOn(runtime, "exec").mockImplementation(async (args) => args[0] === "aws" ? probe : { exit: 0, out: "", err: "" });
      await expect(storage.ownershipPreflight(managed())).rejects.toThrow("refuses to adopt");
      mocked.mockRestore();
    }
    mocked = spyOn(runtime, "exec").mockImplementation(async (args) =>
      args.join(" ") === "tofu state list" ? { exit: 1, out: "", err: "AccessDenied" } : { exit: 0, out: "", err: "" });
    await expect(storage.ownershipPreflight(managed())).rejects.toThrow("state unavailable");
  });

  test("a first create probes both buckets and passes on 404", async () => {
    const probes: string[] = [];
    mocked = spyOn(runtime, "exec").mockImplementation(async (args) => {
      if (args.join(" ") === "tofu state list") return { exit: 1, out: "", err: "No state file was found!" };
      if (args[0] === "aws") { probes.push(args[4]!); return { exit: 254, out: "", err: "(404) Not Found" }; }
      return { exit: 0, out: "", err: "" };
    });
    await storage.ownershipPreflight(managed());
    expect(new Set(probes)).toEqual(new Set([aws()["neon-r2-bucket"], aws()["n8n-backup-r2-bucket"]] as string[]));
  });

  test("a tracked address must name the configured bucket", async () => {
    mocked = spyOn(runtime, "exec").mockImplementation(async (args) => {
      if (args.join(" ") === "tofu state list") return { exit: 0, out: 'aws_s3_bucket.application["neon"]', err: "" };
      if (args.join(" ") === "tofu show -json") return { exit: 0, out: JSON.stringify({ values: { root_module: { resources: [{ address: 'aws_s3_bucket.application["neon"]', values: { bucket: "someone-elses-bucket" } }] } } }), err: "" };
      return { exit: 0, out: "", err: "" };
    });
    await expect(storage.ownershipPreflight(managed())).rejects.toThrow("refuses to adopt");
  });

  test("a managed create converges with the minted pairs in the subprocess environment only", async () => {
    // `red/ansible` has no environment hook, so the managed converge runs the
    // command directly with the same arguments it would build.
    const specs = spyOn(tools, "ansibleSpecs").mockReturnValue([]);
    const generic = spyOn(ansible, "ansibleWithSpec").mockImplementation(async (opts) => ({ ...opts, "red/exit": 0 }));
    mocked = spyOn(runtime, "exec").mockResolvedValue({ exit: 0, out: "PLAY RECAP\n", err: "" });
    try {
      const result = await tools.ansibleStep(managed({ "red/event": "create", ip: "203.0.113.19", "ssh-private-key-path": "/tmp/key", "n8n/storage-credentials": credentials }));
      expect(result["red/exit"]).toBe(0);
      expect(generic).toHaveBeenCalledTimes(0);
      const [args, options] = mocked.mock.calls[0]! as [string[], { env: Record<string, string> }];
      expect(args).toEqual(["ansible-playbook", "-i", "inventory.json", "--private-key", "/tmp/key", "site.yml"]);
      expect(options.env.COLORS_PAR_N8N_BACKUP_R2_ACCESS_KEY_ID).toBe("backup-id");
      // The rendered data never carries the pairs.
      expect(result["n8n/storage-credentials"]).toBeDefined();
      expect(tools.ansibleData(result)["n8n/storage-credentials"]).toBeUndefined();
    } finally { specs.mockRestore(); generic.mockRestore(); }
  });
});
