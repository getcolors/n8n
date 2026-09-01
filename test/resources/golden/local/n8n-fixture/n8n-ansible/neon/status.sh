#!/usr/bin/env bash
# Root-only status helper: what is running, what the storage tier believes,
# and how to connect. Prints where the generated credentials live, never the
# credentials themselves.
set -euo pipefail

echo "== containers =="
docker compose -f /opt/neon/compose.yml ps --format '{{.Name}} {{.State}} {{.Status}}'

echo
echo "== tenant/timeline =="
curl -s http://127.0.0.1:9898/v1/tenant | jq -c '.[] | {id, state: .state.slug}'
curl -s "http://127.0.0.1:9898/v1/tenant/7b3c1e94a05d42f8b6c9e2417d580a3f/timeline/4f8a2d61c93b47e0a5d8f1620b7c94e3" \
  | jq -c '{timeline_id, state, last_record_lsn, remote_consistent_lsn}' 2>/dev/null || true

echo
echo "== connect =="
echo "from your workstation:"
echo "  ssh -L 55433:127.0.0.1:55433 n8n-fixture"
echo "  psql 'postgresql://n8n@127.0.0.1:55433/n8n'"
echo "the generated passwords live on this host only:"
echo "  /etc/neon/secrets/neon_role_password   (the application role)"
echo "  /etc/neon/secrets/cloud_admin_password (superuser; loopback only)"
