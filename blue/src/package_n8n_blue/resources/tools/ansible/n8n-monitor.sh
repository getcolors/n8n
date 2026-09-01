#!/usr/bin/env bash
# Health check plus a dead-man heartbeat.
#
# Local logs are useless in exactly the failures this exists to catch -- a dead
# host, a full disk, a broken timer. So a successful run writes a heartbeat
# object to the backup bucket, and STALENESS of that object is what is
# observable off-host. Turning staleness into a page needs an external poller,
# which a single host cannot provide for itself; that is stated rather than
# pretended.
set -uo pipefail
cd /opt/neon
. /opt/neon/n8n-env.sh
fail=0
note() { echo "n8n-monitor: $*" >&2; fail=1; }

disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "${disk:-0}" -lt "<{ n8n-soak-max-disk-percent }>" ] || note "disk ${disk}% over threshold"

mem=$(free | awk '/^Mem:/ {printf "%d", $3*100/$2}')
[ "${mem:-0}" -lt "<{ n8n-soak-max-host-memory-percent }>" ] || note "memory ${mem}% over threshold"

for s in storage_broker pageserver safekeeper compute n8n n8n-runners caddy; do
  st=$(docker compose ps --format json "$s" 2>/dev/null | python3 -c 'import json,sys
try:
    d=json.loads(sys.stdin.read() or "{}")
except Exception: d={}
d=d[0] if isinstance(d,list) and d else d
print(d.get("State","missing"))' 2>/dev/null || echo missing)
  [ "$st" = running ] || note "container $s is $st"
  rc=$(docker inspect -f '{{.RestartCount}}' "$(docker compose ps -q "$s" 2>/dev/null)" 2>/dev/null || echo 0)
  [ "${rc:-0}" -lt 5 ] || note "container $s has restarted ${rc} times"
done

docker compose exec -T n8n wget -q -O /dev/null "http://127.0.0.1:<{ n8n-port }>/healthz" \
  || note "n8n /healthz failed"

# A runner that silently stopped registering turns every Code node into a
# failure at execution time, with the rest of the instance perfectly healthy.
docker compose logs --since 30m n8n-runners 2>/dev/null | grep -qi 'error\|disconnect' \
  && note "task runner reported errors in the last 30m"

# Safekeeper WAL upload freshness. `remote_consistent_lsn` reads 0/0 right after
# any restart, so it is not usable as a converge-time threshold -- object
# recency under the deployment's own prefix is.
newest=$(rclone lsjson --recursive \
  "r2:$NEON_BUCKET/$NEON_PREFIX/safekeeper/" 2>/dev/null \
  | python3 -c 'import json,sys
try: xs=json.load(sys.stdin)
except Exception: xs=[]
print(max((x["ModTime"] for x in xs), default=""))' 2>/dev/null || echo "")
[ -n "$newest" ] || note "no safekeeper objects under the deployment prefix"

if [ "$fail" -eq 0 ]; then
  # copyto, never rcat: rcat is NotImplemented (501) against R2.
  r2_put_string "ok $(date -u +%Y%m%dT%H%M%SZ)" \
    "$BACKUP_BUCKET/<{ profile }>/heartbeat" 2>/dev/null \
    || echo "n8n-monitor: heartbeat upload failed" >&2
  echo "n8n-monitor: ok"
else
  # Deliberately does NOT write the heartbeat. The absence is the signal.
  echo "n8n-monitor: unhealthy; heartbeat withheld" >&2
fi
exit "$fail"
