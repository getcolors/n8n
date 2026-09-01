"""Validation over desired state, the port of io.github.getcolors.n8n.validate.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import re

from blue.cli import par_name
from package_once_blue import ssh as once_ssh
from package_once_blue.validate import providers as once_providers

profile_par = par_name("profile")

# Every key desired state must carry.
#
# Two deliberate absences carried over from `neon`: `vultr-ssh-keys` selects
# opt-out mode by being present (SSH Keypair Standard), so requiring it would
# make every conforming keygen deployment invalid, and `vultr-name` is the
# Compute Name Standard's optional override.
#
# Unlike `neon`, this package DOES require `provider-dns`. Neon publishes
# nothing and is reached through an SSH tunnel; n8n is a public application
# whose whole purpose is receiving webhooks from third parties, so a name and a
# certificate are not optional extras here.
required = [
    "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
    "compute-prevent-destroy",
    # storage tier — neon's own vocabulary, because this package renders
    # neon's templates rather than copying them (see tools.py)
    "neon-image", "neon-compute-image", "neon-pg-version",
    "neon-tenant-id", "neon-timeline-id",
    "neon-database", "neon-role",
    "neon-r2-bucket", "neon-r2-endpoint", "neon-r2-region", "neon-r2-prefix",
    # application tier
    "n8n-image", "n8n-runners-image", "n8n-host", "n8n-port",
    "n8n-owner-email", "n8n-proxy-hops", "n8n-timezone", "n8n-data-dir",
    "n8n-binary-data-mode", "n8n-concurrency-production-limit",
    "n8n-executions-data-max-age", "n8n-executions-data-prune-max-count",
    "n8n-block-env-access-in-node", "n8n-enforce-settings-file-permissions",
    "n8n-git-node-disable-bare-repos", "n8n-restrict-file-access-to",
    "caddy-image",
    # backups — the only whole-host recovery source
    "n8n-backup-r2-bucket", "n8n-backup-oncalendar", "n8n-backup-retention-days",
    "n8n-backup-dir",
    # public name and TLS
    "cloudflare-zone", "cloudflare-record-name", "cloudflare-proxied",
    # compute
    "vultr-region", "vultr-plan", "vultr-os-id",
    "vultr-ssh-sources", "vultr-http-sources",
    "r2-bucket", "r2-endpoint",
]

image_keys = ["neon-image", "neon-compute-image", "n8n-image", "n8n-runners-image",
              "caddy-image"]

soak_keys = [
    "n8n-soak-concurrent-workflows", "n8n-soak-duration-seconds",
    "n8n-soak-mix-api-percent", "n8n-soak-mix-code-node-percent",
    "n8n-soak-mix-binary-percent",
    "n8n-soak-code-node-payload-mb", "n8n-soak-binary-payload-mb",
    "n8n-soak-max-p95-sql-roundtrip-ms", "n8n-soak-max-p99-sql-roundtrip-ms",
    "n8n-soak-max-p95-execution-ms", "n8n-soak-max-p99-execution-ms",
    "n8n-soak-min-executions-completed",
    "n8n-soak-max-host-memory-percent", "n8n-soak-max-disk-percent",
]

image_re = re.compile(r"[^\s:@]+(?:/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64}|:[^\s:@]+@sha256:[0-9a-f]{64})")
hex32_re = re.compile(r"[0-9a-f]{32}")
ident_re = re.compile(r"[a-z_][a-z0-9_]*")
url_re = re.compile(r"https://[^\s]+")
host_re = re.compile(r"(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}")
email_re = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
version_tag_re = re.compile(r":([^\s:@/]+)@sha256:")


def _s(value) -> str:
    """Clojure's `str`: nil renders empty, booleans lowercase, a vector as its
    literal. Green compares stringified values in several rules, and Python's
    own `str` disagrees with it on exactly the inputs those rules exist to
    catch — `str(["cloudflare"])` is `['cloudflare']`, which must not read as
    the symbolic source."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return "[" + " ".join(_s(v) if not isinstance(v, str) else f'"{v}"'
                              for v in value) + "]"
    return str(value)


def missing(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def placeholder(value) -> bool:
    """Whether the compute-name override is effectively absent (Compute Name
    Standard §2: presence is the only switch)."""
    return missing(value) or _s(value).strip() == "REPLACE_ME"


def compute_name(opts: dict) -> str:
    """What this deployment calls its machine. The one function that answers
    it — every label, including the firewall's, derives from this and never
    from the raw override key or a second copy of the profile (§3)."""
    override = opts.get("vultr-name")
    return _s(opts.get("profile")) if placeholder(override) else _s(override).strip()


def keygen(opts: dict) -> bool:
    """Whether this deployment owns its machine keypair. Delegates to ONCE, the
    standard's reference implementation, so one rule decides it everywhere."""
    return once_ssh.keygen(opts)


def image_version(value) -> str | None:
    """The human-readable tag out of a `repo:tag@sha256:...` pin, or None."""
    match = version_tag_re.search(_s(value))
    return match.group(1) if match else None


def effective_r2(opts: dict) -> dict:
    """Which credential pair reaches the host for Neon remote storage.

    A split `COLORS_PAR_NEON_R2_*` pair is preferred; when it is absent the
    shared `COLORS_PAR_R2_*` pair is used instead. That fallback is what the
    deployment currently runs on, and it is the reason the backup-credential
    scoping gate reports SKIPPED rather than passing — one credential reaching
    state, live data and backups alike is a real weakness, so it is named here
    rather than hidden behind a default."""
    if (not missing(opts.get("neon-r2-access-key-id"))
            and not missing(opts.get("neon-r2-secret-access-key"))):
        return {"split": True,
                "access-key-id": opts.get("neon-r2-access-key-id"),
                "secret-access-key": opts.get("neon-r2-secret-access-key")}
    return {"split": False,
            "access-key-id": opts.get("r2-access-key-id"),
            "secret-access-key": opts.get("r2-secret-access-key")}


def backup_credential_scoped(opts: dict) -> bool:
    """Whether a backup-only credential was supplied. Gate R2 is conditional on
    this and reports its reason when false."""
    return (not missing(opts.get("n8n-backup-r2-access-key-id"))
            and not missing(opts.get("n8n-backup-r2-secret-access-key")))


def credential_sharing_accepted(opts: dict) -> bool:
    """Whether desired state explicitly accepts one R2 credential reaching
    OpenTofu state, live Neon data, and backups alike."""
    return _s(opts.get("r2-credential-sharing")) == "shared-accepted"


def env_errors(env: dict) -> list[str]:
    if _s(env.get(profile_par)):
        return [f"{profile_par} is set; profile must come from colors.yml only"]
    return []


def _int_like(value) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, str) and re.fullmatch(r"-?\d+", value) is not None


def _as_int(value) -> int | None:
    return int(value) if _int_like(value) else None


def state_errors(opts: dict) -> list[str]:
    errors: list[str] = []
    errors += [f":{k} is required" for k in required if missing(opts.get(k))]
    errors += [f":{k} is required" for k in soak_keys if missing(opts.get(k))]

    if opts.get("provider-compute") != "vultr":
        errors.append(":provider-compute must be vultr")
    if opts.get("provider-dns") != "cloudflare":
        errors.append(":provider-dns must be cloudflare")
    if opts.get("provider-backend") not in ("local", "s3", "r2"):
        errors.append(":provider-backend must be local, s3, or r2")
    if not isinstance(opts.get("compute-prevent-destroy"), bool):
        errors.append(":compute-prevent-destroy must be true or false")

    # --- images ------------------------------------------------------------
    for k in image_keys:
        v = opts.get(k)
        if not missing(v) and not image_re.fullmatch(_s(v)):
            errors.append(f":{k} must carry an explicit image tag or digest")
    for k in image_keys:
        if not missing(opts.get(k)) and "@sha256:" not in _s(opts.get(k)):
            errors.append(f":{k} must be pinned by digest (tag@sha256:...)")

    # Upstream requires the task runner image version to equal the n8n image
    # version. A mismatch is a protocol mismatch between the broker and the
    # runner, and it fails at workflow-execution time rather than at boot —
    # long after a converge would have reported success.
    a = image_version(opts.get("n8n-image"))
    b = image_version(opts.get("n8n-runners-image"))
    if a and b and a != b:
        errors.append(f":n8n-runners-image version {b} must equal :n8n-image version {a}")

    # --- storage tier -------------------------------------------------------
    pg_version = opts.get("neon-pg-version")
    if not (missing(pg_version)
            or (isinstance(pg_version, int) and not isinstance(pg_version, bool)
                and pg_version in (14, 15, 16, 17))):
        errors.append(":neon-pg-version must be 14, 15, 16, or 17")
    for k in ["neon-tenant-id", "neon-timeline-id"]:
        v = opts.get(k)
        if not missing(v) and not hex32_re.fullmatch(_s(v)):
            errors.append(f":{k} must be 32 lowercase hex characters")
    for k in ["neon-database", "neon-role"]:
        v = opts.get(k)
        if not missing(v) and not ident_re.fullmatch(_s(v)):
            errors.append(f":{k} must be a lowercase identifier")
    if _s(opts.get("neon-role")) == "cloud_admin":
        errors.append(":neon-role must not be cloud_admin")
    if (not missing(opts.get("neon-r2-endpoint"))
            and not url_re.fullmatch(_s(opts.get("neon-r2-endpoint")))):
        errors.append(":neon-r2-endpoint must be an https URL")
    # Live Neon data and OpenTofu state must not share a bucket. neon-vultr put
    # data inside the state bucket as a bootstrap deviation; repeating it here
    # would mean one lifecycle mistake could take out both.
    if (not missing(opts.get("neon-r2-bucket"))
            and _s(opts.get("neon-r2-bucket")) == _s(opts.get("r2-bucket"))):
        errors.append(":neon-r2-bucket must not be the OpenTofu state bucket")
    if (not missing(opts.get("n8n-backup-r2-bucket"))
            and _s(opts.get("n8n-backup-r2-bucket"))
            in {_s(opts.get("r2-bucket")), _s(opts.get("neon-r2-bucket"))}):
        errors.append(":n8n-backup-r2-bucket must not be the state or live-data bucket")

    # --- application tier ---------------------------------------------------
    if not (missing(opts.get("n8n-host")) or host_re.fullmatch(_s(opts.get("n8n-host")))):
        errors.append(":n8n-host must be a fully qualified hostname")
    if not (missing(opts.get("n8n-owner-email"))
            or email_re.fullmatch(_s(opts.get("n8n-owner-email")))):
        errors.append(":n8n-owner-email must be an email address")
    if not (missing(opts.get("n8n-port")) or _int_like(opts.get("n8n-port"))):
        errors.append(":n8n-port must be a port number")

    # Two proxies sit in front of n8n here (Cloudflare, then Caddy). n8n's
    # default is 0, which makes it trust the nearest hop and mis-attribute
    # every client address.
    hops = _as_int(opts.get("n8n-proxy-hops"))
    if not (missing(opts.get("n8n-proxy-hops")) or (hops is not None and 0 <= hops <= 10)):
        errors.append(":n8n-proxy-hops must be an integer between 0 and 10")
    if opts.get("cloudflare-proxied") is True and hops is not None and hops < 2:
        errors.append(":n8n-proxy-hops must be at least 2 when cloudflare-proxied is true "
                      "(Cloudflare, then Caddy)")

    # n8n's own default holds binary payloads in memory, and a Code node
    # duplicates its payload twice. `filesystem` is the only safe value on a
    # single host that also runs the database.
    if not (missing(opts.get("n8n-binary-data-mode"))
            or _s(opts.get("n8n-binary-data-mode")) in ("filesystem", "default")):
        errors.append(":n8n-binary-data-mode must be filesystem or default")
    if _s(opts.get("n8n-binary-data-mode")) == "default":
        errors.append(":n8n-binary-data-mode must be filesystem here: `default` holds "
                      "binary payloads in memory and this host also runs the database")

    # n8n defaults this to -1, i.e. unbounded concurrent production executions.
    # Peak memory is roughly 3x the largest payload times this number.
    concurrency = _as_int(opts.get("n8n-concurrency-production-limit"))
    if not (missing(opts.get("n8n-concurrency-production-limit"))
            or (concurrency is not None and concurrency > 0)):
        errors.append(":n8n-concurrency-production-limit must be a positive integer "
                      "(n8n's -1 default is unbounded and will OOM this host)")

    max_age = _as_int(opts.get("n8n-executions-data-max-age"))
    if not (missing(opts.get("n8n-executions-data-max-age"))
            or (max_age is not None and max_age > 0)):
        errors.append(":n8n-executions-data-max-age must be a positive number of HOURS")
    prune_max = _as_int(opts.get("n8n-executions-data-prune-max-count"))
    if not (missing(opts.get("n8n-executions-data-prune-max-count"))
            or (prune_max is not None and prune_max >= 0)):
        errors.append(":n8n-executions-data-prune-max-count must be zero or a positive integer")

    # These three default to false upstream, contradicting the 2.0
    # breaking-changes page. Desired state must say so explicitly, and must not
    # be allowed to say `false` quietly.
    for k in ["n8n-block-env-access-in-node",
              "n8n-enforce-settings-file-permissions",
              "n8n-git-node-disable-bare-repos"]:
        v = opts.get(k)
        if not missing(v) and v is not True:
            errors.append(f":{k} must be true")

    # --- deprecated spellings ----------------------------------------------
    # WEBHOOK_URL is a deprecated alias of N8N_WEBHOOK_URL from n8n 2.35.0.
    # Every secondary source still names the old one, so refuse it by name
    # rather than letting it render into a deprecation warning nobody reads.
    if not missing(opts.get("webhook-url")):
        errors.append(":webhook-url is the deprecated spelling; n8n 2.35.0+ uses "
                      ":n8n-webhook-url (derived from :n8n-host here, so remove the key)")
    if not missing(opts.get("n8n-runners-enabled")):
        errors.append(":n8n-runners-enabled is deprecated from n8n 2.0; remove the key")
    for k in ["n8n-config-files", "queue-worker-max-stalled-count",
              "n8n-available-binary-data-modes"]:
        if not missing(opts.get(k)):
            errors.append(f":{k} was removed in n8n 2.0; remove the key")
    # n8n 2.0 dropped MySQL and MariaDB. There is no key that could select them
    # here, but a stale colors.yml carrying one should say why.
    if _s(opts.get("db-type")).lower() in ("mysql", "mariadb", "mysqldb"):
        errors.append(":db-type mysql/mariadb support was removed in n8n 2.0")

    # --- soak thresholds ----------------------------------------------------
    percentages = [n for n in (_as_int(opts.get(k)) for k in
                               ["n8n-soak-mix-api-percent", "n8n-soak-mix-code-node-percent",
                                "n8n-soak-mix-binary-percent"])
                   if n is not None]
    if len(percentages) == 3 and sum(percentages) != 100:
        errors.append(":n8n-soak-mix-* percentages must sum to 100")
    for k in ["n8n-soak-max-host-memory-percent", "n8n-soak-max-disk-percent"]:
        n = _as_int(opts.get(k))
        if n is not None and not 1 <= n <= 100:
            errors.append(f":{k} must be a percentage between 1 and 100")

    # Restricting the origin to Cloudflare's ranges and NOT proxying the record
    # are mutually exclusive, and the failure is silent until the certificate
    # is needed: Caddy answers the ACME HTTP-01 challenge on :80, and with the
    # record unproxied that challenge arrives from Let's Encrypt's own
    # addresses, which the firewall drops. The converge then succeeds, and the
    # first HTTPS request fails on a certificate that was never issued.
    # Proxied, the challenge arrives from a Cloudflare address and is admitted.
    if (_s(opts.get("vultr-http-sources")) == "cloudflare"
            and opts.get("cloudflare-proxied") is not True):
        errors.append(":vultr-http-sources cloudflare requires :cloudflare-proxied true, "
                      "or ACME HTTP-01 is firewalled off and no certificate is ever issued")

    if not (missing(opts.get("r2-credential-sharing"))
            or _s(opts.get("r2-credential-sharing")) in ("split", "shared-accepted")):
        errors.append(":r2-credential-sharing must be split or shared-accepted")

    os_id = opts.get("vultr-os-id")
    if not (missing(os_id) or (isinstance(os_id, int) and not isinstance(os_id, bool))):
        errors.append(":vultr-os-id must be Vultr's numeric operating-system id")
    return errors


def backend_secrets(opts: dict) -> list[str]:
    entry = once_providers["provider-backend"].get(str(opts.get("provider-backend")), {})
    return entry.get("secrets", [])


# What talking to the providers needs, on any real event.
provider_secrets = ["vultr-api-key", "cloudflare-api-token"]

# What converging the machine needs, and therefore only a create.
#
# The database role passwords, the n8n owner password and the task-runner auth
# token are deliberately absent: all three are generated on the server, once,
# and are never supplied by the operator. The encryption key is the opposite —
# it must outlive the host, so it is the operator's to hold and escrow.
application_secrets = ["n8n-encryption-key"]


def r2_secret_errors(opts: dict) -> list[str]:
    """The Neon remote-storage pair, honouring the split/shared fallback."""
    effective = effective_r2(opts)
    access, secret = effective["access-key-id"], effective["secret-access-key"]
    split = effective["split"]
    if missing(access) and missing(secret):
        return [f"required credential is not set: {par_name('neon-r2-access-key-id')}"
                f" (or the shared {par_name('r2-access-key-id')} pair)"]
    if missing(access):
        key = "neon-r2-access-key-id" if split else "r2-access-key-id"
        return [f"required credential is not set: {par_name(key)}"]
    if missing(secret):
        key = "neon-r2-secret-access-key" if split else "r2-secret-access-key"
        return [f"required credential is not set: {par_name(key)}"]
    return []


def secret_errors(opts: dict, event: str) -> list[str]:
    """Credentials a real event needs. A delete tears down infrastructure and
    never converges anything, so it asks for the provider credentials only."""
    keys = [*provider_secrets,
            *(application_secrets if event == "create" else []),
            *backend_secrets(opts)]
    errors = [f"required credential is not set: {par_name(k)}"
              for k in dict.fromkeys(keys) if missing(opts.get(k))]
    if event != "create":
        return errors
    errors += r2_secret_errors(opts)

    # Blast radius, enforced rather than merely observed.
    #
    # This package already refuses to let backups share a BUCKET with state or
    # live data. Letting them silently share a CREDENTIAL was the same property
    # enforced on one axis and ignored on the other -- which is worse than
    # enforcing neither, because the visible rule implies the invisible one is
    # handled too.
    #
    # Measured on a live host: the shared pair could list, write and DELETE in
    # the OpenTofu state bucket and delete backup sets. A backup a compromised
    # host can erase is not a backup, and the host has no legitimate reason to
    # touch state at all.
    #
    # The shared pair stays reachable, because a first converge may predate the
    # scoped tokens -- but only as a DELIBERATE, committed choice that shows up
    # in a colors.yml diff, never as a silent default.
    if not backup_credential_scoped(opts) and not credential_sharing_accepted(opts):
        errors.append(
            "backups would use the same R2 credential as OpenTofu state and live "
            f"Neon data. Supply {par_name('n8n-backup-r2-access-key-id')}"
            f" and {par_name('n8n-backup-r2-secret-access-key')}"
            " scoped to the backup bucket alone, or set "
            ":r2-credential-sharing: shared-accepted in colors.yml to record "
            "that the blast radius is accepted")
    if not effective_r2(opts)["split"] and not credential_sharing_accepted(opts):
        errors.append(
            "live Neon data would use the same R2 credential as OpenTofu state. "
            f"Supply {par_name('neon-r2-access-key-id')} and "
            f"{par_name('neon-r2-secret-access-key')}"
            " scoped to the data bucket alone, or set "
            ":r2-credential-sharing: shared-accepted in colors.yml")
    # n8n requires at least 32 characters. A shorter key is accepted by n8n
    # itself and then silently weakens every credential in the database.
    if (not missing(opts.get("n8n-encryption-key"))
            and len(_s(opts.get("n8n-encryption-key"))) < 32):
        errors.append(f"{par_name('n8n-encryption-key')} must be at least 32 characters")
    return errors


def tofu_env(opts: dict, slot: str) -> dict[str, str]:
    if slot == "provider-compute":
        return {"vultr-api-key": "VULTR_API_KEY"}
    if slot == "provider-dns":
        return {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"}
    if slot == "provider-backend":
        entry = once_providers["provider-backend"].get(str(opts.get("provider-backend")), {})
        return entry.get("tofu-env", {})
    return {}
