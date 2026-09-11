from pathlib import Path

from blue.cli import load_yaml

ROOT = Path(__file__).resolve().parents[2]


def _load(name: str, overrides: dict | None = None) -> dict:
    text = (ROOT / "test" / "fixtures" / name).read_text().replace("WORKDIR", ".colors")
    return {**load_yaml(text), **(overrides or {})}


def fixture(overrides: dict | None = None) -> dict:
    return _load("colors.yml", overrides)


def optout(overrides: dict | None = None) -> dict:
    return _load("optout.yml", overrides)


def aws_fixture(overrides: dict | None = None) -> dict:
    """The committed AWS fixture: managed S3 state bucket and managed storage."""
    return _load("aws.yml", overrides)


def aws(overrides: dict | None = None) -> dict:
    """The same deployment on AWS with an S3 state bucket, derived from the
    Vultr base the way green's validate_test does: no vultr-* or r2-* keys,
    native S3 endpoints in the neon-* vocabulary, IPv4 sources only, and
    managed storage left OFF so the storage tests can flip it deliberately."""
    base = {k: v for k, v in fixture().items()
            if k not in ["vultr-region", "vultr-plan", "vultr-os-id", "vultr-ssh-sources",
                         "vultr-http-sources", "r2-bucket", "r2-endpoint"]}
    return {**base,
            "provider-compute": "aws", "provider-backend": "s3",
            "s3-bucket": "n8n-test-state-123456789012-us-east-1", "s3-region": "us-east-1",
            "s3-bucket-mode": "managed",
            "neon-r2-bucket": "n8n-test-neon-123456789012-us-east-1",
            "neon-r2-endpoint": "https://s3.us-east-1.amazonaws.com", "neon-r2-region": "us-east-1",
            "n8n-backup-r2-bucket": "n8n-test-backup-123456789012-us-east-1",
            "aws-region": "us-east-1", "aws-availability-zone": "us-east-1a",
            "aws-image-id": "ami-025d99823a4caad37", "aws-instance-type": "t3.xlarge",
            "aws-root-volume-size-gb": 60, "aws-vpc-cidr": "10.76.0.0/16",
            "aws-subnet-cidr": "10.76.1.0/24",
            "n8n-ssh-sources": ["0.0.0.0/0"], "n8n-http-sources": "cloudflare",
            **(overrides or {})}
