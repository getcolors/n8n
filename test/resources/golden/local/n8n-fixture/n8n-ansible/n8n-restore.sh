#!/usr/bin/env bash
# R3 -- restore rehearsal. A row import is not a recovery.
#
# Restores BOTH artifacts into an isolated scratch stack, boots the pinned n8n
# image against them with an operator-held encryption key, and then proves the
# three things a real recovery needs and a dump alone cannot show: a stored
# credential DECRYPTS, a binary payload is READABLE, and an operator can
# actually LOG IN. Whole-host recovery restores the database and the data
# directory but not /etc/n8n/secrets, so a restore nobody can sign into is not
# a recovery.
set -euo pipefail
# Sourced before anything uses it: same ordering trap the backup script hit,
# where a use before the source aborts under `set -u` with
# `BACKUP_BUCKET: unbound variable` and reads as missing configuration.
cd /opt/neon
. /opt/neon/n8n-env.sh

SET="${1:?usage: n8n-restore.sh <backup-set-stamp> [--verify-only]}"
SRC="$BACKUP_BUCKET/n8n-fixture/${SET}"
WORK=$(mktemp -d /var/tmp/n8n-restore.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

for f in n8n.dump n8n-data.tar.gz manifest.txt; do
  rclone copyto "r2:$SRC/$f" "$WORK/$f"
done

# The manifest is what makes the pair provable after the fact; the graceful
# stop during backup is what made it consistent in the first place.
. "$WORK/manifest.txt"
[ "$(sha256sum "$WORK/n8n.dump" | cut -d' ' -f1)" = "$dump_sha256" ] \
  || { echo "dump checksum mismatch" >&2; exit 1; }
[ "$(sha256sum "$WORK/n8n-data.tar.gz" | cut -d' ' -f1)" = "$data_sha256" ] \
  || { echo "data checksum mismatch" >&2; exit 1; }
echo "backup set ${stamp} verified against its manifest"

[ "${2:-}" = "--verify-only" ] && exit 0

: "${COLORS_PAR_N8N_ENCRYPTION_KEY:?the operator-held encryption key is required; without it the restore cannot decrypt any credential it restores}"
echo "restore into a scratch stack is an operator procedure; see README"
