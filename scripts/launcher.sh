#!/usr/bin/env bash
set -euo pipefail

# What the copied payloads must be true of, checked without a provider.
#
# A payload is the one place in this project where code cannot be reached by a
# test suite, so the checks that matter are made here: each launcher names this
# package's entry point, carries exactly the pin form `bb pin` rewrites, and is
# the file its colour directory symlinks to. Then green is run end to end from a
# copy outside the repository — the shape a deployment actually installs.

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# --- the three payloads, statically ----------------------------------------

green_launcher="$root/skills/package-n8n-green/green"
red_launcher="$root/skills/package-n8n-red/red"
blue_launcher="$root/skills/package-n8n-blue/blue"

grep -q 'io.github.getcolors.n8n.workflow/workflow' "$green_launcher"
grep -q 'def \^:private n8n-sha' "$green_launcher"
grep -q 'package-n8n-red' "$red_launcher"
grep -q 'package_n8n_blue' "$blue_launcher"

# Exactly one pin site per payload: `bb pin` rewrites the first match, and a
# second copy would silently go stale.
[[ $(grep -c 'def \^:private n8n-sha' "$green_launcher") == 1 ]]
[[ $(grep -c '"package-n8n-red":' "$red_launcher") == 1 ]]

# Every colour resolves the storage tier at the same commit as green's
# deps.edn. Three records of one pin is the price of three runtimes; they
# drifting apart is what parity.sh would then fail on, far from the cause.
neon_sha=$(awk '/neon\.git/ {found=1} found && match($0, /:git\/sha "[0-9a-f]{40}"/) {print substr($0, RSTART+10, 40); exit}' "$root/green/deps.edn")
[[ -n $neon_sha ]]
grep -q "getcolors/neon#$neon_sha" "$root/red/package.json"
grep -q "rev = \"$neon_sha\"" "$root/blue/pyproject.toml"
grep -q "getcolors/neon#$neon_sha" "$red_launcher"

[[ -L "$root/green/green" ]] && [[ $(readlink "$root/green/green") == ../skills/package-n8n-green/green ]]
[[ -L "$root/red/red" ]] && [[ $(readlink "$root/red/red") == ../skills/package-n8n-red/red ]]
[[ -L "$root/blue/blue" ]] && [[ $(readlink "$root/blue/blue") == ../skills/package-n8n-blue/blue ]]

# --- green, end to end from a copy ------------------------------------------

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp "$green_launcher" "$tmp/green"; chmod +x "$tmp/green"
sed "s#WORKDIR#.colors#" "$root/test/fixtures/colors.yml" > "$tmp/colors.yml"
(cd "$tmp" && N8N_LIB_ROOT="$root" ./green build >/dev/null)
[[ -f "$tmp/.colors/n8n-fixture/n8n-infrastructure/main.tf" ]]
[[ -f "$tmp/.colors/n8n-fixture/n8n-dns/main.tf" ]]
[[ -f "$tmp/.colors/n8n-fixture/n8n-ansible/n8n.yml" ]]
# The storage tier arrives from the dependency, in its own subdirectory.
[[ -f "$tmp/.colors/n8n-fixture/n8n-ansible/neon/compose.yml" ]]
# The launcher walks up for colors.yml, so any subdirectory works.
mkdir -p "$tmp/nested/path"
(cd "$tmp/nested/path" && N8N_LIB_ROOT="$root" ../../green build >/dev/null)
# The profile guard is the whole reason COLORS_PAR_PROFILE is refused: an
# overlay would point one deployment at another's state.
out=$(cd "$tmp" && N8N_LIB_ROOT="$root" COLORS_PAR_PROFILE=wrong ./green build 2>&1 || true)
grep -q COLORS_PAR_PROFILE <<<"$out"
[[ ! -d "$tmp/.colors/wrong" ]]
echo 'launcher: all checks passed'
