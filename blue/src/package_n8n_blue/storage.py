"""Opt-in deployment-owned S3 buckets for Neon data and backups, each with its
own bucket-scoped IAM identity — the port of io.github.getcolors.n8n.storage.

Modelled on the langfuse package's storage stage. The stage exists only when
`n8n-storage-managed` is true; otherwise every function here is a no-op and
the operator supplies the two credential pairs by hand, as before.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from blue import tofu
from blue.cli import stage_dir
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, scaffold

tool = "n8n-storage"


def managed(opts: dict) -> bool:
    return opts.get("n8n-storage-managed") is True


def directory(opts: dict) -> str:
    return stage_dir(opts, tool, default_profile="n8n")


def aws_env(opts: dict) -> dict[str, str]:
    """AWS credentials supplied as COLORS_PAR_AWS_* overlays, mapped onto the
    variable names the AWS SDK reads. Empty when the operator relies on the
    ambient credential chain instead."""
    mapping = {"aws-access-key-id": "AWS_ACCESS_KEY_ID",
               "aws-secret-access-key": "AWS_SECRET_ACCESS_KEY",
               "aws-session-token": "AWS_SESSION_TOKEN"}
    return {variable: str(opts[key]) for key, variable in mapping.items()
            if opts.get(key) not in (None, "")}


# Bucket roles, in the order the template declares them, each paired with the
# desired-state key naming its bucket and the COLORS_PAR_ prefix its
# credential reaches Ansible under.
ROLES = [("neon", "neon-r2-bucket", "NEON_R2"),
         ("backup", "n8n-backup-r2-bucket", "N8N_BACKUP_R2")]


def specs(opts: dict) -> list[dict]:
    name = "tools/storage/main.tf"
    return [{"template": {"name": name,
                          "content": (Path(__file__).parent / "resources" / name).read_text()},
             "target": f"{directory(opts)}/main.tf", "data": opts,
             "opts": PRESERVE_JINJA_DELIMITERS}]


async def _checked(args: list[str], config: dict) -> str:
    result = await runtime.exec(args, **config)
    if result.exit:
        raise RuntimeError("managed storage state operation failed")
    return result.out


async def ownership_preflight(opts: dict) -> None:
    """Refuse existing buckets unless this stage already owns their Terraform
    address. A bucket that answers anything but 404 to a head-bucket probe is
    someone's, or unreachable; both fail closed."""
    config = {"cwd": directory(opts), "env": aws_env(opts)}
    await _checked(["tofu", "init", "-input=false", "-no-color"], config)
    state = await runtime.exec(["tofu", "state", "list"], **config)
    empty_state = state.exit == 1 and "No state file was found!" in (state.err or "")
    if state.exit and not empty_state:
        raise RuntimeError("managed storage state unavailable")
    addresses = [line for line in ("" if empty_state else state.out).splitlines() if line]
    recorded: dict[str, str | None] = {}
    if addresses:
        shown = json.loads(await _checked(["tofu", "show", "-json"], config))
        for resource in shown.get("values", {}).get("root_module", {}).get("resources", []):
            recorded[resource.get("address")] = resource.get("values", {}).get("bucket")
    for role, bucket_key, _prefix in ROLES:
        bucket = opts.get(bucket_key)
        if bucket == recorded.get(f'aws_s3_bucket.application["{role}"]'):
            continue
        probe = await runtime.exec(["aws", "s3api", "head-bucket", "--bucket", bucket,
                                    "--region", opts.get("neon-r2-region")], **config)
        # 403, network failures, and a successful probe all fail closed.
        if not (probe.exit > 0 and re.search(r"\(404\)|Not Found|NoSuchBucket", probe.err or "")):
            raise RuntimeError("managed storage refuses to adopt an existing or inaccessible bucket")


async def storage_step(opts: dict) -> dict:
    if not managed(opts):
        return {**opts, "blue/exit": 0}
    try:
        documents = specs(opts)
        if opts.get("blue/event") == "create":
            scaffold(opts, documents)
            await ownership_preflight(opts)
        # Scoped credentials stay in memory and in the encrypted backend state.
        # They are never copied into template values or printed.
        return await tofu.tofu_with_spec(opts, documents, dir=directory(opts),
                                         env=aws_env(opts),
                                         output_key="n8n/storage-credentials")
    except Exception:
        return {**opts, "blue/exit": 1,
                "blue/err": "managed S3 storage failed; inspect bucket ownership, "
                            "state access, and AWS permissions"}


def credential_env(opts: dict) -> dict[str, str]:
    """The minted pairs as the COLORS_PAR_ variables the plays already look
    up, for the Ansible subprocess environment only. Raises when a pair is
    absent, so a converge never runs with an empty credential."""
    credentials = (opts.get("n8n/storage-credentials") or {}).get("credentials") or {}
    environment = {"ANSIBLE_HOST_KEY_CHECKING": "False"}
    for role, _bucket_key, prefix in ROLES:
        values = credentials.get(role) or {}
        access, secret = values.get("access_key_id"), values.get("secret_access_key")
        if not access or not secret or not str(access).strip() or not str(secret).strip():
            raise RuntimeError("managed storage credentials unavailable")
        environment[f"COLORS_PAR_{prefix}_ACCESS_KEY_ID"] = access
        environment[f"COLORS_PAR_{prefix}_SECRET_ACCESS_KEY"] = secret
    return environment
