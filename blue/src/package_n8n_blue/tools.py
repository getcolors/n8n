"""The steps and every template spec, the port of io.github.getcolors.n8n.tools."""

from __future__ import annotations

import hashlib
import json
import random
import re
import urllib.request
from pathlib import Path

import package_neon_blue
from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec

from . import ssh_config, validate

infrastructure_tool = "n8n-infrastructure"
dns_tool = "n8n-dns"
ansible_tool = "n8n-ansible"
ansible_local_tool = "n8n-ansible-local"
ROOT = Path(__file__).parent / "resources"

# The storage tier's templates live in the SHA-pinned package-neon-blue
# distribution, not in this repository: blue ships them inside the installed
# package, so they are read from there and never copied in here, never edited.
# A copy of a tier this subtle drifts, and the drift is silent.
NEON_ROOT = Path(package_neon_blue.__file__).parent / "resources"

template_opts = PRESERVE_JINJA_DELIMITERS


def tool_dir(opts: dict, tool: str) -> str:
    return stage_dir(opts, tool, default_profile="n8n")


def template(path: str, file: str) -> dict:
    name = f"tools/{path}/{file}"
    return {"name": name, "content": (ROOT / name).read_text()}


def neon_template(path: str, file: str) -> dict:
    name = f"tools/{path}/{file}"
    return {"name": f"neon/{name}", "content": (NEON_ROOT / name).read_text()}


def spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": template_opts}


def raw_spec(target: str, content: str) -> dict:
    return content_spec(target, content)


def cidrs(opts: dict, key: str) -> list[str]:
    value = opts.get(key)
    xs = value if isinstance(value, list) else re.split(
        r"[,\s]+", "" if value is None else str(value))
    return [s for s in (str(x).strip() for x in xs) if s]


def credential_env(opts: dict, *slots: str) -> dict[str, str] | None:
    merged: dict[str, str] = {}
    for slot in [*slots, "provider-backend"]:
        merged.update(validate.tofu_env(opts, slot))
    result = {}
    for key, env_var in merged.items():
        value = "" if opts.get(key) is None else str(opts.get(key))
        if value:
            result[env_var] = value
    return result or None


def backend_credential_env(opts: dict) -> dict[str, str] | None:
    return credential_env(opts)


def fallback_params(opts: dict) -> dict:
    return {"ip": "192.0.2.10", "user": "root", "sudoer": "root",
            "name": validate.compute_name(opts)}


def output_params(result: dict) -> dict | None:
    return (result.get("tofu/outputs") or {}).get("params")


def r2_prefix(opts: dict) -> str:
    """The Neon data prefix inside the R2 bucket. Everything the pageserver
    and safekeeper write — and the ownership markers guarding adoption — lives
    under `<profile>/data/`. The tofu state for the same deployment lives at
    `<profile>/<stage>.tfstate` in the same bucket, a sibling key space that
    never collides with this one."""
    return f"{opts.get('profile')}/data"


def _pretty(value, indent=0):
    """Cheshire's pretty JSON, byte for byte — Green's artifact contract. In
    insertion order: `tofu.constructs_json` sorts keys, which is right for a
    Terraform document and wrong for the two documents this package writes
    itself, where the inventory's groups must stay as declared."""
    if isinstance(value, list):
        if not value:
            return "[ ]"
        return "[ " + ", ".join(_pretty(item, indent) for item in value) + " ]"
    if isinstance(value, dict):
        if not value:
            return "{ }"
        pad = " " * (indent + 2)
        body = ",\n".join(f"{pad}{json.dumps(str(k))} : {_pretty(v, indent + 2)}"
                          for k, v in value.items())
        return "{\n" + body + "\n" + " " * indent + "}"
    return json.dumps(value)


# ---------------------------------------------------------------- compute

# Cloudflare's published ranges, current as of 2026-09-01. Used when
# `vultr-http-sources` is the symbolic value `cloudflare` and the live fetch is
# unavailable — a `build` on a fresh checkout with no network must still
# render, or the offline-render guarantee this workspace relies on is gone.
# A real converge prefers the fetch and FAILS rather than silently widening.
cloudflare_ranges_fallback = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
    "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
    "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]


USER_AGENT = "colors-n8n"


def fetch_cloudflare_ranges() -> list[str] | None:
    """Cloudflare's published ranges, or None when they cannot be fetched.

    Never widens on failure: the caller decides, and on a real event it stops."""
    try:
        def pull(url: str) -> list[str]:
            # An explicit User-Agent, because Cloudflare answers the default
            # `Python-urllib/3.x` with 403 Forbidden. Without it this function
            # always returns None, the fallback list is always rendered, and
            # the colours disagree on `origin` for one desired state — a parity
            # failure that looks like a template bug. Green happens to pass on
            # the JVM's default agent; nothing here should depend on which
            # runtime a colour is written in.
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=10) as response:
                text = response.read().decode()
            return [line.strip() for line in text.splitlines() if line.strip()]

        ranges = [*pull("https://www.cloudflare.com/ips-v4"),
                  *pull("https://www.cloudflare.com/ips-v6")]
        return ranges or None
    except Exception:
        return None


def http_sources(opts: dict) -> dict:
    """The origin ingress list.

    `cloudflare` is a symbolic source this package RESOLVES — not a pinned list
    in desired state, which an earlier draft wrongly called it. Returns the
    resolved set plus how it was obtained, so the caller can record a checksum
    and so a real converge can refuse to proceed on a stale fallback."""
    if validate._s(opts.get("vultr-http-sources")) != "cloudflare":
        return {"source": "explicit", "ranges": cidrs(opts, "vultr-http-sources")}
    live = fetch_cloudflare_ranges()
    if live:
        return {"source": "fetched", "ranges": live}
    return {"source": "fallback", "ranges": cloudflare_ranges_fallback}


def ranges_checksum(values: list[str]) -> str:
    digest = hashlib.sha256("\n".join(sorted(values)).encode()).hexdigest()
    return digest[:16]


def infrastructure_data(opts: dict) -> dict:
    resolved = http_sources(opts)
    ranges = resolved["ranges"]
    return {**opts,
            "compute-name": validate.compute_name(opts),
            "ssh-keygen": validate.keygen(opts),
            "ssh-sources-hcl": tofu.hcl_list(cidrs(opts, "vultr-ssh-sources")),
            "http-sources-hcl": tofu.hcl_list(ranges),
            "http-sources-origin": resolved["source"],
            "http-sources-ranges": ranges,
            "http-sources-checksum": ranges_checksum(ranges)}


async def infrastructure_step(opts: dict) -> dict:
    dir = tool_dir(opts, infrastructure_tool)
    data = infrastructure_data(opts)
    specs = [
        spec(template("infrastructure", "main.tf"), f"{dir}/main.tf", data),
        # The resolved range set is recorded, with a checksum, so a firewall
        # change is explainable after the fact rather than an unattributable
        # diff in a provider plan.
        raw_spec(f"{dir}/http-sources.json",
                 _pretty({"origin": data["http-sources-origin"],
                          "checksum": data["http-sources-checksum"],
                          "ranges": data["http-sources-ranges"]})),
    ]
    result = await tofu.tofu_with_spec(
        opts, specs, dir=dir, env=credential_env(opts, "provider-compute"))
    if (result.get("blue/exit") or 0) > 0:
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_params(opts)}
    if opts.get("blue/event") == "delete":
        return result
    return {**result, **fallback_params(opts), **(output_params(result) or {})}


# ---------------------------------------------------------- ansible (local)


def ansible_local_data(opts: dict) -> dict:
    """Only what a `build` genuinely knows. The address, the user and the alias
    are run-time facts and reach the play as extra-vars instead, so the
    rendered playbook carries no IP and is identical on every workstation (SSH
    Config Standard §6)."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "ssh-config-identity-file": ssh_config.identity_file(opts)}


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = ansible_local_data(opts)
    # Also the dependency's, unchanged: the ~/.ssh/config block this writes is
    # the SSH Config Standard's, and it is parameterised by profile and address
    # alone. A second implementation here would be a second thing to keep
    # conformant with a standard that already has a reference implementation.
    return [spec(neon_template("ansible-local", name), f"{dir}/{name}", data)
            for name in ["ansible.cfg", "inventory.ini", "main.yml"]]


async def ansible_local_step(opts: dict) -> dict:
    """Write or remove the `~/.ssh/config` block. The same playbook serves both
    events; `block_state` is what distinguishes them."""
    dir = tool_dir(opts, ansible_local_tool)
    delete = opts.get("blue/event") == "delete"
    return await ansible_with_spec(
        opts, ansible_local_specs(opts),
        dir=dir, inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars={"host_alias": ssh_config.host_alias(opts),
                    "ip": opts.get("ip") or fallback_params(opts)["ip"],
                    "user": opts.get("user") or "root",
                    "block_state": "absent" if delete else "present"})


# ---------------------------------------------------------------- ansible


def inventory(opts: dict) -> str:
    """One host in two groups.

    The imported getcolors/neon play targets `hosts: neon` and this package's
    play targets `hosts: n8n`; both converge the same machine. Ansible supports
    a host in several groups, but group_vars precedence between them would be a
    live hazard, so every value is a HOST var here and neither group carries
    variables at all. Nothing can then depend on which group won."""
    profile = opts.get("profile")
    return _pretty(
        {"all": {"children": {"neon": {"hosts": {profile: None}},
                              "n8n": {"hosts": {profile: None}}},
                 "hosts": {profile: {"ansible_host": opts.get("ip") or "192.0.2.10",
                                     "ansible_user": "root"}}}})


def ansible_data(opts: dict) -> dict:
    """Template values for the Ansible stage.

    Deliberately carries neither operator secret. The R2 pair reaches the
    host as Ansible `lookup('env', ...)` expressions written literally into
    main.yml, where `preserve-jinja-delimiters` passes them through untouched —
    routing them through this map instead would let the template engine
    HTML-escape the quotes and hand Ansible `&#39;`. The secret therefore
    exists only in the process that needs it: not in `.colors/`, not in a
    golden, not in this map."""
    return {**opts,
            "ip": opts.get("ip") or "192.0.2.10",
            "ssh-keygen": validate.keygen(opts),
            "neon-r2-prefix": opts.get("neon-r2-prefix") or r2_prefix(opts)}


NEON_FILES = [
    "ansible.cfg", "main.yml", "cleanup.yml", "compose.yml",
    "pageserver.toml", "identity.toml", "config.json", "scramgen.py",
    "bootstrap.sh", "smoke.sh", "status.sh", "rotate.sh",
]

N8N_ANSIBLE_FILES = [
    "site.yml", "n8n.yml", "cleanup.yml",
    # Installed on the host as /opt/neon/compose.override.yml, beside the
    # dependency's compose.yml — never passed with -f. See the header of that
    # template for why that is load-bearing rather than stylistic.
    "compose.override.yml", "Caddyfile",
    "n8n-env.sh", "n8n-backup.sh", "n8n-restore.sh", "n8n-monitor.sh",
    "n8n-smoke.sh", "n8n-claim-owner.sh", "n8n-soak.sh",
    # Plain JavaScript with no template markers, but rendered through the same
    # path so one mechanism installs everything.
    "soak.js", "acceptance.js", "rehearsal.js",
    "n8n-rehearsal.sh", "n8n-prune-drill.sh", "n8n-restart-drill.sh",
]


def neon_specs(dir: str, data: dict) -> list[dict]:
    """The storage tier, rendered UNCHANGED from the pinned dependency into its
    own `neon/` subdirectory.

    The subdirectory is not tidiness. The upstream play copies its files by
    relative `src:` name (`main.yml:106`), so rendering them flat beside this
    package's templates would let an n8n file with the same basename win
    silently — `cleanup.yml` is exactly such a name. Keeping the bundle whole
    and separate is what makes `import_playbook neon/main.yml` mean the
    dependency's play and nothing else."""
    sub = f"{dir}/neon"
    return [spec(neon_template("ansible", name), f"{sub}/{name}", data)
            for name in NEON_FILES]


def ansible_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_tool)
    data = ansible_data(opts)
    return [*neon_specs(dir, data),
            # The dependency's, not a local copy. Writing our own dropped its
            # `<% if ssh-keygen %> private_key_file` conditional, and the
            # deployment then had no identity to offer -- `Permission denied
            # (publickey)` after a ten-minute wait_for_connection timeout.
            # Reusing it is both less code and the only version that stays
            # correct when the standard moves.
            spec(neon_template("ansible", "ansible.cfg"), f"{dir}/ansible.cfg", data),
            *[spec(template("ansible", name), f"{dir}/{name}", data)
              for name in N8N_ANSIBLE_FILES],
            raw_spec(f"{dir}/inventory.json", inventory(data))]


async def ansible_step(opts: dict) -> dict:
    dir = tool_dir(opts, ansible_tool)
    if opts.get("blue/event") == "delete" and not opts.get("ip"):
        # No compute in state: there is no host to stop, and the cleanup play
        # would only fail against the placeholder address.
        return {**opts, "blue/exit": 0}
    return await ansible_with_spec(
        opts, ansible_specs(opts),
        dir=dir, inventory="inventory.json",
        playbooks={"create": "site.yml", "delete": "cleanup.yml"},
        host_key_checking=False)


# ------------------------------------------------------------------- dns


def dns_data(opts: dict) -> dict:
    return {**opts, "ip": opts.get("ip") or "192.0.2.10"}


# The data source in dns/main.tf is named `zone`, and the attribute is `id`.
# `data.cloudflare_zone.this.zone_id` -- the shape that reads most naturally --
# is wrong on both counts and fails only at apply time, after the compute stage
# has already created a billable instance.
ZONE_ID = "${data.cloudflare_zone.zone.id}"


def dns_json(data: dict) -> str:
    return tofu.constructs_json([
        tofu.construct("resource", "cloudflare_dns_record", "n8n", {
            "zone_id": ZONE_ID,
            # The full name, not the leaf label.
            "name": data.get("n8n-host"),
            "type": "A",
            "content": data.get("ip"),
            # 1 means "automatic". Cloudflare rejects any explicit TTL on a
            # proxied record, because the edge controls it.
            "ttl": 1,
            "proxied": bool(data.get("cloudflare-proxied")),
        }),
    ])


async def dns_step(opts: dict) -> dict:
    dir = tool_dir(opts, dns_tool)
    data = dns_data(opts)
    specs = [spec(template("dns", "main.tf"), f"{dir}/main.tf", data),
             raw_spec(f"{dir}/record.tf.json", dns_json(data))]
    return await tofu.tofu_with_spec(
        opts, specs, dir=dir, env=credential_env(opts, "provider-dns"))


# ------------------------------------------------------------- acceptance


async def run_quiet(args: list[str], env: dict[str, str], timeout_ms: int):
    """Run `args` with `env` overlaid, returning the result. Nothing from the
    child is echoed; callers decide what becomes an error message, so a secret
    passed through `env` can never leak into output by default."""
    return await runtime.exec(args, env=env, timeout_ms=timeout_ms)


def psql_args(opts: dict, port: int, sql: str) -> list[str]:
    """A psql invocation with an explicit everything: host, port, role,
    database, and `-w` so a missing password fails instead of prompting.
    `env -i` clears the environment and re-admits only PATH, the password
    handed over through the runner, and a dead PGPASSFILE — so no ambient
    PG* variable, service file, or ~/.pgpass can alter what the probe
    proves."""
    quoted = "'" + sql.replace("'", "'\\''") + "'"
    return ["bash", "-c",
            'exec env -i PATH="$PATH" PGPASSFILE=/dev/null'
            ' PGPASSWORD="$PGPASSWORD" psql'
            f" 'postgresql://{opts.get('neon-role')}@127.0.0.1:{port}"
            f"/{opts.get('neon-database')}?connect_timeout=10'"
            f" -w -v ON_ERROR_STOP=1 -tAc {quoted}"]


def tunnel_args(opts: dict, port: int) -> list[str]:
    """An ssh tunnel through the generated `~/.ssh/config` alias — the
    supported client path, exercised end to end: the alias, the identity file,
    and the forward. `-f` returns once the forward is up; the remote `sleep`
    bounds its lifetime so nothing needs killing on the way out. The bash
    wrapper exists for the streams: the daemonized child inherits
    stdout/stderr, and a runner that waits for the pipes to close would
    otherwise block until the sleep expires — returning exactly when the
    tunnel dies."""
    return ["bash", "-c",
            "ssh -f -o ExitOnForwardFailure=yes -o BatchMode=yes"
            f" -L {port}:127.0.0.1:55433 "
            f"{ssh_config.host_alias(opts)} sleep 45 >/dev/null 2>&1"]


# One deployment-scoped row, updated deterministically: the same statement on
# every converge, so a second create reconciles instead of accumulating.
SMOKE_SQL = (
    "INSERT INTO colors_smoke (id, note, at) VALUES (1, 'operator-path', now())"
    " ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note, at = EXCLUDED.at;"
    " SELECT count(*) FROM colors_smoke;")


async def read_remote_password(opts: dict) -> str | None:
    """The generated application-role password, read over SSH and held only in
    this process. Never merged into opts, never printed."""
    result = await run_quiet(
        ["ssh", "-o", "BatchMode=yes", ssh_config.host_alias(opts),
         "cat", "/etc/neon/secrets/neon_role_password"], {}, 20000)
    if result.exit != 0:
        return None
    password = str(result.out or "").strip()
    return password or None


async def acceptance_step(opts: dict) -> dict:
    """The operator-path gate, after a real create.

    The server-side gates already ran inside the playbook (health, the SQL
    round-trip, the auth negatives, the R2 object listings). What is checked
    from here is the one thing only this side can check: that an operator on
    this workstation reaches the database through the generated SSH config and
    a tunnel — the supported client path — with the generated password, and
    not without it."""
    if opts.get("blue/event") != "create":
        return {**opts, "blue/exit": 0}
    password = await read_remote_password(opts)
    if not password:
        return {**opts, "blue/exit": 1,
                "blue/err": "acceptance: could not read the generated role password over ssh"}
    for _attempt in range(3):
        port = 20000 + random.randrange(40000)
        tunnel = await run_quiet(tunnel_args(opts, port), {}, 30000)
        if tunnel.exit != 0:
            continue
        ok = await run_quiet(psql_args(opts, port, SMOKE_SQL),
                             {"PGPASSWORD": password}, 30000)
        denied = await run_quiet(psql_args(opts, port, "SELECT 1;"),
                                 {"PGPASSWORD": "not-the-password"}, 30000)
        if ok.exit != 0:
            return {**opts, "blue/exit": 1,
                    "blue/err": ("acceptance: the tunnelled smoke round-trip failed: "
                                 + str(ok.err or "").strip())}
        # psql prints the INSERT command tag before the count; the count is
        # the last line.
        if str(ok.out or "").strip().splitlines()[-1:] != ["1"]:
            return {**opts, "blue/exit": 1,
                    "blue/err": ("acceptance: colors_smoke should hold exactly one row, got "
                                 + str(ok.out or "").strip())}
        if denied.exit == 0:
            return {**opts, "blue/exit": 1,
                    "blue/err": "acceptance: a wrong password was accepted through the tunnel"}
        return {**opts, "blue/exit": 0,
                "neon/acceptance": {"tunnel": "ok", "smoke-rows": "1",
                                    "wrong-password": "refused"}}
    return {**opts, "blue/exit": 1,
            "blue/err": "acceptance: no local port could carry the ssh tunnel after three attempts"}
