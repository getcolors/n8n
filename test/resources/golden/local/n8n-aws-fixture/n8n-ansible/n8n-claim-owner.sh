#!/usr/bin/env bash
# Claim the n8n owner account, reconciling.
#
# This lives in a script rather than inline in the playbook on purpose. Ansible
# splits a shell task's arguments before running anything, counting brace pairs
# and quotes across the whole block -- comments included -- so any non-trivial
# shell (nested quoting, a python -c, a docker exec carrying its own quoted
# command) fails at LOAD time with:
#   Error loading tasks: failed at splitting arguments, either an unbalanced
#   jinja2 block or quotes
# naming the task rather than the character. A file has no such constraint.
#
# The window this closes: n8n's first-run setup screen is unauthenticated, so
# between Caddy serving the public name and an owner existing, whoever reaches
# it first owns the instance and every credential it will ever store.
set -euo pipefail
cd /opt/neon

body=$(python3 - "$1" "$(cat /etc/n8n/secrets/owner-password)" <<'PY'
import json, sys
print(json.dumps({"email": sys.argv[1], "firstName": "Colors",
                  "lastName": "Operator", "password": sys.argv[2]}))
PY
)

# Through the environment, so no quoting survives into the container's shell.
docker compose exec -T -e OWNER_BODY="$body" n8n sh -lc '
  printf "%s" "$OWNER_BODY" > /tmp/owner.json
  wget -q -O - --post-file=/tmp/owner.json \
    --header="Content-Type: application/json" \
    "http://127.0.0.1:'"$2"'/rest/owner/setup" >/dev/null 2>&1 \
    && echo created || echo already
  rm -f /tmp/owner.json
' || true

# Assert the END STATE, never the outcome of the POST: a converge re-run
# against an already-claimed instance must succeed, not fail.
state=$(docker compose exec -T n8n sh -lc "wget -q -O - http://127.0.0.1:$2/rest/settings" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print("claimed" if d.get("userManagement",{}).get("showSetupOnFirstLoad") is False else "unclaimed")')

[ "$state" = claimed ] || { echo "owner account was not claimed" >&2; exit 1; }
echo "owner: $state"
