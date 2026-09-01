# Shared runtime preamble. Sourced, never executed.
#
# Everything here is a trap already paid for by the getcolors/neon build and
# recorded in the neon-single-node Context Skill. They are repeated here because
# this package makes the same calls against the same bucket with the same
# bucket-scoped token, and getting any of them wrong fails in a way that looks
# like something else.
set -a; . /etc/neon/r2.env; set +a

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
# /etc/neon/r2.env supplies AWS_* names; rclone's s3 backend reads its own.
# Omitting this mapping does not fail as "no credentials" -- it fails as
#   InvalidArgument: Authorization  status code: 400
# which reads like a malformed request rather than an unauthenticated one.
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://319271fed8bc6d2d9059362be1165f37.eu.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_REGION="auto"
# Without no_check_bucket every upload is preceded by a CreateBucket the token
# denies -- surfacing as AccessDenied on what looks like a plain write. Without
# no_head the post-upload verification trips a 501. Confirmed for this
# deployment's own token on 2026-09-01: object PUT/DELETE succeed while
# ListBuckets returns AccessDenied.
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_R2_NO_HEAD=true

NEON_BUCKET="n8n-storage-example"
NEON_PREFIX="n8n/data"
BACKUP_BUCKET="n8n-backup-example"

# `rclone rcat` is a 501 against R2 -- streaming uploads of unknown size are not
# implemented. Always copyto a file of known size instead. This is the single
# most repeated mistake against this storage.
r2_put() { # $1 local file, $2 remote path
  rclone copyto "$1" "r2:$2"
}
r2_put_string() { # $1 content, $2 remote path
  local t; t=$(mktemp); printf '%s\n' "$1" > "$t"
  rclone copyto "$t" "r2:$2"; local rc=$?; rm -f "$t"; return $rc
}

# psql and the pageserver API are HOST tools reaching loopback publications --
# not `docker compose exec`. The upstream play installs postgresql-client and
# rclone on the host for exactly this, and the compute image is not guaranteed
# to carry a client at all.
PGURL_ADMIN="postgresql://cloud_admin@127.0.0.1:55433/n8n?connect_timeout=10"
PGURL_ROLE="postgresql://n8n@127.0.0.1:55433/n8n?connect_timeout=10"
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
