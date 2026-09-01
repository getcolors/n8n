#!/usr/bin/env bash
# Offline syntax gate for the rendered convergence tree.
#
# Exists because three live converges were spent on a playbook that failed at
# LOAD time -- `ansible-playbook --syntax-check` reproduces that in about a
# second, needs no credentials, no host and no money, and would have caught
# every one of them. Runs against whatever `build` last rendered.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .colors ] || { echo "no .colors/ -- run 'cd green && ./green build' first" >&2; exit 1; }
rc=0
for inv in $(find .colors -name inventory.json); do
  dir=$(dirname "$inv")
  for pb in site.yml cleanup.yml; do
    [ -f "$dir/$pb" ] || continue
    if (cd "$dir" && ansible-playbook --syntax-check -i inventory.json "$pb" >/dev/null 2>&1); then
      echo "  ok    $dir/$pb"
    else
      echo "  FAIL  $dir/$pb" >&2
      (cd "$dir" && ansible-playbook --syntax-check -i inventory.json "$pb" 2>&1 | tail -6 | sed 's/^/        /') >&2
      rc=1
    fi
  done
done
exit "$rc"
