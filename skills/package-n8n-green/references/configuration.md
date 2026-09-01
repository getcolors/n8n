# Configuration reference

Every key `colors.yml` may carry. Non-secret values only: credentials are
`COLORS_PAR_*` environment variables, never keys here.

Defaults shown are the package's own `colors.yml`, which is a working example
rather than a template — a fresh deployment edits it rather than filling
blanks.

## Identity and providers

| Key | Example |
|---|---|
| `profile` | `n8n` |
| `workdir` | `.colors` |
| `provider-compute` | `vultr` |
| `provider-dns` | `cloudflare` |
| `provider-backend` | `r2` |
| `compute-prevent-destroy` | `true` |

## n8n application

| Key | Example |
|---|---|
| `n8n-image` | `docker.io/n8nio/n8n:2.36.9@sha256:a9e2e3c8006ed453238266669ea1274…` |
| `n8n-runners-image` | `docker.io/n8nio/runners:2.36.9@sha256:99811ba57933dd77895f5fedbb5…` |
| `n8n-host` | `n8n.example.com` |
| `n8n-port` | `5678` |
| `n8n-owner-email` | `operator@example.com` |
| `n8n-proxy-hops` | `2` |
| `n8n-data-dir` | `/var/lib/n8n/data` |
| `n8n-timezone` | `Europe/Amsterdam` |
| `n8n-binary-data-mode` | `filesystem` |
| `n8n-concurrency-production-limit` | `10` |
| `n8n-executions-data-max-age` | `336` |
| `n8n-executions-data-prune-max-count` | `10000` |
| `n8n-block-env-access-in-node` | `true` |
| `n8n-enforce-settings-file-permissions` | `true` |
| `n8n-git-node-disable-bare-repos` | `true` |
| `n8n-restrict-file-access-to` | `/home/node/.n8n-files` |

## Storage tier (neon vocabulary)

| Key | Example |
|---|---|
| `neon-image` | `ghcr.io/neondatabase/neon:release-9129@sha256:166022a72bf9983eba9…` |
| `neon-compute-image` | `ghcr.io/neondatabase/compute-node-v17:release-compute-9073@sha256…` |
| `neon-pg-version` | `17` |
| `neon-tenant-id` | `7b3c1e94a05d42f8b6c9e2417d580a3f` |
| `neon-timeline-id` | `4f8a2d61c93b47e0a5d8f1620b7c94e3` |
| `neon-database` | `n8n` |
| `neon-role` | `n8n` |
| `neon-r2-bucket` | `n8n-storage-example` |
| `neon-r2-endpoint` | `https://319271fed8bc6d2d9059362be1165f37.eu.r2.cloudflarestorage.com` |
| `neon-r2-region` | `auto` |
| `neon-r2-prefix` | `n8n/data` |

## Backups

| Key | Example |
|---|---|
| `n8n-backup-r2-bucket` | `n8n-backup-example` |
| `n8n-backup-oncalendar` | `"*-*-* 00/6:00:00"` |
| `n8n-backup-retention-days` | `7` |
| `n8n-backup-dir` | `/var/backups/n8n` |

## Soak thresholds

| Key | Example |
|---|---|
| `n8n-soak-concurrent-workflows` | `10` |
| `n8n-soak-duration-seconds` | `300` |
| `n8n-soak-mix-api-percent` | `60` |
| `n8n-soak-mix-code-node-percent` | `25` |
| `n8n-soak-mix-binary-percent` | `15` |
| `n8n-soak-code-node-payload-mb` | `8` |
| `n8n-soak-binary-payload-mb` | `4` |
| `n8n-soak-max-p95-sql-roundtrip-ms` | `150` |
| `n8n-soak-max-p99-sql-roundtrip-ms` | `500` |
| `n8n-soak-max-p95-execution-ms` | `2000` |
| `n8n-soak-max-p99-execution-ms` | `8000` |
| `n8n-soak-min-executions-completed` | `500` |
| `n8n-soak-max-host-memory-percent` | `85` |
| `n8n-soak-max-disk-percent` | `80` |

## Public name and TLS

| Key | Example |
|---|---|
| `cloudflare-zone` | `example.com` |
| `cloudflare-record-name` | `n8n` |
| `cloudflare-proxied` | `true` |

## Compute

| Key | Example |
|---|---|
| `vultr-region` | `ams` |
| `vultr-plan` | `vhp-8c-16gb-amd` |
| `vultr-os-id` | `2284` |
| `vultr-ssh-sources` | `(list)` |
| `vultr-http-sources` | `cloudflare` |

## OpenTofu state

| Key | Example |
|---|---|
| `r2-bucket` | `tofu-state-example` |
| `r2-endpoint` | `https://319271fed8bc6d2d9059362be1165f37.eu.r2.cloudflarestorage.com` |

## Reverse proxy

| Key | Example |
|---|---|
| `caddy-image` | `docker.io/library/caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98e…` |

## Keys that are deliberately absent

- **`vultr-ssh-keys`** — supplying it selects SSH-keypair *opt-out* mode. Absent,
  the package generates and owns the profile-named keypair.
- **`vultr-name`** — the Compute Name Standard's optional override. Absent, the
  machine and its firewall are named after the profile.
- **`webhook-url`** — the deprecated spelling. n8n 2.35.0 replaced it with
  `N8N_WEBHOOK_URL`, which this package derives from `n8n-host`. The validator
  rejects the old key by name rather than letting it render into a deprecation
  warning nobody reads.

## Rules the validator enforces

Beyond presence and shape, `./green build` refuses:

- an image without a digest pin, and a `n8n-runners-image` whose version differs
  from `n8n-image` (upstream requires equality; a mismatch fails when a Code
  node first executes, long after the converge reports success)
- `n8n-binary-data-mode: default` — n8n's own default holds binary payloads in
  memory on a host that also runs the database
- a non-positive `n8n-concurrency-production-limit` — n8n defaults to `-1`,
  unbounded
- any of the three security keys set to `false` (all three default to `false`
  upstream, contradicting the 2.0 breaking-changes page)
- `vultr-http-sources: cloudflare` together with `cloudflare-proxied: false` —
  unproxied, the ACME HTTP-01 challenge arrives from Let's Encrypt's own
  addresses and is dropped by the firewall; the converge still succeeds and the
  first HTTPS request finds no certificate
- `n8n-proxy-hops` below 2 when proxied — Cloudflare, then Caddy
- a `neon-r2-bucket` equal to the state bucket, or a backup bucket equal to
  either — blast radius
- keys removed in n8n 2.0: `n8n-config-files`,
  `queue-worker-max-stalled-count`, `n8n-available-binary-data-modes`
