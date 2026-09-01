#!/usr/bin/env bash
# The backup set: a logical dump, the n8n data directory, and a manifest that
# ties them together. This is the FIRST line of disaster recovery, not the
# second -- Neon streams WAL to R2 continuously, but a rebuilt safekeeper does
# not recover its offloaded WAL (the walproposer bootstraps it from the compute
# basebackup instead), so a destroyed host falls back to exactly this.
# The backup interval is therefore the real RPO.
set -euo pipefail

cd /opt/neon
# Sourced FIRST: everything below depends on it, and under `set -u` a use
# before the source aborts with `BACKUP_BUCKET: unbound variable` -- which
# reads like a missing configuration rather than a line-ordering mistake.
. /opt/neon/n8n-env.sh

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d "/var/backups/n8n/set.XXXXXX")
DEST="$BACKUP_BUCKET/n8n-optout/${STAMP}"

# `docker pause` looks right here and is wrong: it can freeze a session while it
# holds locks, so the pg_dump that follows either blocks forever or captures a
# filesystem operation that was interrupted mid-write. Stop n8n properly and let
# its database sessions drain instead. Bounded, and always undone.
resume() { docker compose up -d n8n n8n-runners >/dev/null 2>&1 || true; }
trap resume EXIT

docker compose stop -t 30 n8n n8n-runners >/dev/null

for _ in $(seq 1 30); do
  live=$(psql_admin "select count(*) from pg_stat_activity
                     where datname='n8n' and usename='n8n'
                       and pid <> pg_backend_pid()" 2>/dev/null || echo 1)
  [ "$live" = "0" ] && break
  sleep 1
done

# pg_dump runs INSIDE the compute container, unlike every query in this
# package, which uses the host client.
#
# Ubuntu 24.04's postgresql-client is 16; Neon's compute-node-v17 serves 17.5.
# psql is protocol-compatible across that gap and works fine -- which is why
# every query-based gate passed -- but pg_dump refuses outright:
#   pg_dump: error: aborting because of server version mismatch
#   pg_dump: detail: server version: 17.5; pg_dump version: 16.15
# The alternative is adding the PGDG apt repo to pin a matching client; using
# the compute image's own binaries keeps the client and server versions
# married by construction, with no third-party repository on the host.
docker compose exec -T compute env PGPASSWORD="$(cat /etc/neon/secrets/cloud_admin_password)" \
  pg_dump -w --format=custom --no-owner --no-acl \
  -h 127.0.0.1 -p 55433 -U cloud_admin "n8n" > "$WORK/n8n.dump"
tar -C "$(dirname '/var/lib/n8n/data')" -czf "$WORK/n8n-data.tar.gz" \
  "$(basename '/var/lib/n8n/data')"

resume; trap - EXIT

# One shared timestamp and checksums prove the two artifacts belong together.
# They do NOT prove consistency on their own -- the graceful stop above is what
# does that. Both are needed: the stop makes the pair consistent, the manifest
# makes it provable afterwards.
{
  printf 'stamp=%s\n' "$STAMP"
  printf 'n8n_image=%s\n' "docker.io/n8nio/n8n:2.36.9@sha256:a9e2e3c8006ed453238266669ea1274be7136f515abe290a2f75a0ab9044c93d"
  printf 'neon_database=%s\n' "n8n"
  printf 'dump_sha256=%s\n' "$(sha256sum "$WORK/n8n.dump" | cut -d' ' -f1)"
  printf 'data_sha256=%s\n' "$(sha256sum "$WORK/n8n-data.tar.gz" | cut -d' ' -f1)"
  printf 'dump_bytes=%s\n' "$(stat -c%s "$WORK/n8n.dump")"
  printf 'data_bytes=%s\n' "$(stat -c%s "$WORK/n8n-data.tar.gz")"
} > "$WORK/manifest.txt"

# The encryption key is deliberately NOT in here. It is the operator's to hold,
# and a backup set that carried it would turn one bucket compromise into the
# loss of every credential the database protects.
for f in n8n.dump n8n-data.tar.gz manifest.txt; do
  r2_put "$WORK/$f" "$DEST/$f"
done

rm -rf "$WORK"
find "/var/backups/n8n" -maxdepth 1 -name 'set.*' -mtime +1 -exec rm -rf {} + 2>/dev/null || true
echo "backup set ${STAMP} uploaded"
