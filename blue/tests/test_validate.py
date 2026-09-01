"""Most of these are regression tests for things the live build got wrong.

The lesson that produced them: a trap written down in prose gets read once,
while a validator runs on every converge. Each test below names the failure it
prevents.
"""

from __future__ import annotations

import re

from conftest import fixture, optout

from package_n8n_blue import validate as v


def errs(overrides: dict | None = None) -> list[str]:
    return v.state_errors(fixture(overrides))


def has(overrides: dict, needle: str) -> bool:
    return any(re.search(needle, e) for e in errs(overrides))


def test_a_complete_desired_state_validates():
    # The committed fixture is that complete state, so it is the base rather
    # than a second hand-maintained copy of it: `state_errors` reports every
    # problem at once, and a base missing keys makes every test below read as a
    # pass-by-accident.
    assert v.state_errors(fixture()) == []
    assert v.state_errors(optout()) == []


def test_reports_every_problem_at_once():
    # Exit code 2 lists all problems; a validator that stops at the first makes
    # a fresh colors.yml a guessing game.
    assert len(errs({"neon-pg-version": 12, "n8n-port": None, "vultr-os-id": "x"})) >= 3


def test_the_machine_key_is_not_required_and_its_absence_selects_keygen():
    # The standard makes absence meaningful: requiring vultr-ssh-keys would
    # make every conforming keygen deployment invalid.
    assert not any("vultr-ssh-keys" in e for e in errs())
    assert v.keygen(fixture()) is True
    assert v.keygen(optout()) is False


# --- version-specific regressions -----------------------------------------


def test_rejects_the_deprecated_webhook_url_spelling():
    # WEBHOOK_URL is a deprecated alias from n8n 2.35.0. Every secondary source
    # still names it, and so did the adversarial review.
    assert has({"webhook-url": "https://n8n.example.com/"}, ":webhook-url")


def test_rejects_keys_removed_in_n8n_2():
    for key in ["n8n-config-files", "queue-worker-max-stalled-count",
                "n8n-available-binary-data-modes"]:
        assert has({key: "x"}, key)


def test_rejects_the_deprecated_runners_enabled_flag():
    assert has({"n8n-runners-enabled": True}, ":n8n-runners-enabled")


def test_runner_image_version_must_equal_the_n8n_image_version():
    # Upstream requires it, and a mismatch fails when a Code node first
    # executes -- long after a converge reports success.
    assert has({"n8n-runners-image": "docker.io/n8nio/runners:2.35.0@sha256:"
                "99811ba57933dd77895f5fedbb555ce105bac8a82812205f6396d52a30b32e66"},
               "must equal")
    assert errs() == []


def test_binary_data_must_not_be_held_in_memory():
    # n8n's own default is `default`, which keeps payloads in RAM on a host
    # that also runs a pageserver and a Postgres compute.
    assert has({"n8n-binary-data-mode": "default"}, "holds binary payloads in memory")


def test_concurrency_must_be_bounded():
    # n8n defaults to -1, unbounded.
    assert has({"n8n-concurrency-production-limit": -1}, "positive integer")
    assert has({"n8n-concurrency-production-limit": 0}, "positive integer")


def test_security_settings_must_be_explicitly_true():
    # All three default to FALSE in n8n's reference, contradicting the 2.0
    # breaking-changes page.
    for key in ["n8n-block-env-access-in-node",
                "n8n-enforce-settings-file-permissions",
                "n8n-git-node-disable-bare-repos"]:
        assert has({key: False}, key)


# --- the coupling that only fails later ------------------------------------


def test_cloudflare_only_ingress_requires_a_proxied_record():
    # Unproxied, the ACME HTTP-01 challenge arrives from Let's Encrypt's own
    # addresses and is dropped by the firewall -- the converge still succeeds
    # and the first HTTPS request finds no certificate.
    assert has({"cloudflare-proxied": False}, "ACME HTTP-01")
    assert errs({"cloudflare-proxied": True}) == []
    # An explicit range list is unaffected by the rule.
    assert errs({"vultr-http-sources": ["1.2.3.0/24"], "cloudflare-proxied": False}) == []


def test_proxy_hops_must_account_for_both_proxies():
    # Cloudflare, then Caddy. n8n's default of 0 trusts the nearest hop.
    assert has({"n8n-proxy-hops": 1}, "at least 2")
    assert errs({"n8n-proxy-hops": 3}) == []


# --- blast radius -----------------------------------------------------------


def test_live_data_must_not_share_a_bucket_with_tofu_state():
    assert has({"neon-r2-bucket": fixture()["r2-bucket"]},
               "must not be the OpenTofu state bucket")


def test_backups_must_not_share_a_bucket_with_state_or_live_data():
    assert has({"n8n-backup-r2-bucket": fixture()["r2-bucket"]},
               "must not be the state or live-data bucket")
    assert has({"n8n-backup-r2-bucket": fixture()["neon-r2-bucket"]},
               "must not be the state or live-data bucket")


# --- storage tier identity --------------------------------------------------


def test_tenant_and_timeline_are_fixed_desired_state():
    for key in ["neon-tenant-id", "neon-timeline-id"]:
        assert has({key: "not-hex"}, "32 lowercase hex")


def test_the_application_role_must_not_be_cloud_admin():
    assert has({"neon-role": "cloud_admin"}, "must not be cloud_admin")


def test_images_must_be_digest_pinned():
    assert has({"n8n-image": "docker.io/n8nio/n8n:2.36.9"}, "pinned by digest")


# --- soak thresholds --------------------------------------------------------


def test_soak_mix_must_sum_to_one_hundred():
    assert has({"n8n-soak-mix-api-percent": 50}, "must sum to 100")


# --- credentials ------------------------------------------------------------


def test_the_split_r2_pair_is_preferred_and_the_shared_pair_is_the_fallback():
    shared = v.effective_r2(fixture({"r2-access-key-id": "a", "r2-secret-access-key": "b"}))
    split = v.effective_r2(fixture({"r2-access-key-id": "a", "r2-secret-access-key": "b",
                                    "neon-r2-access-key-id": "c",
                                    "neon-r2-secret-access-key": "d"}))
    assert shared["split"] is False
    assert shared["access-key-id"] == "a"
    assert split["split"] is True
    assert split["access-key-id"] == "c"


def test_sharing_one_r2_credential_must_be_a_deliberate_choice():
    # The package already refuses to let backups share a BUCKET with state or
    # live data; letting them silently share a CREDENTIAL was the same property
    # enforced on one axis and ignored on the other.
    creds = {"vultr-api-key": "v", "cloudflare-api-token": "c",
             "r2-access-key-id": "a", "r2-secret-access-key": "b",
             "n8n-encryption-key": "k" * 32}

    def secret_errs(overrides: dict | None = None) -> list[str]:
        return v.secret_errors(fixture({**creds, **(overrides or {})}), "create")

    # The shared pair alone is refused.
    assert any(re.search("same R2 credential as OpenTofu state and live", e)
               for e in secret_errs())
    assert any(re.search("live Neon data would use the same R2 credential", e)
               for e in secret_errs())

    # Scoped pairs satisfy it with no opt-out.
    assert [e for e in secret_errs({"neon-r2-access-key-id": "c",
                                    "neon-r2-secret-access-key": "d",
                                    "n8n-backup-r2-access-key-id": "e",
                                    "n8n-backup-r2-secret-access-key": "f"})
            if re.search("same R2 credential", e)] == []

    # The shared pair is reachable only as a recorded, committed choice.
    assert [e for e in secret_errs({"r2-credential-sharing": "shared-accepted"})
            if re.search("same R2 credential", e)] == []

    # And the opt-out itself is validated.
    assert has({"r2-credential-sharing": "yes-whatever"}, "must be split or shared-accepted")
    assert errs({"r2-credential-sharing": "split"}) == []


def test_the_backup_scoping_gate_is_conditional():
    # Making it mandatory would fail every converge on the shared credential,
    # which is the credential model actually in use.
    assert v.backup_credential_scoped(fixture()) is False
    assert v.backup_credential_scoped(fixture({"n8n-backup-r2-access-key-id": "a",
                                               "n8n-backup-r2-secret-access-key": "b"})) is True


def test_the_encryption_key_must_be_long_enough():
    creds = {"vultr-api-key": "v", "cloudflare-api-token": "c",
             "r2-access-key-id": "a", "r2-secret-access-key": "b"}
    assert any(re.search("at least 32 characters", e) for e in
               v.secret_errors(fixture({**creds, "n8n-encryption-key": "short"}), "create"))
    assert [e for e in v.secret_errors(
        fixture({**creds, "n8n-encryption-key": "a" * 32}), "create")
        if re.search("N8N_ENCRYPTION_KEY", e)] == []


def test_profile_may_not_be_overlaid_from_the_environment():
    assert v.env_errors({v.profile_par: "somewhere-else"})
    assert v.env_errors({}) == []
