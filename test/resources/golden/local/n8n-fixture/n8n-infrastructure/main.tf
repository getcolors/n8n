terraform {
  required_providers {
    vultr = { source = "vultr/vultr", version = "~> 2.0" }
  }
}

provider "vultr" {
  # api key comes from VULTR_API_KEY in the environment
}

locals {
  ssh_sources  = ["0.0.0.0/0", "::/0"]
  # Resolved from Cloudflare's published ranges by the package when
  # `vultr-http-sources` is the symbolic value `cloudflare`, and recorded with
  # a checksum in generated metadata. This is NOT a pinned list in desired
  # state -- it is a resolution, and a failed or malformed fetch fails the
  # converge rather than falling back to a permissive rule.
  http_sources = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"]
}

# The machine keypair this deployment generated and owns (SSH Keypair
# Standard): the account resource is named after the profile and lives in this
# stack's state, which is what makes its ownership decidable. Never reference a
# literal key id here in keygen mode.
resource "vultr_ssh_key" "machine" {
  name    = "n8n-fixture"
  ssh_key = trimspace(file("/home/build-placeholder/.ssh/n8n-fixture.pub"))
}

# Every label derives from one resolved name (Compute Name Standard §3), which
# is the profile unless desired state overrides it with vultr-name.
resource "vultr_firewall_group" "n8n" {
  description = "n8n-fixture-firewall"
}

# Unlike the Neon deployment this package builds on, 22 is NOT the only open
# port: n8n is a public application whose entire purpose is receiving webhooks
# from third parties. 80 and 443 are open, but only to Cloudflare -- see
# http_sources above. Publishing the origin to the whole internet would make
# `cloudflare-proxied` cosmetic: anyone who found the address could bypass the
# edge and forge the X-Forwarded-For header that Caddy is configured to trust.
#
# 22 remains open to the internet by workspace convention, key-only. That is a
# deliberate, stated deviation rather than an oversight, and the negative
# controls (no password auth, no root password login) are asserted by an
# acceptance gate rather than assumed from the image defaults.
#
# Convergence, recovery, and the supported client
# path — an SSH tunnel to the loopback-bound Postgres — all ride it. Every
# Neon service binds to 127.0.0.1 on the host, so there is nothing else a
# firewall rule could gate: no HTTP, no public 5432.
resource "vultr_firewall_rule" "ssh" {
  for_each          = toset(local.ssh_sources)
  firewall_group_id = vultr_firewall_group.n8n.id
  protocol          = "tcp"
  port              = "22"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}

# 80 as well as 443: Caddy answers the ACME HTTP-01 challenge there, and with
# the record proxied that challenge arrives from a Cloudflare address, which
# these rules admit. Were the record unproxied, the challenge would come from
# Let's Encrypt directly, be dropped here, and the converge would still succeed
# -- with the failure surfacing later as the first HTTPS request hitting a
# certificate that was never issued. The validator refuses that combination.
resource "vultr_firewall_rule" "http" {
  for_each          = toset(local.http_sources)
  firewall_group_id = vultr_firewall_group.n8n.id
  protocol          = "tcp"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
  port              = "80"
}

resource "vultr_firewall_rule" "https" {
  for_each          = toset(local.http_sources)
  firewall_group_id = vultr_firewall_group.n8n.id
  protocol          = "tcp"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
  port              = "443"
}

resource "vultr_instance" "n8n" {
  # `label` is the console name and updates in place. There is deliberately no
  # `hostname`: Vultr implements a hostname change as an OS reinstall, so the
  # provider marks that attribute ForceNew, and editing the name would
  # destroy the instance and its disk rather than rename it.
  label             = "n8n-fixture"
  region            = "ams"
  plan              = "vhp-8c-16gb-amd"
  os_id             = 2284
  firewall_group_id = vultr_firewall_group.n8n.id
  # SSH keys are ids already in the account, and ForceNew: changing the key set
  # destroys and recreates the instance instead of re-authorizing it. Rotation
  # is a rebuild, never an edit on a machine whose disk you intend to keep.
  ssh_key_ids = [vultr_ssh_key.machine.id]
  # Wait for ssh before starting Ansible.
  connection {
    type = "ssh"
    user = "root"
    host = self.main_ip
    private_key = file("/home/build-placeholder/.ssh/n8n-fixture")
  }
  provisioner "remote-exec" {
    inline = ["ls"]
  }
  lifecycle { prevent_destroy = true }
}

output "params" {
  value = {
    ip     = vultr_instance.n8n.main_ip
    user   = "root"
    sudoer = "root"
    name   = "n8n-fixture"
    ssh_key_id = vultr_ssh_key.machine.id
  }
}
