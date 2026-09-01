import { readPars, parName } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": "vultr", "provider-dns": "cloudflare",
  "provider-backend": "local", "compute-prevent-destroy": true,
  workdir: ".colors",
};

// The compute stage's applied `params`, or undefined when no state is
// readable. The create matrix keys on this best-effort read: an unreadable
// state (a fresh clone, a missing backend) counts as absent.
export async function stateOutput(opts: Opts): Promise<Record<string, unknown> | undefined> {
  try {
    const outputs = await tofu.outputs(
      tools.toolDir(opts, tools.infrastructureTool),
      tools.backendCredentialEnv(opts),
    );
    const params = outputs.params;
    return params && typeof params === "object" ? params as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

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
    // The machine key's create matrix and the Vultr preflight run before any
    // template is rendered: an unowned key on disk or at the provider stops
    // the run while stopping is still free. Delete fills the same template
    // values — a destroy renders before it destroys — but checks nothing,
    // because its key cleanup runs after the compute destroy.
    afterValidate: async (current, _environment, { event, real }) => {
      if (real && event === "delete") {
        return {
          ...ssh.withMachineKey(current),
          ...(await stateOutput(current) ?? {}),
          "red/exit": 0,
        };
      }
      if (real && event === "create") {
        let next = await ssh.ensureKey(current, stateOutput);
        if (failed(next)) return next;
        next = await ssh.preflight(ssh.withMachineKey(next));
        if (!failed(next)) next = sshConfig.preflight(next);
        return failed(next) ? next : { ...next, "red/exit": 0 };
      }
      return { ...ssh.withMachineKey(current), "red/exit": 0 };
    },
  }, env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "n8n/start": [startStep, "n8n/ansible"],
      "n8n/ansible": [tools.ansibleStep, "n8n/ssh-config"],
      // The `~/.ssh/config` block goes before the destroy, the opposite of the
      // keypair below. A block that outlives its host is stale but harmless; a
      // key that predeceases its host locks the operator out of a machine that
      // still exists. Both orders are deliberate; see standards/ssh-config.md.
      "n8n/ssh-config": [tools.ansibleLocalStep, "n8n/dns"],
      // DNS goes before the compute destroy: a record pointing at an address
      // that no longer answers is a live outage for anything still resolving
      // it, while a record removed slightly early merely 404s.
      "n8n/dns": [tools.dnsStep, "n8n/infrastructure"],
      "n8n/infrastructure": [tools.infrastructureStep, "n8n/ssh-cleanup"],
      "n8n/ssh-cleanup": [ssh.cleanupStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "n8n/start": [startStep, "n8n/infrastructure"],
    // After compute, which is where the address first exists, and before the
    // stage that converges the machine — the converge and the acceptance both
    // ride the alias this stage writes.
    "n8n/infrastructure": [tools.infrastructureStep, "n8n/dns"],
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
  "n8n/infrastructure", "n8n/dns", "n8n/ssh-config",
  "n8n/ansible", "n8n/acceptance", "n8n/ssh-cleanup",
];

function create() {
  let wf = workflow({ start: "n8n/start", wireFn });
  wf = adviceAdd(wf, "n8n/infrastructure", "before", "n8n.workflow/backend",
    backendAdvice(tools.infrastructureTool));
  wf = adviceAdd(wf, "n8n/dns", "before", "n8n.workflow/backend",
    backendAdvice(tools.dnsTool));
  return dryRun.advise(progress.advise(wf), sideEffecting);
}

export const n8nWorkflow = create();
