# CLAUDE.md

Guidance for agents working in this repository. Read
`~/code/getcolors/CLAUDE.md` first for the cross-repository conventions; this
file covers only what is specific to `n8n`.

## What this is

A tri-colour Package Skill (green, red, blue): n8n on one Vultr instance,
backed by a colocated self-hosted Neon storage tier, behind Caddy, with an
external task runner.

Green is canonical. A behavioural change lands in all three colours in the same
commit and passes `scripts/parity.sh`, which renders both fixtures through
every colour and diffs the trees — and the colour template trees
(`red/resources`, blue's embedded `resources/`) — byte for byte. Fixtures and
goldens are shared at the repository root (`test/fixtures/`,
`test/resources/golden/`) with symlinks from `green/test/`. Each colour
directory holds a launcher symlink to its skill payload.

## The one structural thing to understand

**This package renders another package's templates.** All three colours
SHA-pin `getcolors/neon` and render twelve of its Ansible templates, plus the
three `ansible-local` ones, into a `neon/` subdirectory of the ansible stage.
Nothing is copied into this repository.

Each colour reaches them its own way, and all three must resolve the *same*
commit:

| Colour | Pin | How the templates are read |
|---|---|---|
| green | `green/deps.edn` | `neon`'s `deps.edn` publishes `src/resources`, so they resolve as namespaced keyword resources off the classpath |
| red | `red/package.json` and the `PINS` map in the red payload | `neon`'s `package.json` publishes `red/resources` in `files`; `red/src/neon.ts` resolves the package entry and reads them from disk |
| blue | `blue/pyproject.toml` and the payload's PEP 723 block | the wheel ships them under `package_neon_blue/resources/`; `tools.py` reads them from `Path(package_neon_blue.__file__).parent` |

`scripts/launcher.sh` checks that the four recorded neon pins agree. A `neon`
pin bump must pass `bb golden`, `scripts/parity.sh`, the merged-Compose
assertions, and the drills before the recorded SHAs move — in all four places
at once.

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
  names.
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
cd green && bb test        # validator and rendering rules
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/golden.sh        # green, two fixtures: keygen and ssh-keypair opt-out
./scripts/parity.sh        # three colours, two fixtures, byte for byte
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
