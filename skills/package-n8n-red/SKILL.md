---
name: package-n8n-red
description: Provision and manage a self-hosted n8n workflow automation instance on one Vultr instance, backed by a colocated self-hosted Neon (storage/compute-separated Postgres with layers and WAL in Cloudflare R2), behind Caddy TLS with an external task runner — using OpenTofu and Ansible. Use when asked to deploy, converge, inspect or tear down self-hosted n8n, to run n8n on Postgres rather than SQLite, to put n8n's database on object storage, or to work on a colors.yml for an n8n deployment.
---

# n8n Package Skill (Red)

Provisions one Vultr instance running n8n 2.36.9 behind Caddy, with an external
task runner, backed by a **colocated self-hosted Neon** storage tier — storage
broker, pageserver, one safekeeper, and a Postgres 17 compute node — whose
layers and WAL live in Cloudflare R2.

The Neon tier is not reimplemented here. This package SHA-pins
[`getcolors/neon`](https://github.com/getcolors/neon) and renders its Ansible
templates straight off the classpath, so there is no second copy of the storage
tier to drift.

## Install the launcher

```sh
npx skills add getcolors/n8n
cp .agents/skills/package-n8n-red/red ./red
chmod +x red
```

The root `red` is a **copy** of the payload, not a symlink. `npx skills
update -p` rewrites the payload and leaves the copy alone, so copy it again
after every update or the project keeps running the old pin.

## Verbs

```sh
./red build              # render .colors/<profile>/ — no provider calls, no credentials
./red create --dry-run   # walk the workflow, skip every side effect
./red create             # converge for real
./red delete             # guarded by compute-prevent-destroy
```

`build` and `--dry-run` work on a fresh checkout with an empty environment.
Exit code 2 means validation failure and lists every problem at once.

## Credentials

Non-secret desired state lives in `colors.yml`. Every credential is a
`COLORS_PAR_*` environment variable, conventionally in a gitignored
`.envrc.private`:

| Variable | For |
|---|---|
| `COLORS_PAR_VULTR_API_KEY` | instance, firewall, SSH key resource |
| `COLORS_PAR_CLOUDFLARE_API_TOKEN` | the DNS record; needs Zone:Read + DNS:Edit |
| `COLORS_PAR_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | OpenTofu state |
| `COLORS_PAR_NEON_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | Neon layers and WAL (falls back to the pair above) |
| `COLORS_PAR_N8N_BACKUP_R2_*` | backups, scoped to the backup bucket alone |
| `COLORS_PAR_N8N_ENCRYPTION_KEY` | **≥32 chars, not regenerable** — see below |

Never export `COLORS_PAR_PROFILE`: it selects the deployment's remote state.

### Three buckets, three credentials

The package refuses to converge when one R2 credential would reach OpenTofu
state, live Neon data and backups alike. Measured on a live host, that pair
could list, write and **delete** in the state bucket and delete backup sets —
and a backup a compromised host can erase is not a backup.

Mint bucket-scoped R2 tokens (Object Read & Write on exactly one bucket each)
for `COLORS_PAR_NEON_R2_*` and `COLORS_PAR_N8N_BACKUP_R2_*`; `COLORS_PAR_R2_*`
then has one job, OpenTofu state, and never leaves your workstation. A first
converge that predates those tokens can set
`r2-credential-sharing: shared-accepted` — but only as a deliberate line in
committed desired state, visible in a diff, and the acceptance gate then
reports `RISK` on every run rather than a quiet skip.

R2 has no write-only mode, so even a scoped backup credential can delete what
it writes. Bucket versioning or an immutability policy closes that, and is a
Cloudflare-side setting rather than anything this package can converge.

The database role password, the n8n owner password and the task-runner token are
**generated on the server** and are not operator credentials; read them over SSH
from `/etc/neon/secrets/` and `/etc/n8n/secrets/`.

### The encryption key outlives the host

`N8N_ENCRYPTION_KEY` encrypts every credential n8n stores. n8n writes it into
`/home/node/.n8n/config` on **first boot** and refuses to start ever after if
the environment disagrees — so one bad first boot poisons the data directory,
and the error appears on the *next* boot rather than the one that caused it.
Keep a copy somewhere that is not this machine before the first converge.

## What convergence guarantees

Acceptance gates run on every converge and fail it if they fail:

- the Neon tenant and timeline in desired state are the ones attached
- pageserver objects exist in R2, and a **new** safekeeper segment appears after
  `pg_switch_wal()` — historical objects cannot satisfy the gate
- a workflow created through the public API is read back **out of Neon**
- `DB_TYPE=postgresdb` in the running container and no SQLite file on disk
- the migration table matches the pinned image
- liveness *and* readiness (they differ; readiness is the one that gates on the database)
- the origin certificate, and that the origin refuses non-Cloudflare traffic
- the generated production webhook URL
- the owner account is claimed — before the public name ever resolves
- a Code node **executes** on the external runner
- sshd rejects password and root-password authentication

Drills that are not part of every converge:

```sh
ssh <profile> /opt/neon/n8n-smoke.sh          # the gates above
ssh <profile> /opt/neon/n8n-soak.sh           # C1 load, declared thresholds
ssh <profile> /opt/neon/n8n-rehearsal.sh      # R3 restore into an isolated stack
ssh <profile> /opt/neon/n8n-prune-drill.sh    # C2 retention, isolated
ssh <profile> /opt/neon/n8n-restart-drill.sh recreate
```

## Recovery

Neon streams WAL to R2 continuously, but a **rebuilt safekeeper does not recover
its offloaded WAL** — the walproposer bootstraps it from the compute basebackup.
So a destroyed host falls back to the logical backup set, and the backup
*interval* is the real RPO. It defaults to six hours, not nightly.

| Failure | Recovers from | RPO |
|---|---|---|
| pageserver local state lost | R2 layers + safekeeper replay | ~0 |
| compute lost | recreate from pageserver | ~0 |
| **whole host lost** | the backup set in R2 | one backup interval |

`n8n-rehearsal.sh` proves the whole path: restore both artifacts into an
isolated scratch stack, boot the pinned image, log in, and execute a workflow
whose node carries a stored credential — because a credential's value cannot be
read back to test decryption, only used.

## Configuration reference

See [references/configuration.md](references/configuration.md).
