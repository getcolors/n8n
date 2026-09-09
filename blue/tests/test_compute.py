import json
import pytest
import yaml
from conftest import fixture
from package_n8n_blue import compute, tools

@pytest.mark.parametrize('managed', [True, False])
async def test_singleton_artifacts_and_owned_ssh_block(tmp_path, managed):
    opts = {**fixture(), 'workdir': str(tmp_path/'render'), 'blue/event':'build'}
    if not managed: opts['vultr-ssh-keys'] = ['existing-key']
    result = await compute.compute_step(opts)
    assert result['blue/exit'] == 0 and result['name'] == opts['profile']
    assert result['ip'] == '192.0.2.10' and result['vpc_ip'] is None
    await tools.ansible_local_step(result)
    play = yaml.safe_load((tmp_path/'render/n8n-fixture/n8n-ansible-local/main.yml').read_text())
    assert play[0]['vars']['colors_keygen'] is managed
    code = play[0]['tasks'][0]['ansible.builtin.command']['argv'][-1]
    scope = {'__name__':'copied_updater'}
    exec(compile(code, '<packaged-ssh-updater>', 'exec'), scope)
    home = tmp_path/'home'; home.mkdir()
    payload = {'host_alias': opts['profile'], 'ssh_hosts':[{'name':opts['profile'],'ip':result['ip'],'user':result['user']}], 'keygen':managed, 'block_state':'present'}
    assert scope['update'](payload, home)
    config = (home/'.ssh/config').read_text()
    assert 'Host n8n-fixture\n' in config and 'HostName 192.0.2.10' in config
    assert ('IdentityFile ~/.ssh/n8n-fixture' in config) is managed
    assert not scope['update'](payload, home)
    assert scope['update']({**payload,'block_state':'absent'}, home)
    (home/'.ssh/config').write_text('Host=n8n-fixture\n HostName 198.51.100.8\n')
    with pytest.raises(ValueError): scope['update'](payload,home)
    assert '198.51.100.8' in (home/'.ssh/config').read_text()
    docs=json.loads((tmp_path/'render/n8n-fixture/compute/nodes/0/node-none.tf.json').read_text())
    assert 'provisioner' not in json.dumps(docs)

async def test_compute_refusal_stops_before_app_mutation(tmp_path, monkeypatch):
    async def refuse(*args):return {'status':'error','errors':['owned state mismatch']}
    monkeypatch.setattr(compute,'orchestrate',refuse)
    result=await compute.compute_step({**fixture(),'blue/event':'create','workdir':str(tmp_path)})
    assert result['blue/exit']==1 and result['blue/err']=='owned state mismatch'
    assert 'ip' not in result

async def test_external_private_path_is_forwarded_to_ansible(tmp_path, monkeypatch):
    captured={}
    async def fake(opts,specs,**options):captured.update(options);return opts
    monkeypatch.setattr(tools,'ansible_with_spec',fake)
    await tools.ansible_step({**fixture(),'workdir':str(tmp_path),'ip':'192.0.2.10','user':'ubuntu','ssh-private-key-path':'/selected/key'})
    assert captured['private_key']=='/selected/key'


def test_preflight_recognizes_equals_host():
    from package_n8n_blue.ssh_config import foreign_stanza_line
    assert foreign_stanza_line(["Host *", "Host=n8n-fixture"], "n8n-fixture") == 2


async def test_cloudflare_fetch_failure_stops_before_compute(tmp_path, monkeypatch):
    monkeypatch.setattr(tools, 'fetch_cloudflare_ranges', lambda: None)
    async def forbidden(*args): raise AssertionError('compute dispatched')
    monkeypatch.setattr(compute, 'compute_step', forbidden)
    result = await tools.infrastructure_step({**fixture(), 'workdir':str(tmp_path), 'blue/event':'create'})
    assert result['blue/exit'] == 1
    assert result['blue/err'] == 'Cloudflare origin ranges unavailable'


async def test_dns_has_own_backend_credentials(tmp_path, monkeypatch):
    captured = {}
    async def fake(opts, specs, **kwargs): captured.update(kwargs); return opts
    monkeypatch.setattr(tools.tofu, 'tofu_with_spec', fake)
    opts = {**fixture(), 'workdir':str(tmp_path), 'ip':'192.0.2.10','provider-backend':'r2',
            'r2-access-key-id':'test-backend-id','r2-secret-access-key':'test-backend-secret','vultr-api-key':'compute-only'}
    await tools.dns_step(opts)
    assert captured['env']['AWS_ACCESS_KEY_ID'] == 'test-backend-id'
    assert captured['env']['AWS_SECRET_ACCESS_KEY'] == 'test-backend-secret'
    assert 'VULTR_API_KEY' not in captured['env']
    assert opts['vultr-api-key'] == 'compute-only'
