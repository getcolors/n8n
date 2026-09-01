#!/usr/bin/env bash
# C1 -- the blocking gate that decides whether self-hosted Neon is actually a
# suitable n8n database on one host, instead of deferring the question to prose.
#
# A bare count of small executions would meet every threshold without touching
# the two things that actually break this host: Code-node memory multiplication
# and binary-data churn against object storage. So the workload is a declared
# MIX, and cleanup is part of the gate.
set -uo pipefail
cd /opt/neon
. /opt/neon/n8n-env.sh
rc=0
N=<{ n8n-soak-concurrent-workflows }>
SECS=<{ n8n-soak-duration-seconds }>
TAG="colors-soak-$(date -u +%s)"

before_objects() {
  rclone lsf --recursive "r2:$NEON_BUCKET/$NEON_PREFIX/" 2>/dev/null | grep -c . || echo 0
}

obj0=$(before_objects)
start=$(date +%s)

# (i) SQL round-trip latency, sampled independently of n8n. "Database latency"
# is otherwise whatever is easiest to report, and an implementation could pick
# end-to-end duration and still claim the threshold passed.
samples=$(mktemp)
( end=$((start + SECS))
  while [ "$(date +%s)" -lt "$end" ]; do
    t0=$(date +%s%N); psql_admin "select 1" >/dev/null; t1=$(date +%s%N)
    echo $(( (t1 - t0) / 1000000 )) >> "$samples"
    sleep 0.2
  done ) &
sampler=$!

# (ii) the workload mix itself
docker compose exec -T \
  -e OWNER_EMAIL="<{ n8n-owner-email }>" \
  -e OWNER_PW="$(cat /etc/n8n/secrets/owner-password)" \
  n8n sh -lc "
  export SOAK_TAG='$TAG' SOAK_N=$N SOAK_SECS=$SECS
  export SOAK_API=<{ n8n-soak-mix-api-percent }>
  export SOAK_CODE=<{ n8n-soak-mix-code-node-percent }>
  export SOAK_BIN=<{ n8n-soak-mix-binary-percent }>
  export SOAK_CODE_MB=<{ n8n-soak-code-node-payload-mb }>
  export SOAK_BIN_MB=<{ n8n-soak-binary-payload-mb }>
  node /opt/n8n-scripts/soak.js
" 2>/dev/null || rc=1

wait "$sampler" 2>/dev/null || true

p() { sort -n "$samples" | awk -v p="$1" 'BEGIN{c=0} {a[c++]=$1} END{if(c==0){print -1}else{print a[int(c*p/100)]}}'; }
p95=$(p 95); p99=$(p 99)
echo "sql round-trip p95=${p95}ms p99=${p99}ms"
[ "$p95" -ge 0 ] && [ "$p95" -le <{ n8n-soak-max-p95-sql-roundtrip-ms }> ] \
  || { echo "FAIL p95 SQL round-trip ${p95}ms over threshold" >&2; rc=1; }
[ "$p99" -ge 0 ] && [ "$p99" -le <{ n8n-soak-max-p99-sql-roundtrip-ms }> ] \
  || { echo "FAIL p99 SQL round-trip ${p99}ms over threshold" >&2; rc=1; }

done_n=$(psql_admin "select count(*) from execution_entity where \"workflowId\" in
                     (select id from workflow_entity where name like '${TAG}%')")
echo "executions completed: ${done_n:-0}"
[ "${done_n:-0}" -ge <{ n8n-soak-min-executions-completed }> ] \
  || { echo "FAIL only ${done_n:-0} executions completed" >&2; rc=1; }

mem=$(free | awk '/^Mem:/ {printf "%d", $3*100/$2}')
disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
echo "host memory ${mem}% disk ${disk}%"
[ "$mem" -le <{ n8n-soak-max-host-memory-percent }> ] || { echo "FAIL memory ${mem}%" >&2; rc=1; }
[ "$disk" -le <{ n8n-soak-max-disk-percent }> ] || { echo "FAIL disk ${disk}%" >&2; rc=1; }

# Pruning is soft-delete then hard-delete, and on Neon those deletes are WAL,
# and WAL ships to R2. Growth here is the write amplification plain-Postgres
# guidance never has to mention; it is reported, not thresholded, because the
# honest number is what the Context Skill needs.
obj1=$(before_objects)
echo "R2 objects under the deployment prefix: ${obj0} -> ${obj1}"

# Cleanup is part of the gate: a soak that leaves its own rows behind poisons
# every later measurement and every backup.
docker compose exec -T \
  -e OWNER_EMAIL="<{ n8n-owner-email }>" \
  -e OWNER_PW="$(cat /etc/n8n/secrets/owner-password)" \
  n8n node /opt/n8n-scripts/soak.js --cleanup "$TAG" >/dev/null 2>&1 || true
left=$(psql_admin "select count(*) from workflow_entity where name like '${TAG}%'")
[ "${left:-0}" = "0" ] || { echo "FAIL soak left ${left} workflows behind" >&2; rc=1; }

rm -f "$samples"
[ "$rc" -eq 0 ] && echo "soak: passed" || echo "soak: FAILED" >&2
exit "$rc"
