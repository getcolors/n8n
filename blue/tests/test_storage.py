"""The managed S3 storage stage: what it requires, what it hands the converge,
and what it refuses to adopt."""

from __future__ import annotations

import json
import re
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from conftest import aws, fixture

from package_n8n_blue import storage, validate


def managed(overrides: dict | None = None) -> dict:
    return aws({"n8n-storage-managed": True, **(overrides or {})})


CREDENTIALS = {"credentials": {role: {"access_key_id": f"{role}-id",
                                      "secret_access_key": f"{role}-secret"}
                               for role in ["neon", "backup"]}}


def result(exit=0, out="", err=""):
    return SimpleNamespace(exit=exit, out=out, err=err)


def test_managed_storage_requires_aws_compute_and_s3_state():
    assert validate.state_errors(managed()) == []
    # The message names the requirement, so a Vultr deployment that flips the
    # flag learns what the flag means.
    flipped = validate.state_errors(fixture({"n8n-storage-managed": True}))
    assert "managed storage requires :provider-compute aws" in flipped
    assert "managed storage requires :provider-backend s3" in flipped
    for change in [{"n8n-storage-managed": "true"},
                   {"neon-r2-region": "auto"},
                   {"n8n-backup-r2-region": "eu-west-1"},
                   {"neon-r2-bucket": "Not_A_Bucket"},
                   {"n8n-backup-r2-bucket": aws()["neon-r2-bucket"]},
                   {"s3-bucket": aws()["neon-r2-bucket"]}]:
        assert validate.state_errors(managed(change)), change


def test_managed_storage_exempts_the_operator_pairs_and_the_sharing_gate():
    # The pairs are minted and scoped by construction, so neither the
    # COLORS_PAR_NEON_R2_* requirement nor the blast-radius gate applies.
    assert set(validate.secret_errors(managed(), "create")) == {
        "required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN",
        "required credential is not set: COLORS_PAR_N8N_ENCRYPTION_KEY"}
    assert validate.secret_errors(
        managed({"cloudflare-api-token": "c", "n8n-encryption-key": "k" * 32}), "create") == []
    # Unmanaged AWS desired state still asks for the pairs.
    assert any(re.search("COLORS_PAR_NEON_R2_ACCESS_KEY_ID", e)
               for e in validate.secret_errors(aws(), "create"))
    assert any(re.search("same R2 credential", e)
               for e in validate.secret_errors(
                   aws({"cloudflare-api-token": "c", "n8n-encryption-key": "k" * 32,
                        "r2-access-key-id": "a", "r2-secret-access-key": "b"}), "create"))


async def test_the_storage_step_is_a_no_op_when_unmanaged(monkeypatch):
    runner = AsyncMock(side_effect=AssertionError("unmanaged storage must not provision"))
    monkeypatch.setattr(storage.runtime, "exec", runner)
    assert (await storage.storage_step(fixture({"blue/event": "create"})))["blue/exit"] == 0
    assert (await storage.storage_step(aws({"blue/event": "delete"})))["blue/exit"] == 0
    assert not runner.called


def test_minted_pairs_reach_the_existing_lookups_and_nothing_else():
    env = storage.credential_env(managed({"n8n/storage-credentials": CREDENTIALS}))
    assert env["COLORS_PAR_NEON_R2_ACCESS_KEY_ID"] == "neon-id"
    assert env["COLORS_PAR_NEON_R2_SECRET_ACCESS_KEY"] == "neon-secret"
    assert env["COLORS_PAR_N8N_BACKUP_R2_ACCESS_KEY_ID"] == "backup-id"
    assert env["COLORS_PAR_N8N_BACKUP_R2_SECRET_ACCESS_KEY"] == "backup-secret"
    assert env["ANSIBLE_HOST_KEY_CHECKING"] == "False"
    assert "AWS_ACCESS_KEY_ID" not in env
    # String keys, as the tofu output JSON leaves nested values.
    wire = json.loads(json.dumps(CREDENTIALS))
    env = storage.credential_env(managed({"n8n/storage-credentials": wire}))
    assert env["COLORS_PAR_N8N_BACKUP_R2_SECRET_ACCESS_KEY"] == "backup-secret"
    # An absent pair is a refusal, never an empty variable.
    with pytest.raises(RuntimeError):
        storage.credential_env(managed())
    with pytest.raises(RuntimeError):
        storage.credential_env(managed({"n8n/storage-credentials": {
            "credentials": {"neon": CREDENTIALS["credentials"]["neon"],
                            "backup": {"access_key_id": " ", "secret_access_key": ""}}}}))


@pytest.mark.parametrize("probe", [result(), result(1, err="(403) Forbidden")])
async def test_ownership_rejects_existing_buckets(monkeypatch, probe):
    runner = AsyncMock(side_effect=[result(), result(), probe])
    monkeypatch.setattr(storage.runtime, "exec", runner)
    with pytest.raises(RuntimeError, match="refuses to adopt"):
        await storage.ownership_preflight(managed())


async def test_ownership_rejects_unreadable_state(monkeypatch):
    runner = AsyncMock(side_effect=[result(), result(1, err="AccessDenied")])
    monkeypatch.setattr(storage.runtime, "exec", runner)
    with pytest.raises(RuntimeError, match="state unavailable"):
        await storage.ownership_preflight(managed())


async def test_a_first_create_probes_both_buckets_and_passes_on_404(monkeypatch):
    runner = AsyncMock(side_effect=[result(), result(1, err="No state file was found!"),
                                    *[result(254, err="(404) Not Found")] * 2])
    monkeypatch.setattr(storage.runtime, "exec", runner)
    await storage.ownership_preflight(managed())
    assert {call.args[0][4] for call in runner.call_args_list[2:]} == \
        {aws()["neon-r2-bucket"], aws()["n8n-backup-r2-bucket"]}
    assert {call.kwargs["cwd"] for call in runner.call_args_list} == {storage.directory(managed())}


async def test_a_tracked_address_must_name_the_configured_bucket(monkeypatch):
    shown = json.dumps({"values": {"root_module": {"resources": [
        {"address": 'aws_s3_bucket.application["neon"]',
         "values": {"bucket": "someone-elses-bucket"}}]}}})
    runner = AsyncMock(side_effect=[result(), result(out='aws_s3_bucket.application["neon"]'),
                                    result(out=shown), result()])
    monkeypatch.setattr(storage.runtime, "exec", runner)
    with pytest.raises(RuntimeError, match="refuses to adopt"):
        await storage.ownership_preflight(managed())


def test_aws_overlays_reach_the_sdk_names_only_when_supplied():
    assert storage.aws_env(aws()) == {}
    env = storage.aws_env(aws({"aws-access-key-id": "id", "aws-secret-access-key": "secret",
                               "aws-session-token": ""}))
    assert env == {"AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "secret"}


def test_the_storage_stage_renders_the_embedded_template_under_its_own_directory(tmp_path):
    opts = managed({"workdir": str(tmp_path)})
    [document] = storage.specs(opts)
    assert document["target"] == f"{tmp_path}/{opts['profile']}/n8n-storage/main.tf"
    assert 'resource "aws_s3_bucket" "application"' in document["template"]["content"]
