# n8n

A tri-colour Package Skill (green, red, blue) that provisions **n8n workflow
automation on one Vultr instance, backed by a colocated self-hosted Neon** — storage/compute-separated
Postgres whose layers and WAL live in Cloudflare R2 — behind Caddy TLS, with
n8n's Code nodes isolated in an external task runner.

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

Neon uploads WAL to R2 continuously, but a **rebuilt safekeeper does not recover
its offloaded WAL**; the walproposer bootstraps it from the compute basebackup.
A destroyed host therefore falls back to the logical backup set, and the backup
*interval* is the RPO — six hours by default.

`n8n-rehearsal.sh` rehearses it end to end: restore both artifacts into an
isolated scratch stack, boot the pinned image, prove an operator can log in, and
execute a workflow whose node carries a stored credential. That last step is the
only way to prove the encryption key survived — n8n redacts credential values in
API responses, so reading one back and comparing can never work.

## Tests

```sh
cd green && bb test                        # validator and rendering rules
cd red   && bun test && bun run typecheck
cd blue  && uv run pytest
./scripts/golden.sh        # green, both SSH-keypair modes, byte for byte
./scripts/parity.sh        # three colours, two fixtures, byte for byte
./scripts/launcher.sh      # the three payloads, and green end to end from a copy
./scripts/syntax.sh        # ansible-playbook --syntax-check on the rendered tree
cd green && bb pin         # stamp all three launchers after a push
```

## Licence

MIT.
