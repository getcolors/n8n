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
    assert step("n8n/infrastructure")[1] == "n8n/ssh-cleanup"
    assert len(step("n8n/ssh-cleanup")) == 1


def test_both_tofu_stages_carry_their_own_backend_key():
    opts = {"profile": "n8n-fixture", "workdir": ".colors"}
    assert workflow.backend_advice(tools.dns_tool) is not None
    assert tools.tool_dir(opts, tools.dns_tool).endswith("n8n-fixture/n8n-dns")
    assert tools.tool_dir(opts, tools.infrastructure_tool) \
        .endswith("n8n-fixture/n8n-infrastructure")
