"""Singleton compute delegation; DNS and warehouse configuration remain local."""
import json
import os
from blue.cli import stage_dir
from pathlib import Path
from colors_compute import orchestrate, plan_deployment, read_deployment, validate, backend_plan, source_cidrs

TOPOLOGY = [{'count': 1}]


def ipv4_only(opts, ranges):
    """The AWS adapter accepts IPv4 sources only, so a symbolic range set loses
    its IPv6 members there. Explicit operator CIDRs are left alone and validate
    against the provider as written."""
    return [cidr for cidr in ranges if ':' not in cidr] if opts.get('provider-compute') == 'aws' else ranges


def requirements(opts):
    ssh = source_cidrs(opts, 'ssh-sources', 'n8n-ssh-sources')
    http = source_cidrs(opts, 'http-sources', 'n8n-http-sources')
    if http == ['cloudflare']: http = ipv4_only(opts, json.loads((Path(__file__).parent/'resources/origin-ranges.json').read_text()))
    return {'single_host': True, 'security': {'egress': 'all', 'private_filter': False, 'ingress': [
        {'id': 'ssh', 'protocol': 'tcp', 'from_port': 22, 'to_port': 22, 'sources': ssh},
        *[{'id': 'web-' + str(port), 'protocol': 'tcp', 'from_port': port, 'to_port': port, 'sources': http} for port in (80, 443)]
    ]}, 'legacy_state_keys': [opts['profile'] + '/n8n-infrastructure.tfstate']}


def settings(opts):
    return dict(opts)


def errors(opts):
    try:
        configured = settings(opts)
        result = validate(configured)
        if result:
            return result
        plan_deployment(configured, TOPOLOGY, requirements(configured))
        return []
    except (ValueError, TypeError, KeyError):
        return ['invalid singleton compute requirements']


def attach(opts, result):
    if result.get('status') not in ('planned', 'ready', 'present', 'destroyed'):
        return {**opts, 'blue/exit': 1, 'blue/err': '\n'.join(result.get('errors', [])) or 'compute lifecycle refused'}
    if result.get('status') == 'destroyed':
        return {**opts, 'blue/exit': 0, 'n8n/already-destroyed': True}
    cluster = result.get('cluster', {})
    node = next((node for node in cluster.get('nodes', []) if node['node_id'] == cluster.get('entry_node_id')), {})
    key = result.get('key', {})
    return {**opts, 'blue/exit': 0, 'colors-compute/cluster': cluster, 'colors-compute/key': key,
            **node, 'ssh-private-key-path': key.get('private_key_path') or node.get('ssh_identity_file')}


async def compute_step(opts, env=None):
    """Plan on build and dry-run; orchestrate otherwise. `env` is the
    subprocess environment the library hands its providers, so a caller can
    add AWS credentials supplied as COLORS_PAR_AWS_* without exporting them
    globally."""
    configured = settings(opts)
    environment = dict(os.environ) if env is None else env
    planning = opts.get('blue/event') == 'build' or opts.get('blue/dry-run')
    result = plan_deployment(configured, TOPOLOGY, requirements(configured)) if planning else await orchestrate(configured, TOPOLOGY, requirements(configured), environment)
    if planning:
        directory = Path(stage_dir(opts, 'compute'))
        stacks = [('shared', result['documents']['shared']), *[('nodes/' + node, docs) for node, docs in result['documents']['nodes'].items()]]
        for suffix, documents in stacks:
            target = directory / suffix
            target.mkdir(parents=True, exist_ok=True)
            state_key = result['state_keys']['shared'] if suffix == 'shared' else result['state_keys']['nodes'][suffix.split('/')[-1]]
            documents = {**documents, 'backend.tf.json': backend_plan(configured, state_key)['config']}
            for name, document in documents.items():
                (target / name).write_text(json.dumps(document, sort_keys=True, indent=2) + '\n')
    return attach(opts, result)


async def load_step(opts, env=None):
    """Read the recorded deployment before a delete. With a managed S3 state
    bucket any status but `present` means the application stages have nothing
    left to act on, and the delete goes straight to backend finalization: the
    bucket may already be half-finalized, or gone, and neither is a compute
    state to adopt."""
    if opts.get('blue/dry-run'):
        return opts
    environment = dict(os.environ) if env is None else env
    result = await read_deployment(settings(opts), environment, None, requirements(opts))
    if opts.get('s3-bucket-mode') == 'managed' and result.get('status') != 'present':
        return {**opts, 'blue/exit': 0, 'n8n/finalize-only': True}
    return attach(opts, result)


def symbolic_http(opts):
    try: return source_cidrs(opts, 'http-sources', 'n8n-http-sources') == ['cloudflare']
    except (ValueError, TypeError, KeyError): return False
