# CLAUDE.md

Guidance for agents working in this repository. Read
`~/code/getcolors/CLAUDE.md` first for the cross-repository conventions; this
file covers only what is specific to `n8n`.

## What this is

A tri-colour Package Skill (green, red, blue): n8n on one Vultr instance or
one AWS EC2 instance, backed by a colocated self-hosted Neon storage tier
whose layers and WAL live in Cloudflare R2 or Amazon S3, behind Caddy, with an
external task runner.

Green is canonical. A behavioural change lands in all three colours in the same
commit and passes `scripts/parity.sh`, which renders both fixtures through
every colour and diffs the trees — and the colour template trees
(`red/resources`, blue's embedded `resources/`), byte for byte. There are
three fixtures: Vultr keygen, Vultr opt-out, and AWS with a managed S3 state
bucket and managed storage. Fixtures and
goldens are shared at the repository root (`test/fixtures/`,
`test/resources/golden/`) with symlinks from `green/test/`. Each colour
directory holds a launcher symlink to its skill payload.

## The one structural thing to understand

**This package renders another package's templates.** All three colours
SHA-pin `getcolors/neon` and render twelve of its application Ansible templates into a `neon/` subdirectory of the ansible stage. These application templates are not copied. The local SSH updater is package-owned, as required by the workspace standard.

Each colour reaches them its own way, and all three must resolve the *same*
commit:

| Colour | Pin | How the templates are read |
|---|---|---|
| green | `green/deps.edn` | `neon`'s `deps.edn` publishes `src/resources`, so they resolve as namespaced keyword resources off the classpath |
| red | `red/package.json` and root `package.json` | `neon`'s `package.json` publishes `red/resources` in `files`; `red/src/neon.ts` resolves the package entry and reads them from disk |
| blue | `blue/pyproject.toml` and the payload's PEP 723 block | the wheel ships them under `package_neon_blue/resources/`; `tools.py` reads them from `Path(package_neon_blue.__file__).parent` |

`scripts/launcher.sh` checks that the dependency manifests carry the same Neon pin. A `neon`
pin bump must pass `bb golden`, `scripts/parity.sh`, the merged-Compose
assertions, and the drills before the recorded SHAs move — in every dependency manifest together.

Consequences that are easy to get wrong:

- **`colors.yml` speaks neon's key vocabulary** (`neon-r2-bucket`,
  `neon-tenant-id`, …). Renaming those to `n8n-*` would fork the templates by
  the back door.
- **The overlay is `compose.override.yml`, never `-f`.** The upstream play runs
  `docker compose` with `chdir: /opt/neon` and no file flags; an overlay passed
  on the command line would be invisible to every upstream task and handler.
- **`name: neon` is declared once**, in the upstream compose. The overlay omits
  it, or merged and unmerged commands act on different projects.
- **The upstream bundle renders into its own directory** because that play
  copies templates by *relative* `src:` name; a same-named file beside it wins.
  `cleanup.yml` is exactly such a name, and the red and blue suites assert the
  rendered bytes are the dependency's rather than this package's.
- **The upstream play reads `COLORS_PAR_NEON_R2_*`** via `lookup('env')`. The
  deployment's `.envrc` maps whatever pair is configured onto exactly those
  names. With `n8n-storage-managed: true` the storage stage supplies them
  instead, in the Ansible subprocess environment only (`storage/credential-env`
  in green); they are never rendered.
- **The upstream play owns the database credential.** It generates the role
  password at `/etc/neon/secrets/neon_role_password`; never mint a second one.

## Secrets never reach rendered output

Operator credentials reach the host as Ansible `lookup('env', …)` expressions
written literally into the play — `preserve-jinja-delimiters` passes them
through. Generated secrets are read on the host from `/etc/neon/secrets/` and
`/etc/n8n/secrets/` and delivered to containers through `env_file`, never as
values in a compose file.

Two traps behind that, both paid for:

- `ansible.builtin.copy` with `src:` does **not** template. An inline
  `{{ lookup(...) }}` is copied through literally and the container
  authenticates with that string.
- An Ansible lookup runs on the **controller**. `/etc/neon/secrets/` exists only
  on the host, so `lookup('file', …)` could never read it.

## Shell in playbooks

Ansible splits a shell task's arguments before running anything, counting brace
pairs and quotes across the whole block *including comments*. Anything with
nested quoting fails at load time with `failed at splitting arguments`, naming
the task rather than the character.

**If a shell task needs quoting, put it in a script the play installs and
calls.** `./scripts/syntax.sh` runs `ansible-playbook --syntax-check` on the
rendered tree offline; run it before any converge.

## Backups have their own remote

`n8n-env.sh` defines two rclone remotes: `store` for the Neon bucket, read
with the pair neon's play installs at `/etc/neon/r2.env`, and `backup` for
the backup bucket, read with the pair this package's play installs at
`/etc/colors/backup-r2.env` from `COLORS_PAR_N8N_BACKUP_R2_*`. The provider
flips from `Cloudflare` to `AWS` on an `amazonaws.com` endpoint. An empty
backup pair is a refusal unless desired state records
`r2-credential-sharing: shared-accepted`, in which case the backup remote
falls back to the Neon pair and the smoke gate prints `RISK`. With its own
pair the gate lists the Neon bucket with it and fails on success.

## The origin ingress list is fetched, not stored

`vultr-http-sources: cloudflare` is a symbolic source the package *resolves* at
render time, from `https://www.cloudflare.com/ips-v4` and `-v6`, recording the
resolved set and a checksum in `http-sources.json`. A failed fetch falls back to
the list committed in each colour's `tools` module and never widens.

That fetch is the one place the colours can disagree on identical desired state,
and it did: Cloudflare answers Python's default `Python-urllib/3.x` with 403, so
blue silently rendered `origin: "fallback"` while green and red rendered
`"fetched"`. Red and blue now send an explicit `colors-n8n` User-Agent. Keep the
fallback lists identical across the three colours; parity diffs the rendered
`http-sources.json`, not the list.

## Testing

```sh
cd green && bb test        # validator, storage, workflow, and rendering rules
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/golden.sh        # green, three fixtures: keygen, ssh-keypair opt-out, aws
./scripts/parity.sh        # three colours, three fixtures, byte for byte
./scripts/launcher.sh      # the three payloads, and green end to end from a copy
./scripts/syntax.sh        # offline playbook syntax
```

Read a golden diff after a pin bump; never `golden.sh --accept` merely to make
it pass.

## Working across the boundary

`N8N_LIB_ROOT=/path/to/n8n` points a deployment's launcher at a working tree, in
every colour — red also accepts the `red/` directory directly, and blue accepts
either the repository root or `blue/`. Use it while developing; land real pushed
SHAs before pinning. `bb pin` stamps all three payloads from a clean, pushed
HEAD.

To develop against a `neon` working tree the pin has to move — none of the three
colours reads a `NEON_LIB_ROOT`, and the README and this file should not claim
otherwise.

## Compute and SSH ownership

The package depends on `colors-compute` at `ae28ea74962bb1897fa6365c143c1d43ac1fe095` (recorded in `green/deps.edn`; `red/package.json`, the root `package.json`, and `blue/pyproject.toml` each record their own copy and must carry the same SHA) and Neon application templates at `e19a213067d307b55d1b37a2e83cdc1a150b7d91`. Compute uses the same singleton library workflow as cluster fan-out, on Vultr or AWS. R2/S3 state uses `<profile>/compute/shared.tfstate`, `<profile>/compute/nodes/0.tfstate`, and the deployment journal. Existing `<profile>/n8n-infrastructure.tfstate` requires explicit migration and is refused automatically. DNS stays in its separate existing state, and managed storage in `<profile>/n8n-storage.tfstate`.

Create runs compute, the storage stage when `n8n-storage-managed` is true, DNS, profile SSH alias, application convergence, then acceptance. Delete first inspects owned compute, stops the application, removes the alias, removes DNS, removes the managed buckets, destroys compute, and with `s3-bucket-mode: managed` finalizes the state bucket last; a delete that finds no live compute under a managed state bucket runs only that finalization. The library manages generated keys and registration cleanup. External private paths are explicit Ansible and acceptance SSH inputs. Managed aliases add `IdentityFile ~/.ssh/<profile>`; external aliases do not.

The neutral `n8n-ssh-sources` and `n8n-http-sources` options take precedence over library-resolved legacy provider options. The symbolic HTTP value `cloudflare` retains the fetched ranges and checksum report; on AWS it resolves to the IPv4 ranges only, because the adapter takes IPv4 sources. A real create refuses a failed fetch; build can use the reviewed fallback. No cloud resources were created while validating this migration.

Validated retired compute prevents remote Ansible during delete even when caller input retains a stale IP or private-key path. Remaining application and local cleanup keeps its existing ordering. Normal creation still converges the application.
