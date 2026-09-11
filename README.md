# n8n

A tri-colour Package Skill (green, red, blue) that provisions **n8n workflow
automation on one Vultr instance or one AWS EC2 instance, backed by a
colocated self-hosted Neon**, a storage/compute-separated Postgres whose layers
and WAL live in Cloudflare R2 or Amazon S3, behind Caddy TLS, with n8n's Code
nodes isolated in an external task runner.

n8n is normally run on SQLite (fine until two workflows finish at once) or on a
colocated Postgres. This runs it on Neon instead, which means the database's
durable copy is object storage rather than the instance's disk.

## The interesting claim, and the measurement

Storage/compute separation is usually assumed to be too slow for an OLTP write
pattern, and n8n writes an execution row per run. Measured on a
`vhp-8c-16gb-amd`, with a declared workload mix (API-shaped, Code nodes at 8 MB
to trigger n8n's payload duplication, and binary payloads through the
filesystem path):

| Measure | Result | Gate |
|---|---|---|
| executions in 5 minutes | **7950**, 0 failed | ≥ 500 |
| SQL round-trip p95 / p99 | **75 ms / 80 ms** | 150 / 500 |
| host memory / disk | 12% / 9% | ≤ 85% / 80% |

Reproduced across two independent runs with identical percentiles. The p95→p99
gap of 5 ms is the point: the split adds no visible tail latency at this rate.

Honest scope: five minutes, one host, ten concurrent workflows. It does not
establish behaviour over days or during a pageserver restart under load.

## Install

Three implementations of one model — Clojure/Babashka, TypeScript/Bun,
Python/uv — rendering byte-identical output. Pick one:

```sh
npx skills add getcolors/n8n
cp .agents/skills/package-n8n-green/green ./green   # or -red/red, or -blue/blue
chmod +x green
```

The launcher in your project root is a **copy**, not a symlink. After
`npx skills update -p`, copy it again or the project keeps running the old pin.

## Use

```sh
./green build              # render .colors/<profile>/ — offline, no credentials
./green create --dry-run   # walk the workflow, skip every side effect
./green create             # converge for real
./green delete             # guarded by compute-prevent-destroy
```

`./red` and `./blue` take the same verbs and the same `colors.yml`, and
`scripts/parity.sh` is what makes "the same" a checked claim rather than an
intention: both fixtures through all three colours, diffed byte for byte.

`colors.yml` is the only file you edit. Exit code 2 lists every validation
problem at once.

## AWS with managed S3 storage

`provider-compute: aws` provisions one EC2 instance through the colors-compute
AWS adapter, in its own VPC, subnet, and security group, with the profile-named
regional keypair and Ubuntu's `ubuntu` login. `provider-backend: s3` keeps
OpenTofu state in S3, and `s3-bucket-mode: managed` makes that bucket the
deployment's own: created before the first state read, finalized after an
authorized delete has destroyed everything else.

`n8n-storage-managed: true` adds an `n8n-storage` OpenTofu stage between
compute and DNS. It creates the Neon bucket and the backup bucket, each with a
public-access block, AES256 encryption, and one IAM user whose policy reaches
that bucket alone, and it refuses to adopt a bucket that already exists. The
two access keys come out of the stage's sensitive output and reach the
converge as `COLORS_PAR_NEON_R2_*` and `COLORS_PAR_N8N_BACKUP_R2_*` in the
Ansible subprocess environment only. Nothing renders them and the operator
never holds them, so the three-credential rule below is satisfied by
construction and `r2-credential-sharing` is not required.

The `*-r2-*` keys keep their names on AWS, because they are the vocabulary of
the `getcolors/neon` templates this package renders; they carry the regional
S3 endpoint and region. AWS credentials come from the ambient chain: the
deployment's `.envrc` maps `COLORS_PAR_AWS_ACCESS_KEY_ID` and
`COLORS_PAR_AWS_SECRET_ACCESS_KEY` onto `AWS_*`.

Delete on AWS runs the stages in reverse: stop the host, remove the SSH alias
and the DNS record, empty and remove the two application buckets and their
IAM users, destroy compute, then finalize the state bucket. On R2 desired
state, delete leaves every bucket untouched; on managed S3 the destruction
override authorizes removing the Neon data and every backup set too.

## No second copy of the storage tier

The Neon tier is not reimplemented here. This package SHA-pins
[`getcolors/neon`](https://github.com/getcolors/neon) as a dependency and
renders its Ansible templates straight out of it — `compose.yml`, `main.yml`,
`pageserver.toml`, the compute spec, the bootstrap and rotation scripts — with
no file copied into this repository.

Each colour reaches the same templates its own way — green off the classpath,
red out of the installed package's `red/resources`, blue out of
`package_neon_blue/resources` — and all three pin the same commit, which
`scripts/launcher.sh` checks.

Two mechanics make that work. n8n's own services arrive as a Compose
**override** installed beside the upstream `compose.yml`, so every unchanged
upstream command operates on the one merged project without any `-f` flags. And
the imported play targets `hosts: neon` while this package's targets
`hosts: n8n`, with the single host in both inventory groups.

The trade is real coupling: bumping the `neon` pin can break this package. That
is deliberate — `bb golden` renders the merged tree, so a pin bump shows up as a
reviewable diff instead of a surprise on a host.

## Recovery, stated honestly

Neon uploads WAL to the Neon bucket continuously, but a **rebuilt safekeeper does not recover
its offloaded WAL**; the walproposer bootstraps it from the compute basebackup.
A destroyed host therefore falls back to the logical backup set, and the backup
*interval* is the RPO — six hours by default.

`n8n-rehearsal.sh` rehearses it end to end: restore both artifacts into an
isolated scratch stack, boot the pinned image, prove an operator can log in, and
execute a workflow whose node carries a stored credential. That last step is the
only way to prove the encryption key survived — n8n redacts credential values in
API responses, so reading one back and comparing can never work.

The backup set lives in its own bucket, reached through its own rclone remote
with its own credential. `n8n-backup-r2-endpoint` and `n8n-backup-r2-region`
default to the Neon bucket's, so an R2 deployment carries neither key; on AWS
both name the regional S3 endpoint. The converge refuses an empty backup
credential unless `r2-credential-sharing: shared-accepted` is recorded, and
when the credential is its own the smoke gate proves it cannot list the Neon
bucket.

## Tests

```sh
cd green && bb test                        # validator and rendering rules
cd red   && bun test && bun run typecheck
cd blue  && uv run pytest
./scripts/golden.sh        # green: both SSH-keypair modes on Vultr, and AWS with managed S3
./scripts/parity.sh        # three colours, three fixtures, byte for byte
./scripts/launcher.sh      # the three payloads, and green end to end from a copy
./scripts/syntax.sh        # ansible-playbook --syntax-check on the rendered tree
cd green && bb pin         # stamp all three launchers after a push
```

## Licence

MIT.

Compute lifecycle and remote state are delegated to `colors-compute`; the package keeps its Neon+n8n application templates, DNS stage, storage stage, credential-scope checks, and acceptance gates. Compute runs on Vultr or AWS, requires R2 or S3, and owns `<profile>/compute/{shared,nodes/0}.tfstate` plus a journal. Legacy `<profile>/n8n-infrastructure.tfstate` is refused for explicit migration. The package owns its locked SSH alias updater; it removes the alias before compute destruction and writes IdentityFile only for managed keys. External private paths are passed explicitly to Ansible and acceptance SSH. Build and dry-run do not read local SSH files.
