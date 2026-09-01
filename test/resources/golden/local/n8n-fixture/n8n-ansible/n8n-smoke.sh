#!/usr/bin/env bash
# Acceptance. Every gate proves a property that could otherwise be false while
# everything still looks healthy. Failing any gate fails the converge.
set -uo pipefail
cd /opt/neon
. /opt/neon/n8n-env.sh
rc=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; rc=1; }
skip() { printf '  skip  %s\n' "$*"; }

n8n_api() { docker compose exec -T n8n wget -q -O - "http://127.0.0.1:5678$1" 2>/dev/null; }

echo "== A: storage tier =="

# A1 -- the tenant and timeline in desired state are the ones actually attached.
# The ids are desired state precisely so this is checkable.
ten=$(curl -sf "$PS/v1/tenant" 2>/dev/null \
      | python3 -c 'import json,sys; print(",".join(t["id"] for t in json.load(sys.stdin)))' 2>/dev/null || echo "")
case ",$ten," in
  *",7b3c1e94a05d42f8b6c9e2417d580a3f,"*) pass "A1 tenant 7b3c1e94a05d42f8b6c9e2417d580a3f attached" ;;
  *) fail "A1 tenant 7b3c1e94a05d42f8b6c9e2417d580a3f not attached (saw: ${ten:-none})" ;;
esac

# A2 -- remote storage is real AND FRESH. Copied deliberately from the proven
# gate in neon-single-node: pageserver object EXISTENCE only, because layer
# uploads follow the checkpoint cadence and demanding a new one per converge
# flakes; but a NEW safekeeper segment after pg_switch_wal(), compared against a
# pre-switch sorted baseline. Historical objects must not satisfy the WAL gate,
# or a broken uploader hides behind them indefinitely.
# `grep -c .` already prints 0 on no match, so a trailing `|| echo 0`
# emits TWO zeros and the later [ ] test dies with
#   [: 0\n0: integer expression expected
ps_n=$(rclone lsf --recursive "r2:$NEON_BUCKET/$NEON_PREFIX/" 2>/dev/null | grep -c . | head -1)
[ "${ps_n:-0}" -gt 0 ] && pass "A2a pageserver objects present ($ps_n)" \
                       || fail "A2a no objects under n8n/data/"
before=$(mktemp); after=$(mktemp)
rclone lsf --recursive "r2:$NEON_BUCKET/$NEON_PREFIX/safekeeper/" 2>/dev/null | sort > "$before"
psql_admin "select pg_switch_wal()" >/dev/null
sleep 20
rclone lsf --recursive "r2:$NEON_BUCKET/$NEON_PREFIX/safekeeper/" 2>/dev/null | sort > "$after"
if [ -n "$(comm -13 "$before" "$after")" ]; then
  pass "A2b new safekeeper segment after pg_switch_wal()"
else
  fail "A2b no NEW safekeeper segment after pg_switch_wal() -- WAL offload is not working"
fi
rm -f "$before" "$after"

# A3 -- n8n is really on Neon. Not "tables exist and there is no database.sqlite"
# -- that can pass while the live process writes somewhere else entirely.
# Create through the running instance, then read that exact row out of Neon.
tag="colors-acceptance-$(date -u +%s)"
probe() {
  docker compose exec -T \
    -e OWNER_EMAIL="operator@example.com" \
    -e OWNER_PW="$(cat /etc/n8n/secrets/owner-password)" \
    -e N8N_PORT="5678" \
    n8n node /opt/n8n-scripts/acceptance.js "$@" 2>/dev/null
}
created=$(probe create "$tag" | tr -d '\r' | tail -1)
if [ -n "$created" ]; then
  seen=$(psql_role "select count(*) from workflow_entity where id = '$created'")
  [ "${seen:-0}" = "1" ] && pass "A3 workflow $created created via API, read back from Neon" \
                         || fail "A3 workflow $created is NOT in Neon -- n8n is writing somewhere else"
else
  fail "A3 could not create a workflow through the API"
fi
dbt=$(docker compose exec -T n8n printenv DB_TYPE 2>/dev/null | tr -d '\r')
[ "$dbt" = postgresdb ] && pass "A3b DB_TYPE=postgresdb in the running container" \
                        || fail "A3b DB_TYPE is '${dbt:-unset}', not postgresdb"
docker compose exec -T n8n sh -lc 'ls /home/node/.n8n/database.sqlite' >/dev/null 2>&1 \
  && fail "A3c a SQLite database exists in the data directory" \
  || pass "A3c no SQLite database in the data directory"

# A4 -- the schema matches the pinned image. Grepping logs for "migrations
# finished" proves nothing: logs rotate, wording changes, and a partially
# applied migration still logs progress.
mig=$(psql_role "select count(*) from migrations")
[ "${mig:-0}" -gt 0 ] && pass "A4 migrations table has ${mig} applied entries" \
                      || fail "A4 migrations table is empty or absent"
docker compose logs --since 10m n8n 2>/dev/null | grep -qiE 'migration (failed|error)' \
  && fail "A4b the current container logged a migration error" \
  || pass "A4b no migration errors from the current container"

echo "== B: application tier =="

n8n_api /healthz >/dev/null && pass "B1a n8n /healthz (liveness)" || fail "B1a n8n /healthz failed"
# Readiness is the one that gates on the database. /healthz returns 200 while
# every API call still answers 503 "Database is not ready!".
n8n_api /healthz/readiness >/dev/null && pass "B1b n8n /healthz/readiness (database)" \
  || fail "B1b n8n is live but NOT ready -- the database connection is not up"

# B2 -- origin TLS, run HOST-LOCALLY against loopback with the public SNI.
# Once the firewall admits only Cloudflare, a workstation cannot reach the
# origin at all; B3 covers that direction from outside.
if curl -sf --resolve "n8n.example.com:443:127.0.0.1" "https://n8n.example.com/healthz" -o /dev/null 2>/dev/null; then
  pass "B2 origin serves a valid certificate for n8n.example.com"
else
  fail "B2 origin TLS failed for n8n.example.com (ACME may not have completed)"
fi

# B5 -- the generated production webhook URL. This is the gate that catches
# WEBHOOK_URL vs N8N_WEBHOOK_URL: with the deprecated key n8n falls back to its
# own host/port and hands third parties a URL that never resolves. Webhook URLs
# given to third parties are effectively permanent, so a wrong one is not a
# cosmetic defect.
wh=$(docker compose exec -T n8n printenv N8N_WEBHOOK_URL 2>/dev/null | tr -d '\r')
[ "$wh" = "https://n8n.example.com/" ] \
  && pass "B5 N8N_WEBHOOK_URL is https://n8n.example.com/" \
  || fail "B5 N8N_WEBHOOK_URL is '${wh:-unset}'"
docker compose exec -T n8n printenv WEBHOOK_URL >/dev/null 2>&1 \
  && fail "B5b the deprecated WEBHOOK_URL is set" \
  || pass "B5b deprecated WEBHOOK_URL absent"

# B4 -- the instance is claimed. An unclaimed public n8n is owned by whoever
# reaches the setup screen first.
claimed=$(n8n_api /rest/settings | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print("no" if d.get("userManagement",{}).get("showSetupOnFirstLoad") else "yes")' 2>/dev/null || echo unknown)
[ "$claimed" = yes ] && pass "B4 owner account claimed" || fail "B4 instance is UNCLAIMED (setup screen reachable)"

# B6 -- a Code node actually EXECUTES on the external runner. Grepping the log
# for a registration line proved nothing twice over: the wording is not stable
# across versions, and a runner reports connected long before it has run a
# task. The failure mode of a runner/main version mismatch is precisely a
# runner that connects and then fails every task, so execution is the only
# honest gate.
if [ -n "${created:-}" ]; then
  st=$(probe run-code "$created" | tr -d '\r' | tail -1)
  case "$st" in
    success) pass "B6 Code node executed on the external runner ($st)" ;;
    *) fail "B6 Code node did not execute on the runner (status: ${st:-none})" ;;
  esac
  probe delete "$created" >/dev/null 2>&1 || true
else
  fail "B6 skipped: no workflow was created"
fi

# B8 -- sshd hardening. SSH is open to the internet by workspace convention, so
# these negative controls are the whole of the mitigation, and are asserted
# rather than assumed to be image defaults. Ubuntu ships
# 50-cloud-init.conf with `PasswordAuthentication yes`; our 10- file wins
# because the FIRST value obtained for a keyword is the one sshd uses.
#
# Captured ONCE. Invoking `sshd -T` per assertion made the two checks disagree
# about the same host in the same run: an empty result from a transient failure
# reads exactly like "the setting is wrong", which is a gate that accuses
# correct configuration. Emptiness is its own failure here.
sshd_cfg=$(sshd -T 2>/dev/null || true)
if [ -z "${sshd_cfg:-}" ]; then
  fail "B8 could not read the effective sshd configuration"
else
  printf '%s\n' "$sshd_cfg" | grep -qi '^passwordauthentication no' \
    && pass "B8a password authentication disabled" \
    || fail "B8a password authentication is ENABLED"
  # sshd -T normalises `prohibit-password` to the legacy synonym
  # `without-password`, so a gate accepting only the modern spelling fails
  # against a correctly hardened host.
  printf '%s\n' "$sshd_cfg" | grep -qiE '^permitrootlogin (prohibit-password|without-password|no)' \
    && pass "B8b root password login disabled" \
    || fail "B8b root password login is permitted"
fi

echo "== R: recovery =="
# R2 is conditional by design. Making it mandatory would fail every converge
# that runs on the shared credential -- which is the credential model actually
# in use. Skipping it loudly is honest; passing it silently would not be.
if [ -n "${COLORS_PAR_N8N_BACKUP_R2_ACCESS_KEY_ID:-}" ]; then
  if rclone lsf "r2:$NEON_BUCKET/$NEON_PREFIX/" >/dev/null 2>&1; then
    fail "R2 the backup credential can read the LIVE data bucket"
  else
    pass "R2 backup credential is scoped away from live data"
  fi
else
  # Not "skip". A skip reads as "not applicable"; this is a security property
  # the deployment has explicitly accepted the absence of, and it should say so
  # every single run.
  printf '  RISK  %s\n' "R2 credential separation NOT in place -- accepted in desired state.
        One credential reaches OpenTofu state, live Neon data and backups.
        Close it: two bucket-scoped R2 tokens, then remove r2-credential-sharing."
fi

[ "$rc" -eq 0 ] && echo "acceptance: all gates passed" || echo "acceptance: FAILED" >&2
exit "$rc"
