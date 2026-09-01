#!/usr/bin/env bash
# C2 -- pruning qualification, in an ISOLATED scratch stack.
#
# Never against production. Desired state declares 336 hours / 10000
# executions; mutating that to something testable would delete real execution
# history and violate the very state this package exists to converge. So the
# drill stands up a scratch database and a scratch n8n with aggressive
# retention, proves the pruner actually reclaims, and tears it down.
#
# On the real converge the gate is narrower and lives in n8n-smoke.sh: assert
# the RENDERED values are the declared ones and that the prune workers run.
set -euo pipefail
cd /opt/neon
. /opt/neon/n8n-env.sh

SCRATCH_DB="n8n_prune_drill"
SCRATCH_DIR="/var/tmp/n8n-prune-data"
rc=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; rc=1; }
scratch_psql() {
  env -i PATH=/usr/bin:/bin PGPASSWORD="$(cat /etc/neon/secrets/cloud_admin_password)" \
    psql -w "postgresql://cloud_admin@127.0.0.1:55433/${SCRATCH_DB}?connect_timeout=10" -tAc "$1"
}
cleanup() {
  docker compose rm -sf n8n-prune >/dev/null 2>&1 || true
  rm -rf "$SCRATCH_DIR" /var/tmp/n8n-prune-compose.yml
  psql_admin "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== C2: pruning drill (isolated) =="
psql_admin "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" >/dev/null 2>&1 || true
psql_admin "CREATE DATABASE $SCRATCH_DB OWNER n8n" >/dev/null
rm -rf "$SCRATCH_DIR"; mkdir -p "$SCRATCH_DIR"; chown -R 1000:1000 "$SCRATCH_DIR"

# Retention low enough to observe, and the prune workers wound right down.
# Defaults are soft-delete hourly and hard-delete every 15 minutes, which no
# gate can wait for.
cat > /var/tmp/n8n-prune-compose.yml <<COMPOSE
services:
  n8n-prune:
    image: docker.io/n8nio/n8n:2.36.9@sha256:a9e2e3c8006ed453238266669ea1274be7136f515abe290a2f75a0ab9044c93d
    profiles: [drill]
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
      N8N_PORT: "5678"
      N8N_DIAGNOSTICS_ENABLED: "false"
      N8N_DEFAULT_BINARY_DATA_MODE: filesystem
      EXECUTIONS_DATA_PRUNE: "true"
      EXECUTIONS_DATA_MAX_AGE: "1"
      EXECUTIONS_DATA_PRUNE_MAX_COUNT: "5"
      EXECUTIONS_DATA_HARD_DELETE_BUFFER: "0"
      EXECUTIONS_DATA_PRUNE_HARD_DELETE_INTERVAL: "1"
      EXECUTIONS_DATA_PRUNE_SOFT_DELETE_INTERVAL: "1"
    volumes:
      - ${SCRATCH_DIR}:/home/node/.n8n
      # The probes run inside this container too.
      - /opt/n8n-scripts:/opt/n8n-scripts:ro
COMPOSE
docker compose --profile drill -f compose.yml -f compose.override.yml \
  -f /var/tmp/n8n-prune-compose.yml up -d n8n-prune >/dev/null 2>&1 || true

ready=0
for _ in $(seq 1 60); do
  docker compose exec -T n8n-prune sh -lc \
    "wget -q -O /dev/null http://127.0.0.1:5678/healthz/readiness" >/dev/null 2>&1 && { ready=1; break; }
  sleep 2
done
[ "$ready" = 1 ] || { fail "C2 scratch stack never became healthy"; exit 1; }
pass "C2a scratch stack healthy with retention max-count=5"

# Generate well past the cap.
docker compose exec -T \
  -e OWNER_EMAIL="drill@example.invalid" -e OWNER_PW="Aa1drillpassword" \
  -e SOAK_TAG="prune-drill" -e SOAK_N=3 -e SOAK_SECS=45 \
  -e SOAK_API=100 -e SOAK_CODE=0 -e SOAK_BIN=0 \
  -e SOAK_CODE_MB=1 -e SOAK_BIN_MB=1 \
  n8n-prune sh -lc '
    wget -q -O /dev/null --post-data="{\"email\":\"drill@example.invalid\",\"firstName\":\"D\",\"lastName\":\"R\",\"password\":\"Aa1drillpassword\"}" \
      --header="Content-Type: application/json" http://127.0.0.1:'"5678"'/rest/owner/setup 2>/dev/null || true
    node /opt/n8n-scripts/soak.js
  ' >/dev/null 2>&1 || true

peak=$(scratch_psql "select count(*) from execution_entity" || echo 0)
echo "  executions after load: ${peak:-0}"
[ "${peak:-0}" -gt 5 ] && pass "C2b generated ${peak} executions, past the cap of 5" \
                       || fail "C2b too few executions (${peak:-0}) to observe pruning"

# Soft delete runs on its interval, hard delete on its own. Give both room.
for _ in $(seq 1 24); do
  left=$(scratch_psql "select count(*) from execution_entity" || echo 0)
  [ "${left:-0}" -le 6 ] && break
  sleep 10
done
echo "  executions after pruning: ${left:-?}"
[ "${left:-999}" -le 6 ] && pass "C2c pruning reclaimed rows down to the cap (${left})" \
                         || fail "C2c pruning did not reclaim (${left} rows remain, cap 5)"
[ "${left:-999}" -lt "${peak:-0}" ] && pass "C2d the execution table is not growing monotonically" \
                                    || fail "C2d no reclamation observed"

[ "$rc" -eq 0 ] && echo "prune drill: passed" || echo "prune drill: FAILED" >&2
exit "$rc"
