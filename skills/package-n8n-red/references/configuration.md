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
| `provider-compute` | `vultr` or `aws` |
| `provider-dns` | `cloudflare` |
| `provider-backend` | `r2` or `s3` |
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
| `n8n-backup-r2-endpoint` | optional; defaults to `neon-r2-endpoint` |
| `n8n-backup-r2-region` | optional; defaults to `neon-r2-region` |
| `n8n-backup-oncalendar` | `"*-*-* 00/6:00:00"` |
| `n8n-backup-retention-days` | `7` |
| `n8n-backup-dir` | `/var/backups/n8n` |

The backup bucket has its own rclone remote on the host, read with the pair
installed at `/etc/colors/backup-r2.env`. Absent the two optional keys it
shares the Neon bucket's endpoint and region, which is what every existing R2
deployment renders.

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

## Compute on Vultr

| Key | Example |
|---|---|
| `vultr-region` | `ams` |
| `vultr-plan` | `vhp-8c-16gb-amd` |
| `vultr-os-id` | `2284` |
| `vultr-ssh-sources` | `(list)` |
| `vultr-http-sources` | `cloudflare` |

`n8n-ssh-sources` and `n8n-http-sources` are the provider-neutral spellings
and take precedence over the `vultr-*` ones on either provider.

## Compute on AWS

| Key | Example |
|---|---|
| `provider-compute` | `aws` |
| `aws-region` / `aws-availability-zone` | `us-east-1` / `us-east-1a` |
| `aws-image-id` | an available Ubuntu 24.04 amd64 AMI, e.g. `ami-025d99823a4caad37` |
| `aws-instance-type` | `t3.xlarge` |
| `aws-root-volume-size-gb` | `60` |
| `aws-vpc-cidr` / `aws-subnet-cidr` | `10.76.0.0/16` / `10.76.1.0/24` |
| `n8n-ssh-sources` | explicit IPv4 CIDRs |
| `n8n-http-sources` | `cloudflare` |

One EC2 instance in its own VPC and public subnet, logged into as `ubuntu`.
The AWS adapter takes IPv4 sources only: the symbolic `cloudflare` value
resolves to Cloudflare's IPv4 ranges there, and an explicit IPv6 CIDR is a
validation error. `aws-ssh-authorized-keys` selects SSH keypair opt-out mode
the way `vultr-ssh-keys` does.

## OpenTofu state

| Key | Example |
|---|---|
| `provider-backend` | `r2` or `s3` |
| `r2-bucket` | `tofu-state-example` (with `r2`) |
| `r2-endpoint` | `https://319271fed8bc6d2d9059362be1165f37.eu.r2.cloudflarestorage.com` (with `r2`) |
| `s3-bucket` / `s3-region` | a deployment-unique bucket / `us-east-1` (with `s3`) |
| `s3-bucket-mode` | `external` (default) or `managed` |

`s3-bucket-mode: managed` makes the state bucket the deployment's own: the
compute library creates it before the first remote state read, keeps every
stage's state under `<profile>/`, and removes it after an authorized delete
has destroyed everything else. It requires `provider-backend: s3`.

## Managed S3 storage

| Key | Example |
|---|---|
| `n8n-storage-managed` | `true` (default `false`) |

With `n8n-storage-managed: true` an `n8n-storage` OpenTofu stage creates the
Neon bucket (`neon-r2-bucket`) and the backup bucket
(`n8n-backup-r2-bucket`), each with a public-access block, AES256
encryption, and one IAM user whose policy reaches that bucket alone. The two
access keys are read from the stage's sensitive output and handed to the
converge as `COLORS_PAR_NEON_R2_*` and `COLORS_PAR_N8N_BACKUP_R2_*` in the
Ansible subprocess environment. They are never rendered and the operator
never holds them.

Managed storage requires `provider-compute: aws`, `provider-backend: s3`, an
AWS region in `neon-r2-region`, the same region for the backup bucket, and
S3-valid bucket names. Set both endpoints to the regional S3 endpoint, for
example `https://s3.us-east-1.amazonaws.com`. The `r2` in the key names is
historical; the neon vocabulary is kept so the upstream templates render
unchanged. The stage refuses to adopt a bucket that already exists: only a
bucket that answers 404 to a head-bucket probe, or one this stage already
tracks under the same name, passes.

Bucket lifecycle: the buckets are created with `force_destroy = true` and
`prevent_destroy` tied to `compute-prevent-destroy`. An authorized delete
removes their contents, the buckets, and the IAM users before the compute
destroy, and finalizes the managed state bucket last. That is unlike R2
desired state, where delete leaves every bucket untouched.

## Reverse proxy

| Key | Example |
|---|---|
| `caddy-image` | `docker.io/library/caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98e…` |

## Keys that are deliberately absent

- **`vultr-ssh-keys`** or **`aws-ssh-authorized-keys`**. Supplying it selects
  SSH-keypair *opt-out* mode. Absent, the package generates and owns the
  profile-named keypair.
- **`vultr-name`** — the Compute Name Standard's optional override. Absent, the
  machine and its firewall are named after the profile.
- **`webhook-url`** — the deprecated spelling. n8n 2.35.0 replaced it with
  `N8N_WEBHOOK_URL`, which this package derives from `n8n-host`. The validator
  rejects the old key by name rather than letting it render into a deprecation
  warning nobody reads.

## Rules the validator enforces

Beyond presence and shape, `build` refuses — in every colour, with the same
messages:

- an image without a digest pin, and a `n8n-runners-image` whose version differs
  from `n8n-image` (upstream requires equality; a mismatch fails when a Code
  node first executes, long after the converge reports success)
- `n8n-binary-data-mode: default` — n8n's own default holds binary payloads in
  memory on a host that also runs the database
- a non-positive `n8n-concurrency-production-limit` — n8n defaults to `-1`,
  unbounded
- any of the three security keys set to `false` (all three default to `false`
  upstream, contradicting the 2.0 breaking-changes page)
- `n8n-http-sources: cloudflare` (or `vultr-http-sources`) together with
  `cloudflare-proxied: false`, on either provider. Unproxied, the ACME HTTP-01
  challenge arrives from Let's Encrypt's own addresses and is dropped by the
  firewall; the converge still succeeds and the first HTTPS request finds no
  certificate
- `n8n-proxy-hops` below 2 when proxied — Cloudflare, then Caddy
- a `neon-r2-bucket` equal to the state bucket, or a backup bucket equal to
  either — blast radius
- keys removed in n8n 2.0: `n8n-config-files`,
  `queue-worker-max-stalled-count`, `n8n-available-binary-data-modes`
- **one R2 credential reaching state, live data and backups alike**, unless
  `r2-credential-sharing: shared-accepted` records the choice. Bucket
  separation was already enforced; enforcing it on one axis while silently
  permitting the other is worse than enforcing neither, because the visible
  rule implies the invisible one is handled too. With
  `n8n-storage-managed: true` the rule does not apply: the pairs are minted
  one per bucket and `r2-credential-sharing` is not required
- `s3-bucket-mode: managed` without `provider-backend: s3`, and
  `n8n-storage-managed: true` without `provider-compute: aws` and
  `provider-backend: s3`
- a `provider-backend` whose own keys are missing: `r2-bucket` and
  `r2-endpoint` for `r2`, `s3-bucket` and `s3-region` for `s3`
