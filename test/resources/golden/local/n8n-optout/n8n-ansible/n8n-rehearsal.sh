#!/usr/bin/env bash
# R3 -- the restore rehearsal. A row import is not a recovery.
#
# Restores a backup set into an ISOLATED scratch stack (its own database on the
# same Neon compute, its own data directory, its own container) and proves the
# four things a checksum cannot: an operator can log in, the workflow is there,
# a stored credential DECRYPTS, and a binary payload from the restored data
# directory is readable.
#
# Isolation is at the database and data-directory level, deliberately. Standing
# up a second Neon storage tier to rehearse a restore would be rehearsing
# something nobody will do at 3am; restoring into a scratch database on the
# surviving compute is the actual recovery shape.
set -euo pipefail
cd /opt/neon
. /opt/neon/n8n-env.sh

TAG="rehearsal-$(date -u +%s)"
SCRATCH_DB="n8n_rehearsal"
SCRATCH_DIR="/var/tmp/n8n-rehearsal-data"
rc=0
pass() { printf '  ok    %s\n' "$*"; }
scratch_count() {
  env -i PATH=/usr/bin:/bin PGPASSWORD="$(cat /etc/neon/secrets/cloud_admin_password)" \
    psql -w "postgresql://cloud_admin@127.0.0.1:55433/${SCRATCH_DB}?connect_timeout=10" -tAc "$1" 2>/dev/null
}
fail() { printf '  FAIL  %s\n' "$*" >&2; rc=1; }

cleanup() {
  docker compose rm -sf n8n-rehearsal >/dev/null 2>&1 || true
  rm -rf "$SCRATCH_DIR" /var/tmp/n8n-rehearsal-compose.yml
  psql_admin "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== R3: restore rehearsal =="

# 1. Seed production with the three things that make a restore a recovery.
seed=$(docker compose exec -T \
  -e OWNER_EMAIL="operator@example.com" -e OWNER_PW="$(cat /etc/n8n/secrets/owner-password)" \
  -e REHEARSAL_TAG="$TAG" -e N8N_PORT="5678" \
  n8n node /opt/n8n-scripts/rehearsal.js seed)
echo "  seeded: $seed"

# 2. Take a backup set that contains it.
/opt/neon/n8n-backup.sh >/dev/null 2>&1
STAMP=$(rclone lsf "r2:$BACKUP_BUCKET/n8n-optout/" 2>/dev/null \
        | grep -E '^[0-9]{8}T[0-9]{6}Z/$' | sort | tail -1 | tr -d '/')
[ -n "$STAMP" ] || { echo "no backup set found" >&2; exit 1; }
echo "  backup set: $STAMP"

WORK=$(mktemp -d /var/tmp/n8n-rehearse.XXXXXX)
for f in n8n.dump n8n-data.tar.gz manifest.txt; do
  rclone copyto "r2:$BACKUP_BUCKET/n8n-optout/$STAMP/$f" "$WORK/$f" 2>/dev/null
done
# shellcheck disable=SC1090
. "$WORK/manifest.txt"
[ "$(sha256sum "$WORK/n8n.dump" | cut -d' ' -f1)" = "$dump_sha256" ] \
  && pass "R3a dump matches its manifest checksum" || fail "R3a dump checksum mismatch"
[ "$(sha256sum "$WORK/n8n-data.tar.gz" | cut -d' ' -f1)" = "$data_sha256" ] \
  && pass "R3b data directory matches its manifest checksum" || fail "R3b data checksum mismatch"

# 3. Restore into a scratch database and a scratch data directory.
psql_admin "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" >/dev/null 2>&1 || true
psql_admin "CREATE DATABASE $SCRATCH_DB OWNER n8n" >/dev/null
# The dump is piped in on stdin, NOT copied to /tmp first. The compute service
# mounts a tmpfs at /tmp (neon's fix for the stale .s.PGSQL.55433.lock that
# crash-loops a restarted compute), and `docker compose cp` writes into the
# container's filesystem layer UNDERNEATH that mount -- so the copy reports
# success and pg_restore then says
#   could not open input file "/tmp/r.dump": No such file or directory
# pg_restore from the compute image for the same reason pg_dump runs there:
# Ubuntu's client is 16 and this server is 17.
# pg_restore warns on ownership and extension statements it cannot replay as a
# non-superuser; those are expected and harmless. A hard failure is not, and
# swallowing everything hides a restore that produced an empty database --
# which then presents much later as "Database is not ready!".
restore_log=$(docker compose exec -T compute env PGPASSWORD="$(cat /etc/neon/secrets/cloud_admin_password)" \
  pg_restore -w --no-owner --no-acl -h 127.0.0.1 -p 55433 -U cloud_admin \
  -d "$SCRATCH_DB" < "$WORK/n8n.dump" 2>&1 || true)
tables=$(scratch_count "select count(*) from information_schema.tables where table_schema='public'")
if [ "${tables:-0}" -gt 0 ]; then
  pass "R3c the dump restored into the scratch database (${tables} tables)"
else
  fail "R3c the restore produced no tables"
  printf '%s\n' "$restore_log" | tail -5 | sed 's/^/        /' >&2
fi

rm -rf "$SCRATCH_DIR"; mkdir -p "$SCRATCH_DIR"
tar -xzf "$WORK/n8n-data.tar.gz" -C "$SCRATCH_DIR" --strip-components=1
chown -R 1000:1000 "$SCRATCH_DIR"

# 4. Boot the PINNED image against the restored pair, with the operator's key.
cat > /var/tmp/n8n-rehearsal-compose.yml <<COMPOSE
services:
  n8n-rehearsal:
    image: docker.io/n8nio/n8n:2.36.9@sha256:a9e2e3c8006ed453238266669ea1274be7136f515abe290a2f75a0ab9044c93d
    profiles: [rehearsal]
    restart: "no"
    # BOTH env files. operator.env alone gives the encryption key but not the
    # role password, and n8n then fails with
    #   SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
    # which names SASL and sounds like an auth-mechanism problem rather than an
    # unset variable.
    env_file: [/etc/n8n/host.env, /etc/n8n/operator.env]
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: compute
      DB_POSTGRESDB_PORT: "55433"
      DB_POSTGRESDB_DATABASE: ${SCRATCH_DB}
      DB_POSTGRESDB_USER: n8n
      DB_POSTGRESDB_SCHEMA: public
      N8N_PORT: "5678"
      # Deliberately NOT external runner mode. host.env carries the production
      # runner token, and inheriting external mode here would point this
      # container's broker at a runner that does not exist in the scratch
      # stack: every Code node then waits for an offer that never arrives and
      # the execution hangs in 'running' forever rather than failing. Internal
      # mode runs Code in-process, which is the right trade for a drill whose
      # subject is the data, not the runner topology.
      N8N_RUNNERS_MODE: internal
      N8N_DIAGNOSTICS_ENABLED: "false"
    volumes:
      - ${SCRATCH_DIR}:/home/node/.n8n
      # The probes run inside this container too.
      - /opt/n8n-scripts:/opt/n8n-scripts:ro
COMPOSE

# host.env carries the role password; operator.env carries the encryption key.
docker compose --profile rehearsal -f compose.yml -f compose.override.yml \
  -f /var/tmp/n8n-rehearsal-compose.yml up -d n8n-rehearsal >/dev/null 2>&1 || true

ready=0
for _ in $(seq 1 60); do
  # readiness, not liveness -- see the healthcheck comment in the overlay
  if docker compose exec -T n8n-rehearsal sh -lc \
      "wget -q -O /dev/null http://127.0.0.1:5678/healthz/readiness" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 2
done
# Readiness alone proves nothing about the restore: n8n will migrate an EMPTY
# database and report ready. R3c above is what establishes there is data; this
# only establishes the pinned image can serve it.
[ "$ready" = 1 ] && pass "R3d the pinned image boots READY against the restored pair" \
                 || fail "R3d the restored stack never became ready"

if [ "$ready" = 1 ]; then
  out=$(docker compose exec -T \
    -e OWNER_EMAIL="operator@example.com" -e OWNER_PW="$(cat /etc/n8n/secrets/owner-password)" \
    -e REHEARSAL_TAG="$TAG" -e N8N_PORT="5678" \
    n8n-rehearsal node /opt/n8n-scripts/rehearsal.js verify 2>/dev/null | tail -1)
  echo "  verify: $out"
  ok() { printf '%s' "$out" | grep -q "\"$1\":true"; }
  ok login      && pass "R3d an operator can log in to the restored instance" \
                || fail "R3d nobody can log in to the restore -- it is not a recovery"
  ok workflow   && pass "R3e the seeded workflow is present" || fail "R3e workflow absent"
  ok credential && pass "R3f a stored credential DECRYPTS with the operator key" \
                || fail "R3f credential did not decrypt -- the key did not survive"
  ok binary     && pass "R3g a binary payload from the restored data dir is readable" \
                || fail "R3g binary payload unreadable"
fi

rm -rf "$WORK"
[ "$rc" -eq 0 ] && echo "rehearsal: passed" || echo "rehearsal: FAILED" >&2
exit "$rc"
