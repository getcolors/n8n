# CLAUDE.md

Guidance for agents working in this repository. Read
`~/code/getcolors/CLAUDE.md` first for the cross-repository conventions; this
file covers only what is specific to `n8n`.

## What this is

A green-only Package Skill: n8n on one Vultr instance, backed by a colocated
self-hosted Neon storage tier, behind Caddy, with an external task runner.

## The one structural thing to understand

**This package renders another package's templates.** `green/deps.edn` SHA-pins
`io.github.getcolors/neon`, and because that repository publishes
`:paths ["src/clj" "src/resources"]`, its Ansible templates resolve as
namespaced keyword resources off the classpath. `tools/neon-specs` renders
twelve of them into a `neon/` subdirectory of the ansible stage.

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
- **The upstream play reads `COLORS_PAR_NEON_R2_*`** via `lookup('env')`. The
  deployment's `.envrc` maps whatever pair is configured onto exactly those
  names.
- **The upstream play owns the database credential.** It generates the role
  password at `/etc/neon/secrets/neon_role_password`; never mint a second one.

A `neon` pin bump must pass `bb golden` (which renders the merged tree), the
merged-Compose assertions, and the drills before the recorded SHA moves.

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

## Testing

```sh
cd green && bb test        # validator and rendering rules
./scripts/golden.sh        # two fixtures: keygen and ssh-keypair opt-out
./scripts/syntax.sh        # offline playbook syntax
```

Read a golden diff after a pin bump; never `golden.sh --accept` merely to make
it pass.

## Working across the boundary

`N8N_LIB_ROOT=/path/to/n8n` points a deployment's launcher at a working tree.
`NEON_LIB_ROOT` does the same for the storage tier. Use these while developing;
land real pushed SHAs before pinning.
