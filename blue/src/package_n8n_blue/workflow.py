"""The graph, the port of io.github.getcolors.n8n.workflow."""

from __future__ import annotations

from blue import dry_run, progress, tofu
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, failed, workflow
from colors_compute import finalize_backend

from . import compute, ssh_config, storage, tools, validate

DEFAULTS = {"provider-compute": "vultr", "provider-dns": "cloudflare",
            "provider-backend": "r2", "compute-prevent-destroy": True,
            "workdir": ".colors"}


async def start_step(original: dict, env: dict | None = None) -> dict:
    def after(opts, _env, context):
        current = {**opts, 'blue/exit':0}
        return ssh_config.preflight(current) if context['real'] and context['event']=='create' else current

    return await preflight(
        original, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            lambda o, _e, c: (validate.secret_errors(o, c["event"])
                              if c["real"] and c["event"] in ("create", "delete") else []),
            lambda o, _e, c: ([f"compute destruction is protected; set "
                               f"{par_name('compute-prevent-destroy')}=false to delete"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ],
        after_validate=after)


def managed_backend(opts: dict) -> bool:
    return opts.get("s3-bucket-mode") == "managed"


async def load_step(opts: dict) -> dict:
    return await compute.load_step(opts, tools.environment(opts))


async def backend_finalize_step(opts: dict) -> dict:
    """Remove the deployment-owned S3 state bucket, last of all. The library
    refuses while any live state or unowned object remains in it."""
    try:
        result = await finalize_backend(opts, tools.environment(opts))
        if result.get("status") in ("destroyed", "absent", "skipped"):
            return {**opts, "blue/exit": 0}
        return {**opts, "blue/exit": 1, "blue/err": "managed backend finalization refused"}
    except Exception:
        return {**opts, "blue/exit": 1,
                "blue/err": "managed backend finalization refused; live or unowned state remains"}


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "n8n/start": (start_step, "n8n/load"),
            "n8n/load": (load_step, "n8n/ansible"),
            "n8n/ansible": (tools.ansible_step, "n8n/ssh-config"),
            # The `~/.ssh/config` block goes before the destroy, the opposite
            # of the keypair below. A block that outlives its host is stale but
            # harmless; a key that predeceases its host locks the operator out
            # of a machine that still exists. Both orders are deliberate; see
            # standards/ssh-config.md.
            "n8n/ssh-config": (tools.ansible_local_step, "n8n/dns"),
            # DNS goes before the compute destroy: a record pointing at an
            # address that no longer answers is a live outage for anything
            # still resolving it, while a record removed slightly early merely
            # 404s.
            "n8n/dns": (tools.dns_step,
                        "n8n/storage" if storage.managed(run_opts) else "n8n/infrastructure"),
            # Managed buckets go after the host is stopped and before the
            # compute destroy, so nothing is still writing into a bucket being
            # emptied.
            "n8n/storage": (storage.storage_step, "n8n/infrastructure"),
            "n8n/infrastructure": ((tools.infrastructure_step, "n8n/backend-finalize")
                                   if managed_backend(run_opts) else (tools.infrastructure_step,)),
            "n8n/backend-finalize": (backend_finalize_step,),
        }.get(step)
    return {
        "n8n/start": (start_step, "n8n/infrastructure"),
        # After compute, which is where the address first exists, and before
        # the stage that converges the machine — the converge and the
        # acceptance both ride the alias this stage writes.
        "n8n/infrastructure": (tools.infrastructure_step,
                               "n8n/storage" if storage.managed(run_opts) else "n8n/dns"),
        # The buckets and their scoped credentials exist before the converge
        # that hands them to the host.
        "n8n/storage": (storage.storage_step, "n8n/dns"),
        # DNS before the converge, not after: Caddy provisions its certificate
        # over ACME on first start, and the HTTP-01 challenge needs the name to
        # already resolve to this host. Converging first would make the first
        # boot fail its certificate and retry on ACME's backoff.
        "n8n/dns": (tools.dns_step, "n8n/ssh-config"),
        "n8n/ssh-config": (tools.ansible_local_step, "n8n/ansible"),
        "n8n/ansible": (tools.ansible_step, "n8n/acceptance"),
        "n8n/acceptance": (tools.acceptance_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tools.tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile') or ''}/{tool}.tfstate")


side_effecting = ["n8n/backend-finalize", "n8n/storage",
                  "n8n/infrastructure", "n8n/dns", "n8n/ssh-config",
                  "n8n/ansible", "n8n/acceptance", "n8n/load"]


def next_fn(step: str, successors, opts: dict) -> list[tuple[str, dict]]:
    """Static successors, except after a delete's load step that found no live
    compute under a managed state bucket: then only finalization remains."""
    if failed(opts):
        return []
    if step == "n8n/load" and opts.get("n8n/finalize-only"):
        return [("n8n/backend-finalize", opts)]
    return [(successor, opts) for successor in (successors or [])]


def create_workflow():
    wf = workflow(start="n8n/start", wire_fn=wire_fn, next_fn=next_fn)
    wf = advice_add(wf, "n8n/dns", "before", "n8n.workflow/backend", backend_advice(tools.dns_tool))
    wf = advice_add(wf, "n8n/storage", "before", "n8n.workflow/storage-backend", backend_advice(storage.tool))
    return dry_run.advise(progress.advise(wf), side_effecting)


n8n_workflow = create_workflow()
