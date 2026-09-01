from __future__ import annotations

import json
from pathlib import Path

from conftest import fixture

from package_n8n_blue import tools


def test_the_neon_bundle_renders_from_the_dependency_not_a_local_copy():
    # Every storage-tier template must be the installed `package-neon-blue`'s
    # bytes. Name-checking alone would not catch a second copy, because one of
    # these — `cleanup.yml` — shares a basename with a file this package owns;
    # that collision is the whole reason the bundle renders into its own
    # directory, where relative `src:` names in the upstream play cannot
    # resolve to an n8n file.
    specs = tools.neon_specs("/tmp/stage", {})
    assert len(specs) == 12
    for spec in specs:
        name = spec["template"]["name"]
        assert name.startswith("neon/tools/ansible/")
        assert "/neon/" in spec["target"]
        file = name[len("neon/tools/ansible/"):]
        assert spec["template"]["content"] == \
            (tools.NEON_ROOT / "tools" / "ansible" / file).read_text()
    # And the colliding name really does differ, so the check above is not
    # passing by accident.
    local = tools.ROOT / "tools" / "ansible" / "cleanup.yml"
    assert local.is_file()
    assert local.read_text() != (tools.NEON_ROOT / "tools" / "ansible" / "cleanup.yml").read_text()


def test_the_ansible_local_stage_is_the_dependencys_too():
    # Writing our own dropped its `<% if ssh-keygen %> private_key_file`
    # conditional, and the deployment then had no identity to offer.
    for spec in tools.ansible_local_specs(fixture()):
        assert spec["template"]["name"].startswith("neon/tools/ansible-local/")
    assert not (tools.ROOT / "tools" / "ansible-local").exists()


def test_the_inventory_places_one_host_in_both_groups():
    # The imported neon play targets `neon`, this package's targets `n8n`, and
    # both converge the same machine.
    inv = json.loads(tools.inventory({"profile": "p", "ip": "10.0.0.1"}))
    assert set(inv["all"]["children"]) == {"neon", "n8n"}
    assert "p" in inv["all"]["children"]["neon"]["hosts"]
    assert "p" in inv["all"]["children"]["n8n"]["hosts"]
    # Variables are HOST vars, never group vars -- group_vars precedence
    # between two groups on one host would be a live hazard.
    assert inv["all"]["hosts"]["p"]["ansible_host"] == "10.0.0.1"
    assert "vars" not in inv["all"]["children"]["neon"]
    assert "vars" not in inv["all"]["children"]["n8n"]


def test_http_sources_resolve_explicit_lists_verbatim():
    resolved = tools.http_sources({"vultr-http-sources": ["1.2.3.0/24", "::/0"]})
    assert resolved["source"] == "explicit"
    assert resolved["ranges"] == ["1.2.3.0/24", "::/0"]


def test_the_cloudflare_fallback_is_never_permissive():
    # A failed range fetch must not widen to 0.0.0.0/0.
    assert "0.0.0.0/0" not in tools.cloudflare_ranges_fallback
    assert "::/0" not in tools.cloudflare_ranges_fallback
    assert len(tools.cloudflare_ranges_fallback) > 10


def test_the_range_checksum_is_order_independent():
    # The recorded checksum identifies the SET, so a provider reordering its
    # published list is not a firewall change.
    assert tools.ranges_checksum(["a", "b"]) == tools.ranges_checksum(["b", "a"])
    assert tools.ranges_checksum(["a", "b"]) != tools.ranges_checksum(["a", "c"])


def test_the_dns_record_is_proxied_with_an_automatic_ttl():
    # Cloudflare rejects an explicit TTL on a proxied record, and the zone data
    # source is named `zone` with attribute `id` -- both were wrong on the
    # first live converge and only failed at apply time.
    doc = json.loads(tools.dns_json({"n8n-host": "n8n.example.com",
                                     "ip": "203.0.113.5",
                                     "cloudflare-proxied": True}))
    body = doc["resource"]["cloudflare_dns_record"]["n8n"]
    assert body["zone_id"] == "${data.cloudflare_zone.zone.id}"
    assert body["name"] == "n8n.example.com"
    assert body["ttl"] == 1
    assert body["proxied"] is True
