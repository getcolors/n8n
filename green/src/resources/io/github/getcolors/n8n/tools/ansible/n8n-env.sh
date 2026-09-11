# Shared runtime preamble. Sourced, never executed.
#
# Two rclone remotes, one per bucket and one per credential file:
#
#   store   the Neon bucket (pageserver layers, safekeeper WAL), read with the
#           pair the getcolors/neon play installs at /etc/neon/r2.env
#   backup  the backup bucket (backup sets, the heartbeat), read with the pair
#           this package's play installs at /etc/colors/backup-r2.env
#
# When the backup pair is empty and desired state records
# `r2-credential-sharing: shared-accepted`, the backup remote falls back to
# the Neon pair: one credential then reaches live data and backups alike, and
# the smoke gate reports that every run. When the pair is empty and sharing is
# not accepted, the backup remote has no credential and the play refuses to
# converge. BACKUP_CREDENTIAL_MODE records which case applies.
#
# Everything else here is a trap already paid for by the getcolors/neon build
# and recorded in the neon-single-node Context Skill. They are repeated here
# because this package makes the same calls against the same buckets with the
# same bucket-scoped tokens, and getting any of them wrong fails in a way that
# looks like something else.
#
# /etc/neon/r2.env supplies AWS_* names; rclone's s3 backend reads its own.
# Omitting this mapping does not fail as "no credentials" -- it fails as
#   InvalidArgument: Authorization  status code: 400
# which reads like a malformed request rather than an unauthenticated one.
# Without no_check_bucket every upload is preceded by a CreateBucket the token
# denies -- surfacing as AccessDenied on what looks like a plain write. Without
# no_head the post-upload verification trips a 501. Confirmed for this
# deployment's own token on 2026-09-01: object PUT/DELETE succeed while
# ListBuckets returns AccessDenied.
# No config file: rclone otherwise prints a NOTICE about the missing one on
# every invocation, which reads like a fault in gate output.
export RCLONE_CONFIG=/dev/null

export RCLONE_CONFIG_STORE_TYPE=s3 RCLONE_CONFIG_STORE_PROVIDER=Cloudflare
export RCLONE_CONFIG_STORE_ENDPOINT="<{ neon-r2-endpoint }>" RCLONE_CONFIG_STORE_REGION="<{ neon-r2-region }>"
export RCLONE_CONFIG_STORE_NO_CHECK_BUCKET=true RCLONE_CONFIG_STORE_NO_HEAD=true
case "$RCLONE_CONFIG_STORE_ENDPOINT" in
  https://*.amazonaws.com|https://*.amazonaws.com/|https://*.amazonaws.com.cn|https://*.amazonaws.com.cn/) export RCLONE_CONFIG_STORE_PROVIDER=AWS ;;
esac
export RCLONE_CONFIG_BACKUP_TYPE=s3 RCLONE_CONFIG_BACKUP_PROVIDER=Cloudflare
export RCLONE_CONFIG_BACKUP_ENDPOINT="<{ n8n-backup-r2-endpoint }>" RCLONE_CONFIG_BACKUP_REGION="<{ n8n-backup-r2-region }>"
export RCLONE_CONFIG_BACKUP_NO_CHECK_BUCKET=true RCLONE_CONFIG_BACKUP_NO_HEAD=true
case "$RCLONE_CONFIG_BACKUP_ENDPOINT" in
  https://*.amazonaws.com|https://*.amazonaws.com/|https://*.amazonaws.com.cn|https://*.amazonaws.com.cn/) export RCLONE_CONFIG_BACKUP_PROVIDER=AWS ;;
esac

RCLONE_CONFIG_STORE_ACCESS_KEY_ID=$(sed -n 's/^AWS_ACCESS_KEY_ID=//p' /etc/neon/r2.env 2>/dev/null)
RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY=$(sed -n 's/^AWS_SECRET_ACCESS_KEY=//p' /etc/neon/r2.env 2>/dev/null)
export RCLONE_CONFIG_STORE_ACCESS_KEY_ID RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY

R2_CREDENTIAL_SHARING="<{ r2-credential-sharing }>"
RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID=$(sed -n 's/^BACKUP_R2_ACCESS_KEY_ID=//p' /etc/colors/backup-r2.env 2>/dev/null)
RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY=$(sed -n 's/^BACKUP_R2_SECRET_ACCESS_KEY=//p' /etc/colors/backup-r2.env 2>/dev/null)
if [ -n "$RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID" ] && [ -n "$RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY" ]; then
  BACKUP_CREDENTIAL_MODE=split
elif [ "$R2_CREDENTIAL_SHARING" = shared-accepted ]; then
  BACKUP_CREDENTIAL_MODE=shared
  RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID="$RCLONE_CONFIG_STORE_ACCESS_KEY_ID"
  RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY="$RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY"
else
  BACKUP_CREDENTIAL_MODE=none
fi
export RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY BACKUP_CREDENTIAL_MODE

NEON_BUCKET="<{ neon-r2-bucket }>"
NEON_PREFIX="<{ neon-r2-prefix }>"
BACKUP_BUCKET="<{ n8n-backup-r2-bucket }>"

# `rclone rcat` is a 501 against R2 -- streaming uploads of unknown size are not
# implemented. Always copyto a file of known size instead. This is the single
# most repeated mistake against this storage.
backup_put() { # $1 local file, $2 remote path inside the backup remote
  rclone copyto "$1" "backup:$2"
}
backup_put_string() { # $1 content, $2 remote path inside the backup remote
  local t; t=$(mktemp); printf '%s\n' "$1" > "$t"
  rclone copyto "$t" "backup:$2"; local rc=$?; rm -f "$t"; return $rc
}

# psql and the pageserver API are HOST tools reaching loopback publications --
# not `docker compose exec`. The upstream play installs postgresql-client and
# rclone on the host for exactly this, and the compute image is not guaranteed
# to carry a client at all.
PGURL_ADMIN="postgresql://cloud_admin@127.0.0.1:55433/<{ neon-database }>?connect_timeout=10"
PGURL_ROLE="postgresql://<{ neon-role }>@127.0.0.1:55433/<{ neon-database }>?connect_timeout=10"
PS="http://127.0.0.1:9898"

psql_admin() {
  env -i PATH=/usr/bin:/bin \
    PGPASSWORD="$(cat /etc/neon/secrets/cloud_admin_password)" \
    psql -w "$PGURL_ADMIN" -v ON_ERROR_STOP=1 -tAc "$1"
}
psql_role() {
  env -i PATH=/usr/bin:/bin \
    PGPASSWORD="$(cat /etc/neon/secrets/neon_role_password)" \
    psql -w "$PGURL_ROLE" -v ON_ERROR_STOP=1 -tAc "$1"
}
