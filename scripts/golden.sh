#!/usr/bin/env bash
set -euo pipefail

# Green's regression net against the committed goldens: render every fixture
# and diff against committed output. scripts/parity.sh is the net across
# colours.
#
# Three fixtures. The SSH Keypair Standard has two modes and a package
# conforms only if both hold: `colors.yml` is keygen mode (no vultr-ssh-keys),
# so the compute template must declare the profile-named vultr_ssh_key
# resource and reference it by attribute, and `optout.yml` supplies an
# explicit key id and must render the historical shape, byte for byte,
# creating nothing. `aws.yml` is the second compute provider: one EC2 node,
# a managed S3 state bucket, and the n8n-storage stage that owns the Neon and
# backup buckets with one scoped IAM identity each.
#
# Keygen paths are rendered from a fixed placeholder home on :build, never from
# $HOME, so these goldens mean the same thing on every workstation.
#
#   ./scripts/golden.sh            check
#   ./scripts/golden.sh --accept   regenerate after an intended change

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

accept=0
[[ ${1:-} == --accept ]] && accept=1

status=0
for variant in colors optout aws; do
  fixture="$tmp/$variant.yml"
  sed "s#WORKDIR#$tmp/work#" "$root/test/fixtures/$variant.yml" > "$fixture"
  (cd "$root/green" && N8N_LIB_ROOT="$root" ./green build -f "$fixture" >/dev/null)

  profile=$(sed -n 's/^profile: //p' "$fixture")
  actual="$tmp/work/$profile"
  golden="$root/test/resources/golden/local/$profile"

  # No rendered artefact may carry a real secret into a committed golden.
  # Checked before --accept copies anything. POSIX grep on purpose: a missing
  # binary inside `if` is simply false, so the guard must not depend on one
  # that may be absent.
  if grep -rEq 'BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|github_pat_|ghp_|gho_|ghu_|ghs_|ghr_' "$actual"; then
    echo "golden: a credential-shaped value was rendered in $profile" >&2; exit 1
  fi
  # The operator secrets must reach the host as Ansible lookups resolved at
  # execution time, never as values templated into generated output. If one
  # of these expressions stops appearing, something started rendering the
  # secret itself and the next `bb golden:accept` would commit it.
  for par in NEON_R2_ACCESS_KEY_ID NEON_R2_SECRET_ACCESS_KEY; do
    if ! grep -q "lookup('env','COLORS_PAR_$par')" "$actual/n8n-ansible/neon/main.yml"; then
      echo "golden: $profile no longer renders COLORS_PAR_$par as a lookup" >&2; exit 1
    fi
  done
  # n8n's own operator secret and the backup pair, in this package's play.
  for par in N8N_ENCRYPTION_KEY N8N_BACKUP_R2_ACCESS_KEY_ID N8N_BACKUP_R2_SECRET_ACCESS_KEY; do
    if ! grep -q "lookup('env','COLORS_PAR_$par')" "$actual/n8n-ansible/n8n.yml"; then
      echo "golden: $profile no longer renders COLORS_PAR_$par as a lookup" >&2; exit 1
    fi
  done
  # A Selmer tag that survived rendering is a typo or an unsupplied key.
  if grep -rn '<{' "$actual"; then
    echo "golden: $profile left an unrendered Selmer tag" >&2; exit 1
  fi

  # A build that reached the real ~/.ssh would leak the operator's home into
  # committed bytes and make the goldens workstation-specific.
  if grep -rq "$HOME/.ssh" "$actual"; then
    echo "golden: $profile rendered a real home directory; build must use the placeholder" >&2; exit 1
  fi
  # SSH Config Standard §6: the local stage takes the address, the user and the
  # alias as Ansible extra-vars, never through Selmer, so its rendered playbook
  # carries no address at all. A dotted quad here means someone templated a
  # run-time fact and the goldens stopped being workstation-independent.
  if grep -rEq '([0-9]{1,3}\.){3}[0-9]{1,3}' "$actual/n8n-ansible-local"; then
    echo "golden: $profile rendered an address into the local ssh_config stage" >&2; exit 1
  fi

  if [[ $variant == aws ]]; then
    # The storage stage: two buckets, one scoped identity each, a sensitive
    # credentials output, and its own state key under the profile.
    storage="$actual/n8n-storage/main.tf"
    [[ -f $storage ]] || { echo "golden: $profile has no n8n-storage stage" >&2; exit 1; }
    for needle in 'resource "aws_s3_bucket" "application"' 'force_destroy = true' \
                  'prevent_destroy = true' 'block_public_policy = true' 'sse_algorithm = "AES256"' \
                  'resource "aws_iam_user" "application"' 'aws_s3_bucket.application[each.key].arn' \
                  '"colors:owner" = "n8n-storage"' 'sensitive = true'; do
      grep -qF -- "$needle" "$storage" || { echo "golden: $profile storage stage lacks $needle" >&2; exit 1; }
    done
    grep -qF '"s3:*"' "$storage" && { echo "golden: $profile storage policy is not bucket-scoped" >&2; exit 1; }
    grep -q "\"key\" *: *\"$profile/n8n-storage.tfstate\"" "$actual/n8n-storage/backend.tf.json" \
      || { echo "golden: $profile storage state key moved" >&2; exit 1; }
    # No minted credential name may be rendered; it lives in the subprocess
    # environment only.
    if grep -rq 'access_key_id = "' "$actual/n8n-ansible"; then
      echo "golden: $profile rendered a storage credential into the ansible stage" >&2; exit 1
    fi
    # IPv4-only sources on the AWS adapter, and Ubuntu's login user.
    if grep -Eq '"[0-9a-f]*:[0-9a-f:]*/[0-9]+"' "$actual/n8n-infrastructure/http-sources.json"; then
      echo "golden: $profile resolved an IPv6 origin range for AWS" >&2; exit 1
    fi
    grep -q '"ansible_user" : "ubuntu"' "$actual/n8n-ansible/inventory.json" \
      || { echo "golden: $profile inventory does not log in as ubuntu" >&2; exit 1; }
  else
    [[ -d "$actual/n8n-storage" ]] && { echo "golden: $profile rendered a storage stage without managed storage" >&2; exit 1; }
  fi

  if [[ $accept == 1 ]]; then
    rm -rf "$golden"; mkdir -p "$(dirname "$golden")"; cp -a "$actual" "$golden"; continue
  fi
  [[ -d "$golden" ]] || { echo "golden missing for $profile; inspect build then run bb golden:accept" >&2; exit 1; }
  diff -ru "$golden" "$actual" || status=1
done

exit "$status"
