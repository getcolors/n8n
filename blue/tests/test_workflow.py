from __future__ import annotations

from package_n8n_blue import tools, workflow


def test_create_renders_dns_before_the_converge():
    # Caddy's ACME HTTP-01 challenge needs the name to resolve already;
    # converging first would make the first boot fail its certificate and retry
    # on ACME's backoff.
    def step(name: str):
        return workflow.wire_fn(name, {"blue/event": "create"})

    assert step("n8n/infrastructure")[1] == "n8n/dns"
    assert step("n8n/dns")[1] == "n8n/ssh-config"
    assert step("n8n/ssh-config")[1] == "n8n/ansible"
    assert step("n8n/ansible")[1] == "n8n/acceptance"


def test_delete_removes_dns_and_the_config_block_before_the_destroy():
    # A record pointing at an address that no longer answers is a live outage;
    # the keypair is the opposite and goes after the compute destroy, or the
    # operator is locked out of a machine that still exists.
    def step(name: str):
        return workflow.wire_fn(name, {"blue/event": "delete"})

    assert step("n8n/ssh-config")[1] == "n8n/dns"
    assert step("n8n/dns")[1] == "n8n/infrastructure"
    assert len(step("n8n/infrastructure")) == 1


def test_both_tofu_stages_carry_their_own_backend_key():
    opts = {"profile": "n8n-fixture", "workdir": ".colors"}
    assert workflow.backend_advice(tools.dns_tool) is not None
    assert tools.tool_dir(opts, tools.dns_tool).endswith("n8n-fixture/n8n-dns")
    assert tools.tool_dir(opts, tools.infrastructure_tool) \
        .endswith("n8n-fixture/n8n-infrastructure")


# --- managed storage and the managed state bucket -----------------------------


def successors(step: str, run_opts: dict) -> list[str]:
    return list(workflow.wire_fn(step, run_opts)[1:])


def test_the_unmanaged_graph_is_unchanged():
    create, delete = {"blue/event": "create"}, {"blue/event": "delete"}
    assert successors("n8n/start", create) == ["n8n/infrastructure"]
    assert successors("n8n/infrastructure", create) == ["n8n/dns"]
    assert successors("n8n/dns", create) == ["n8n/ssh-config"]
    assert successors("n8n/ssh-config", create) == ["n8n/ansible"]
    assert successors("n8n/ansible", create) == ["n8n/acceptance"]
    assert successors("n8n/start", delete) == ["n8n/load"]
    assert successors("n8n/load", delete) == ["n8n/ansible"]
    assert successors("n8n/dns", delete) == ["n8n/infrastructure"]
    assert successors("n8n/infrastructure", delete) == []


def test_managed_storage_sits_between_compute_and_dns():
    create = {"blue/event": "create", "n8n-storage-managed": True, "s3-bucket-mode": "managed"}
    delete = {**create, "blue/event": "delete"}
    # create: infrastructure, storage, dns
    assert successors("n8n/infrastructure", create) == ["n8n/storage"]
    assert successors("n8n/storage", create) == ["n8n/dns"]
    # delete: dns, storage, infrastructure, then the state bucket last of all
    assert successors("n8n/dns", delete) == ["n8n/storage"]
    assert successors("n8n/storage", delete) == ["n8n/infrastructure"]
    assert successors("n8n/infrastructure", delete) == ["n8n/backend-finalize"]
    assert successors("n8n/backend-finalize", delete) == []


def test_a_managed_state_bucket_is_finalized_even_without_managed_storage():
    delete = {"blue/event": "delete", "s3-bucket-mode": "managed"}
    assert successors("n8n/dns", delete) == ["n8n/infrastructure"]
    assert successors("n8n/infrastructure", delete) == ["n8n/backend-finalize"]


def test_a_delete_that_finds_no_live_compute_goes_straight_to_finalization():
    # The load step marks it; the router honours the mark only there.
    assert workflow.next_fn("n8n/load", ["n8n/ansible"], {"n8n/finalize-only": True}) == \
        [("n8n/backend-finalize", {"n8n/finalize-only": True})]
    assert workflow.next_fn("n8n/load", ["n8n/ansible"], {}) == [("n8n/ansible", {})]
    assert workflow.next_fn("n8n/ansible", ["n8n/ssh-config"], {"blue/exit": 1}) == []


def test_every_new_stage_is_skipped_by_dry_run():
    assert "n8n/storage" in workflow.side_effecting
    assert "n8n/backend-finalize" in workflow.side_effecting


def test_the_storage_stage_carries_its_own_backend_key():
    from package_n8n_blue import storage
    opts = {"profile": "n8n-fixture", "workdir": ".colors"}
    assert workflow.backend_advice(storage.tool) is not None
    assert storage.directory(opts).endswith("n8n-fixture/n8n-storage")


async def test_the_load_step_marks_finalize_only_under_a_managed_bucket(monkeypatch):
    from package_n8n_blue import compute

    async def absent(*args):
        return {"status": "absent"}

    monkeypatch.setattr(compute, "read_deployment", absent)
    marked = await compute.load_step({"profile": "p", "s3-bucket-mode": "managed",
                                      "provider-compute": "aws", "n8n-ssh-sources": ["0.0.0.0/0"],
                                      "n8n-http-sources": ["1.2.3.0/24"]}, {})
    assert marked["blue/exit"] == 0 and marked["n8n/finalize-only"] is True
    # Without a managed bucket the library's answer is attached as before.
    plain = await compute.load_step({"profile": "p", "provider-compute": "aws",
                                     "n8n-ssh-sources": ["0.0.0.0/0"],
                                     "n8n-http-sources": ["1.2.3.0/24"]}, {})
    assert plain["blue/exit"] == 1 and "n8n/finalize-only" not in plain
