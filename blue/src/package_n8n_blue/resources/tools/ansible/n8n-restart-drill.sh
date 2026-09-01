#!/usr/bin/env bash
# C3 -- restart drills. Two lifecycles, because they fail differently.
#
#   recreate  full stack down + up from stopped, no manual sequencing
#   reboot    unattended host reboot
#
# Both must come back with no ordering race between compute, n8n and the runner
# broker, and with a witness row intact. Compute is recreate-only by doctrine
# (a stale /tmp/.s.PGSQL.55433.lock crash-loops a stop/start), so a plain
# `down`/`up` is the honest test of whether that doctrine is encoded correctly
# rather than remembered.
set -euo pipefail
cd /opt/neon
. /opt/neon/n8n-env.sh
MODE="${1:-recreate}"
WITNESS_FILE=/var/tmp/n8n-restart-witness
rc=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; rc=1; }

wait_healthy() {
  # `local`: this used to assign a bare `st`, which is also the name the
  # caller uses for the execution status. It happened to work only because the
  # caller reassigns before reading -- a shadowing bug waiting to be a
  # confusing false pass.
  local st
  for _ in $(seq 1 90); do
    st=$(docker compose ps --format '{{.Service}}|{{.State}}|{{.Health}}' 2>/dev/null || true)
    if printf '%s' "$st" | grep -q '^compute|running|healthy' \
       && printf '%s' "$st" | grep -q '^n8n|running|healthy' \
       && printf '%s' "$st" | grep -q '^caddy|running' \
       && printf '%s' "$st" | grep -q '^n8n-runners|running'; then return 0; fi
    sleep 5
  done
  return 1
}

echo "== C3: restart drill ($MODE) =="

# A witness that must survive. Read from Neon directly afterwards, not through
# n8n, so the check does not depend on the thing being restarted.
#
# `reboot` is deliberately TWO invocations. A single in-host process cannot
# verify a reboot it triggers -- it is killed by the very event it is
# measuring -- so the witness name is persisted and the check runs from the
# operator's side once the host is back. A drill that cannot outlive its own
# subject is not a drill.
if [ "$MODE" = "reboot-check" ]; then
  WIT=$(cat "$WITNESS_FILE")
  wait_healthy && pass "C3b the whole stack returned healthy after an unattended reboot" \
               || fail "C3b the stack did not return healthy after reboot"
  after=$(psql_role "select count(*) from workflow_entity where name = '$WIT'" || echo 0)
  [ "${after:-0}" = "1" ] && pass "C3c the witness survived the reboot" \
                          || fail "C3c the witness did NOT survive the reboot (${after:-0} rows)"
  wf=$(psql_role "select id from workflow_entity where name = '$WIT' limit 1" | tr -d '[:space:]')
  if [ -n "$wf" ]; then
    st=$(docker compose exec -T \
      -e OWNER_EMAIL="<{ n8n-owner-email }>" -e OWNER_PW="$(cat /etc/n8n/secrets/owner-password)" \
      -e N8N_PORT="<{ n8n-port }>" n8n node /opt/n8n-scripts/acceptance.js run-code "$wf" 2>/dev/null | tr -d '\r' | tail -1)
    [ "$st" = success ] && pass "C3d a Code node still executes on the runner after the reboot" \
                        || fail "C3d Code node did not execute after the reboot (status: ${st:-none})"
    docker compose exec -T \
      -e OWNER_EMAIL="<{ n8n-owner-email }>" -e OWNER_PW="$(cat /etc/n8n/secrets/owner-password)" \
      -e N8N_PORT="<{ n8n-port }>" n8n node /opt/n8n-scripts/acceptance.js delete "$wf" >/dev/null 2>&1 || true
  fi
  rm -f "$WITNESS_FILE"
  [ "$rc" -eq 0 ] && echo "restart drill (reboot): passed" || echo "restart drill (reboot): FAILED" >&2
  exit "$rc"
fi

WIT="colors-restart-$(date -u +%s)"
docker compose exec -T \
  -e OWNER_EMAIL="<{ n8n-owner-email }>" -e OWNER_PW="$(cat /etc/n8n/secrets/owner-password)" \
  -e N8N_PORT="<{ n8n-port }>" n8n node /opt/n8n-scripts/acceptance.js create "$WIT" >/dev/null 2>&1
before=$(psql_role "select count(*) from workflow_entity where name = '$WIT'")
[ "${before:-0}" = "1" ] && pass "C3a witness workflow created" || { fail "C3a could not create the witness"; exit 1; }

case "$MODE" in
  recreate)
    docker compose down >/dev/null 2>&1
    docker compose up -d >/dev/null 2>&1 || true
    ;;
  reboot-arm)
    # Unattended: nothing sequences the stack on the way back up except the
    # restart policies and health conditions in the compose files. The witness
    # name outlives this process in a file; run `reboot-check` afterwards.
    printf '%s' "$WIT" > "$WITNESS_FILE"
    echo "  armed: witness $WIT recorded; rebooting"
    ( sleep 2; systemctl reboot ) >/dev/null 2>&1 &
    exit 0
    ;;
  *) echo "usage: n8n-restart-drill.sh [recreate|reboot-arm|reboot-check]" >&2; exit 2 ;;
esac

wait_healthy && pass "C3b the whole stack returned healthy with no manual sequencing" \
             || fail "C3b the stack did not return healthy"

after=$(psql_role "select count(*) from workflow_entity where name = '$WIT'" || echo 0)
[ "${after:-0}" = "1" ] && pass "C3c the witness survived the $MODE" \
                        || fail "C3c the witness did NOT survive (${after:-0} rows)"

# The runner is the piece most likely to come back attached-but-useless, so
# prove execution rather than connection.
wf=$(psql_role "select id from workflow_entity where name = '$WIT' limit 1" | tr -d '[:space:]')
if [ -n "$wf" ]; then
  st=$(docker compose exec -T \
    -e OWNER_EMAIL="<{ n8n-owner-email }>" -e OWNER_PW="$(cat /etc/n8n/secrets/owner-password)" \
    -e N8N_PORT="<{ n8n-port }>" n8n node /opt/n8n-scripts/acceptance.js run-code "$wf" 2>/dev/null | tr -d '\r' | tail -1)
  [ "$st" = success ] && pass "C3d a Code node still executes on the runner after the $MODE" \
                      || fail "C3d Code node did not execute after the $MODE (status: ${st:-none})"
  docker compose exec -T \
    -e OWNER_EMAIL="<{ n8n-owner-email }>" -e OWNER_PW="$(cat /etc/n8n/secrets/owner-password)" \
    -e N8N_PORT="<{ n8n-port }>" n8n node /opt/n8n-scripts/acceptance.js delete "$wf" >/dev/null 2>&1 || true
fi

[ "$rc" -eq 0 ] && echo "restart drill ($MODE): passed" || echo "restart drill ($MODE): FAILED" >&2
exit "$rc"
