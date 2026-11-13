#!/usr/bin/env python3
"""Run only in a disposable Linux container with an empty /opt.

XKEEN_UI_SMOKE_CONTAINER=1 python3 tests/panel-api-smoke.py /path/to/xkeen-ui /path/to/xray
Optional third argument: real Mihomo binary. No router, external proxy, or Internet connection is used.
"""
import http.cookiejar
import http.server
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_CONNECT(self):
        self.send_response(200)
        self.end_headers()
        while self.rfile.readline():
            while self.rfile.readline().strip():
                pass
            time.sleep(getattr(self.server, 'delay', 0))
            self.wfile.write(b'HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\nX-Fixture: '
                             + str(self.server.server_port).encode() + b'\r\n\r\n')
            self.wfile.flush()


def main():
    assert os.environ.get('XKEEN_UI_SMOKE_CONTAINER') == '1', 'Disposable test container required'
    assert not Path('/opt/etc/xkeen').exists(), 'Expected an empty /opt; refusing to overwrite settings'
    binary, xray = map(lambda value: str(Path(value).resolve()), sys.argv[1:3])
    mihomo = str(Path(sys.argv[3]).resolve()) if len(sys.argv) > 3 else None
    for name in ('etc/mihomo', 'etc/xkeen', 'etc/xray/configs', 'etc/xray/dat', 'etc/init.d', 'sbin', 'var/log/xray'):
        Path('/opt', name).mkdir(parents=True, exist_ok=True)
    Path('/opt/sbin/xray').symlink_to(xray)
    if mihomo: Path('/opt/sbin/mihomo').symlink_to(mihomo)
    os.environ['PATH'] = '/opt/sbin:' + os.environ['PATH']
    init = Path('/opt/etc/init.d/S99xkeen')
    init.write_text('''#!/usr/bin/env python3
import os, pathlib, signal, subprocess, sys, time
# name_client="xray"
core = next(line.split('=', 1)[1].strip().strip(chr(34)) for line in pathlib.Path(__file__).read_text().splitlines() if line.startswith('# name_client='))
action = sys.argv[1]
if action in ('stop', 'restart'):
    for entry in pathlib.Path('/proc').iterdir():
        try:
            if (entry / 'comm').read_text().strip() == core:
                os.kill(int(entry.name), signal.SIGTERM)
        except (OSError, ValueError):
            pass
    time.sleep(.2)
if action in ('start', 'restart'):
    flag = pathlib.Path('/opt/fail-start')
    once = pathlib.Path('/opt/fail-start-once')
    if once.exists():
        once.unlink()
        sys.exit(1)
    if flag.exists() or (core == 'mihomo' and pathlib.Path('/opt/fail-mihomo-start').exists()):
        sys.exit(1)
    log = open('/opt/var/log/xray/error.log', 'ab')
    command = ['xray', 'run', '-confdir', '/opt/etc/xray/configs'] if core == 'xray' else ['mihomo', '-d', '/opt/etc/mihomo']
    child = subprocess.Popen(command, stdout=log, stderr=log, start_new_session=True)
    time.sleep(.3)
    sys.exit(0 if child.poll() is None else 1)
''')
    init.chmod(0o755)
    native = Path('/opt/sbin/xkeen')
    native.write_text('''#!/usr/bin/env python3
import os, pathlib, subprocess, sys, time
assert sys.argv[1:] == ['-restart'], sys.argv
assert os.environ.get('XKEEN_FOREGROUND') == '1'
with open('/opt/native-restarts', 'a') as log:
    log.write('restart\\n')
slow = pathlib.Path('/opt/slow-restart')
if slow.exists():
    slow_delay = slow.read_text().strip()
    slow.unlink()
    pathlib.Path('/opt/restart-started').touch()
    time.sleep(float(slow_delay) if slow_delay else 21)
status = subprocess.run(['/opt/etc/init.d/S99xkeen', 'restart', 'on']).returncode
pathlib.Path('/opt/restart-completed').touch()
sys.exit(status)
''')
    native.chmod(0o755)
    fixtures = [http.server.ThreadingHTTPServer(('127.0.0.1', 0), Proxy) for _ in range(2)]
    for fixture in fixtures:
        threading.Thread(target=fixture.serve_forever, daemon=True).start()
    outbound = lambda fixture: {'protocol': 'http', 'settings': {'servers': [{'address': '127.0.0.1', 'port': fixture.server_port}]}}
    client_port = port()
    original = json.dumps({'log': {'loglevel': 'warning'}, 'inbounds': [{'listen': '127.0.0.1', 'port': client_port, 'protocol': 'http'}], 'outbounds': [{'tag': 'proxy', **outbound(fixtures[0])}, {'tag': 'bypass', **outbound(fixtures[0])}], 'routing': {'rules': [{'type': 'field', 'network': 'tcp,udp', 'outboundTag': 'proxy'}]}})
    config = Path('/opt/etc/xray/configs/05_routing.json')
    config.write_text(original)
    Path('/opt/etc/xray/configs/06_policy.json').write_text('{"policy": {}}')
    subprocess.run([str(init), 'start'], check=True)
    api_port = port()
    url = f'http://127.0.0.1:{api_port}/api/'
    cookies = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
    process = None
    log = open('/opt/var/log/panel-smoke.log', 'wb')

    def traffic_fixture(host='probe.test'):
        # Check real client traffic through the main Xray, not its API state or
        # the separate health-check process.
        with socket.create_connection(('127.0.0.1', client_port), timeout=5) as connection:
            connection.sendall(f'GET http://{host}/ HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n'.encode())
            response = b''
            while b'\r\n\r\n' not in response:
                chunk = connection.recv(8192)
                assert chunk, response
                response += chunk
            headers = response.split(b'\r\n\r\n', 1)[0].split(b'\r\n')
            return int(next(line.split(b':', 1)[1] for line in headers if line.lower().startswith(b'x-fixture:')))

    def request(method, endpoint, body=None):
        req = urllib.request.Request(url + endpoint, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type': 'application/json'})
        try:
            response = client.open(req, timeout=100)
        except urllib.error.HTTPError as error:
            response = error
        text = response.read()
        return response.code, json.loads(text) if text else None

    def ok(method, endpoint, body=None):
        status, data = request(method, endpoint, body)
        assert status == 200 and data and data.get('success', True), (endpoint, status, data)
        return data

    def start_panel():
        child = subprocess.Popen([binary, '--port', str(api_port)], stdout=log, stderr=log)
        for _ in range(100):
            assert child.poll() is None, 'Panel exited during startup'
            try:
                if request('GET', 'auth/login')[0] == 200:
                    return child
            except OSError:
                pass
            time.sleep(.05)
        raise AssertionError('Panel startup timed out')

    def restart_panel():
        nonlocal process
        process.terminate()
        process.wait(timeout=5)
        process = start_panel()

    try:
        process = start_panel()
        assert ok('GET', 'auth/login')['enabled'] is True
        ok('POST', 'auth/login', {'username': 'admin', 'password': 'admin'})
        panel_init = Path('/opt/etc/init.d/S99xkeen-ui')
        assert panel_init.exists() and os.access(panel_init, os.X_OK)
        assert f'ARGS="-p {api_port}"' in panel_init.read_text()
        panel_init.write_text(panel_init.read_text().replace('ENABLED=yes', 'ENABLED=no'))
        panel_init.chmod(0o644)
        restart_panel()
        assert os.access(panel_init, os.X_OK) and 'ENABLED=no' in panel_init.read_text()
        panel_init.unlink()
        restart_panel()
        assert 'ENABLED=yes' in panel_init.read_text()
        process_log = Path('/opt/var/log/xkeen-ui.log').read_text()
        assert 'Starting XKeen UI' in process_log and 'HTTP listener ready' in process_log
        assert '[INFO] received SIGTERM (service stop)' in process_log
        print('PASS: startup registration is created/repaired, custom settings preserved, startup and normal stop logged', flush=True)
        # Real protobuf files (one domain/IP entry per category), including the
        # symlinks installed by XKeen. Listing requires no DNS or target value.
        def field(number, value):
            assert len(value) < 128
            return bytes([number * 8 + 2, len(value)]) + value
        dat = Path('/opt/etc/xray/dat')
        site = field(1, field(1, b'TEST') + field(2, b'\x08\x02' + field(2, b'example.test')))
        ip = field(1, field(1, b'PRIVATE') + field(2, field(1, bytes([10,0,0,0])) + b'\x10\x08'))
        (dat/'geosite_custom.dat').write_bytes(site)
        (dat/'geoip_custom.dat').write_bytes(ip)
        (dat/'geosite.dat').symlink_to('geosite_custom.dat')
        (dat/'geoip.dat').symlink_to('geoip_custom.dat')
        listing = ok('GET', 'geo')
        assert 'geosite.dat' in listing['site_files'] and 'geoip.dat' in listing['ip_files'], listing
        assert ok('GET', 'geo/site?file=geosite.dat&all=true')['categories'] == ['TEST']
        assert ok('GET', 'geo/ip?file=geoip.dat&all=true')['categories'] == ['PRIVATE']
        assert ok('GET', 'geo/site?file=geosite.dat&domain=example.test')['categories'] == ['TEST']
        assert ok('GET', 'geo/ip?file=geoip.dat&ip=10.1.2.3')['categories'] == ['PRIVATE']
        assert request('GET', 'geo/site?file=missing.dat&all=true')[1]['success'] is False
        print('PASS: constructor discovers actual Geo categories through standard symlinks and preserves lookup behavior', flush=True)
        servers = [{'id': str(uuid.uuid4()), 'name': f'Server {index}', 'outbound': outbound(fixture)} for index, fixture in enumerate(fixtures)]
        for server in servers:
            ok('PUT', 'xray/servers/library', server)
        servers[0]['name'] = 'Renamed before pool activation'
        ok('PUT', 'xray/servers/library', servers[0])
        restart_panel()
        snapshot = ok('GET', 'xray/servers')
        assert snapshot['settings'] is None and len(snapshot['servers']) == 2
        assert snapshot['servers'][0]['name'] == servers[0]['name']
        print('PASS: immediate server creation/editing survives panel restart with pool disabled', flush=True)

        ok('PATCH', 'settings', {'clash_api': {'ping_url': 'http://probe.test', 'ping_timeout': 2000}})
        ok('POST', 'xray/servers/activate', {'id': servers[1]['id'], 'target_tag': 'proxy'})
        snapshot = ok('GET', 'xray/servers')
        assert snapshot['settings'] is None and snapshot['active_id'] == servers[1]['id']
        assert traffic_fixture() == fixtures[1].server_port
        switched = json.loads(config.read_text())
        assert switched['outbounds'][0] == {'tag': 'proxy', **servers[1]['outbound']}
        assert switched['routing'] == json.loads(original)['routing']
        assert not Path('/opt/etc/xray/configs/07_pool.json').exists()
        restart_panel()
        assert ok('GET', 'xray/servers')['active_id'] == servers[1]['id']
        ok('POST', 'xray/servers/activate', {'id': servers[0]['id'], 'target_tag': 'proxy'})
        assert traffic_fixture() == fixtures[0].server_port
        original = config.read_text()
        print('PASS: standalone activation preserves routing and survives panel restart without creating a pool', flush=True)

        draft = json.loads(original)
        draft['outbounds'].append({'tag': 'draft-second', **servers[1]['outbound']})
        draft['routing']['rules'].insert(0, {'type': 'field', 'domain': ['domain:preview.test'], 'outboundTag': 'draft-second'})
        preview = {'file': str(config), 'content': json.dumps(draft)}
        evaluated = ok('POST', 'route-test', {'targets': ['preview.test', 'other.test'], 'preview': preview})
        assert [row['outbound'] for row in evaluated['results']] == ['draft-second', 'proxy'], evaluated
        assert evaluated['results'][0]['rule']['index'] == 0, evaluated
        assert config.read_text() == original
        assert traffic_fixture('preview.test') == fixtures[0].server_port
        invalid = {'file': str(config), 'content': '{broken'}
        assert request('POST', 'route-test', {'targets': ['preview.test'], 'preview': invalid})[1]['success'] is False
        assert config.read_text() == original
        print('PASS: draft routing uses real core validation, explains first match, and never modifies files or live traffic', flush=True)


        settings = {'target_tag': 'proxy', 'servers': servers, 'selected_id': servers[0]['id'], 'auto': False,
                    'interval_secs': 60, 'failure_threshold': 3, 'probe_url': 'http://probe.test', 'timeout_ms': 2000}
        journal = Path('/opt/etc/xkeen/xray-servers-transaction.json')
        journal.write_text(json.dumps([{'path': str(config), 'before': original, 'after': original + '\n'}]))
        config.write_text(original + '\n')
        ok('PUT', 'xray/servers', settings)
        assert not journal.exists()
        assert config.read_text() == original, 'Pool rewrote the original config'
        files = [item['file'] for item in ok('GET', 'configs')['configs']]
        pool_path = Path('/opt/etc/xray/configs/07_pool.json')
        assert str(pool_path) not in files
        assert not pool_path.exists()
        assert ok('GET', 'xray/servers')['settings']['selected_id'] == servers[0]['id']
        assert traffic_fixture() == fixtures[0].server_port
        store_path = Path('/opt/etc/xkeen/xray-servers.json')
        assert json.loads(store_path.read_text())['config_switching'] is True

        # Reproduce both old generated-file formats, including the oldest release
        # which removed routing from the user's source file.
        for old_name in ['07_pool.json', 'zz-xkeen-ui-servers-tail.json']:
            legacy_settings = {**settings, 'selected_id': servers[1]['id']}
            legacy_routing = json.loads(original)['routing']
            for rule in legacy_routing['rules']:
                if rule.get('outboundTag') == 'proxy':
                    rule.pop('outboundTag'); rule['balancerTag'] = 'xkeen-ui-servers'
            alias = lambda server: 'xkeen-ui-server-' + server['id'] + '.'
            legacy_routing['balancers'] = [{'tag':'xkeen-ui-servers', 'selector':[alias(servers[1])], 'strategy':{'type':'random'}}]
            legacy_value = {'routing':legacy_routing, 'api':{'tag':'xkeen-ui-api','listen':'127.0.0.1:10085','services':['RoutingService']},
                            'outbounds':[{'tag':alias(server), **server['outbound']} for server in servers]}
            managed = json.dumps(legacy_value)
            stripped = json.loads(original); stripped.pop('routing'); stripped = json.dumps(stripped)
            config.write_text(stripped)
            legacy_path = pool_path.with_name(old_name); legacy_path.write_text(managed)
            store_path.write_text(json.dumps({'settings':legacy_settings,'managed':managed,'api_address':'127.0.0.1:10085',
                'originals':[{'path':str(config),'before':original,'after':stripped}]}))
            restart_panel()
            for _ in range(100):
                if not legacy_path.exists() and ok('GET','xray/servers')['settings']:
                    break
                time.sleep(.1)
            assert not pool_path.exists() and not legacy_path.exists()
            assert json.loads(config.read_text())['routing'] == json.loads(original)['routing']
            assert traffic_fixture() == fixtures[1].server_port
            assert json.loads(store_path.read_text())['config_switching'] is True
            ok('POST','xray/servers/select',{'id':servers[0]['id']})
        print('PASS: migration restores source routing, applies selected outbound and removes both generated pool formats',flush=True)

        # No pool file should be recreated on startup.
        restart_panel()
        assert not pool_path.exists()
        assert traffic_fixture() == fixtures[0].server_port
        print('PASS: group monitoring survives restart without generating 07_pool.json',flush=True)

        restarts_before = Path('/opt/native-restarts').read_text().count('restart')
        ok('POST', 'xray/servers/select', {'id': servers[1]['id']})
        assert ok('GET', 'xray/servers')['settings']['selected_id'] == servers[1]['id']
        assert Path('/opt/native-restarts').read_text().count('restart') == restarts_before + 1
        assert traffic_fixture() == fixtures[1].server_port
        ok('PUT', 'xray/servers', {**settings, 'auto': True, 'selected_id': servers[1]['id']})
        routes = json.loads(config.read_text())
        routes['routing']['rules'].insert(0, {'type': 'field', 'domain': ['domain:bypass.test'], 'outboundTag': 'bypass'})
        future = json.dumps(routes)
        live_files = [config, store_path]
        snapshot_files = [path.read_bytes() for path in live_files]
        preview = ok('POST', 'route-test', {'targets': ['bypass.test', 'other.test'], 'preview': {'file': str(config), 'content': future}})
        assert preview['results'][0]['outbound'] == 'bypass', preview
        assert preview['results'][1]['outbound'] == 'proxy' and preview['results'][1]['balancer'] is None, preview
        assert [path.read_bytes() for path in live_files] == snapshot_files
        assert traffic_fixture('bypass.test') == fixtures[1].server_port
        assert ok('GET', 'xray/servers')['settings']['selected_id'] == servers[1]['id']
        restarts_before = Path('/opt/native-restarts').read_text().count('restart')
        applied = ok('PUT', 'configs?validate=xray&apply=true', {'file': str(config), 'content': future})
        assert applied['applied'] is True
        assert Path('/opt/native-restarts').read_text().count('restart') == restarts_before + 1
        assert config.read_text() == future
        assert traffic_fixture('bypass.test') == fixtures[0].server_port
        assert traffic_fixture('other.test') == fixtures[1].server_port
        assert ok('GET', 'xray/servers')['settings']['selected_id'] == servers[1]['id']
        assert not journal.exists()
        snapshot_files = [path.read_bytes() for path in live_files]
        invalid = json.loads(future)
        invalid['routing']['rules'][0]['domain'] = ['regexp:[']
        assert request('PUT', 'configs?validate=xray&apply=true', {'file': str(config), 'content': json.dumps(invalid)})[1]['success'] is False
        assert [path.read_bytes() for path in live_files] == snapshot_files
        changed = json.loads(future)
        changed['routing']['rules'][0]['domain'] = ['domain:changed.test']
        Path('/opt/fail-start-once').touch()
        assert request('PUT', 'configs?validate=xray&apply=true', {'file': str(config), 'content': json.dumps(changed)})[1]['success'] is False
        assert [path.read_bytes() for path in live_files] == snapshot_files
        assert not journal.exists()
        assert traffic_fixture('bypass.test') == fixtures[0].server_port
        assert traffic_fixture('other.test') == fixtures[1].server_port
        # Retry without disabling/recreating the pool; the one-shot failure was consumed.
        ok('PUT', 'configs', {'file': str(config), 'content': json.dumps(changed)})
        assert traffic_fixture('changed.test') == fixtures[0].server_port
        assert traffic_fixture('bypass.test') == fixtures[1].server_port
        assert ok('GET', 'xray/servers')['settings']['selected_id'] == servers[1]['id']
        assert ok('GET', 'xray/servers')['settings']['auto'] is True
        changed['routing']['rules'][0]['domain'] = ['domain:detached.test']
        detached = json.dumps(changed)
        Path('/opt/restart-started').unlink(missing_ok=True)
        Path('/opt/restart-completed').unlink(missing_ok=True)
        Path('/opt/slow-restart').write_text('1')
        body = json.dumps({'file': str(config), 'content': detached}).encode()
        with socket.create_connection(('127.0.0.1', api_port)) as connection:
            cookie_header = '; '.join(f'{cookie.name}={cookie.value}' for cookie in cookies)
            connection.sendall(f'PUT /api/configs?validate=xray&apply=true HTTP/1.1\r\nHost: localhost\r\nCookie: {cookie_header}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n'.encode() + body)
            for _ in range(100):
                if Path('/opt/restart-started').exists(): break
                time.sleep(.05)
            assert Path('/opt/restart-started').exists()
        for _ in range(200):
            if Path('/opt/restart-completed').exists() and not journal.exists(): break
            time.sleep(.05)
        assert not journal.exists() and Path('/opt/restart-completed').exists()
        assert config.read_text() == detached
        assert traffic_fixture('detached.test') == fixtures[0].server_port
        assert traffic_fixture('other.test') == fixtures[1].server_port
        assert ok('GET', 'xray/servers')['settings']['auto'] is True
        original = config.read_text()
        print('PASS: live pool route preview/apply/save, actual split traffic, selected server retention, validation and startup rollback, retry', flush=True)
        ok('DELETE', 'xray/servers')
        assert config.read_text() == original
        assert len(ok('GET', 'xray/servers')['servers']) == 2
        print('PASS: transaction recovery, pool activation, manual selection restarts Xray and moves actual traffic, disabling', flush=True)

        # Observe actual main-core traffic, not just selected_id/API acknowledgements.
        fixtures[0].delay = .12
        fixtures[1].delay = .01
        auto_settings = {**settings, 'auto':True, 'prefer_fastest':True, 'latency_samples':3,
                         'interval_secs':3600, 'failure_threshold':1, 'timeout_ms':1000}
        ok('PUT','xray/servers', auto_settings)
        for _ in range(3): ok('POST','xray/servers/check')
        measured = ok('GET','xray/servers')
        assert measured['settings']['selected_id'] == servers[1]['id'], measured
        assert traffic_fixture() == fixtures[1].server_port
        assert all(p['average_ms'] is not None and p['checks'] == 3 for p in measured['probes']), measured
        assert not pool_path.exists()
        fixtures[0].delay = .005
        fixtures[1].delay = .12
        auto_settings.update(selected_id=servers[1]['id'],prefer_fastest=False)
        ok('PUT','xray/servers', auto_settings)
        for _ in range(3): ok('POST','xray/servers/check')
        assert ok('GET','xray/servers')['settings']['selected_id'] == servers[1]['id']
        fixtures[1].shutdown(); fixtures[1].server_close()
        ok('POST','xray/servers/check')
        assert ok('GET','xray/servers')['settings']['selected_id'] == servers[0]['id']
        assert traffic_fixture() == fixtures[0].server_port
        fixture_port = fixtures[1].server_port
        fixtures[1] = http.server.ThreadingHTTPServer(('127.0.0.1',fixture_port),Proxy)
        threading.Thread(target=fixtures[1].serve_forever,daemon=True).start()
        fixtures[0].delay = 0
        ok('DELETE','xray/servers')
        original = config.read_text()
        print('PASS: configurable rolling averages move actual traffic to fastest; optional flag keeps healthy server; failure switches natively',flush=True)

        ok('PUT', 'xray/servers', settings)
        ok('POST', 'xray/servers/activate', {'id': servers[1]['id']})
        assert ok('GET', 'xray/servers')['settings'] is None
        assert ok('GET', 'xray/servers')['active_id'] == servers[1]['id']
        assert json.loads(config.read_text())['routing'] == json.loads(original)['routing']
        assert not journal.exists()
        ok('POST', 'xray/servers/activate', {'id': servers[0]['id']})
        original = config.read_text()
        print('PASS: leaving the pool for a standalone server restores routing atomically', flush=True)

        Path('/opt/restart-completed').unlink(missing_ok=True)
        Path('/opt/restart-started').unlink(missing_ok=True)
        Path('/opt/slow-restart').touch()
        body = json.dumps({'action': 'hardRestart'}).encode()
        with socket.create_connection(('127.0.0.1', api_port)) as connection:
            cookie_header = '; '.join(f'{cookie.name}={cookie.value}' for cookie in cookies)
            connection.sendall(f'POST /api/control HTTP/1.1\r\nHost: localhost\r\nCookie: {cookie_header}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n'.encode() + body)
            for _ in range(100):
                if Path('/opt/restart-started').exists():
                    break
                time.sleep(.05)
            assert Path('/opt/restart-started').exists(), 'Native restart did not begin'
        # Disconnect during an operation longer than the old pool timeout.
        for _ in range(500):
            if Path('/opt/restart-completed').exists():
                break
            time.sleep(.05)
        assert Path('/opt/restart-completed').exists(), 'HTTP disconnect interrupted the native restart'
        ok('PUT', 'xray/servers', settings)
        ok('DELETE', 'xray/servers')
        assert Path('/opt/native-restarts').read_text().count('restart') >= 8
        print('PASS: native foreground restart finishes after HTTP disconnect and a 21-second delay', flush=True)

        Path('/opt/fail-start').touch()
        failure = ok('GET', 'xray/servers')
        assert failure['settings'] is None
        status, failure = request('PUT', 'xray/servers', {**settings, 'selected_id':servers[1]['id']})
        assert status == 200 and not failure['success'], failure
        assert not journal.exists(), 'Completed rollback left a blocking journal'
        assert config.read_text() == original
        Path('/opt/fail-start').unlink()
        subprocess.run([str(init), 'start'], check=True)
        ok('PUT', 'xray/servers', settings)
        ok('DELETE', 'xray/servers')
        print('PASS: failed new/old core startup rolls back and retry works without restarting panel', flush=True)

        alternate = json.loads(original)
        alternate['outbounds'] = [{'tag': 'fallback', **outbound(fixtures[0])}, {'tag': 'proxy', **outbound(fixtures[1])}]
        alternate['routing']['rules'] = [{'type': 'field', 'domain': ['full:pool.test'], 'outboundTag': 'proxy'}]
        alternate_text = json.dumps(alternate)
        config.write_text(alternate_text)
        ok('POST','control',{'action':'hardRestart'})
        ok('PUT', 'xray/servers', {**settings, 'selected_id': servers[1]['id']})
        assert config.read_text() == alternate_text
        assert traffic_fixture('pool.test') == fixtures[1].server_port
        assert traffic_fixture('unmatched.test') == fixtures[0].server_port
        ok('DELETE', 'xray/servers')
        config.write_text(original)
        ok('POST', 'control', {'action': 'hardRestart'})
        print('PASS: source outbound switching preserves the original default exit for unmatched traffic', flush=True)

        ok('POST', 'auth/reset')
        assert request('GET', 'settings')[0] == 401
        assert ok('GET', 'auth/login')['has_password'] is False
        ok('POST', 'auth/setup', {'password': 'local-test-password'})
        ok('GET', 'settings')
        auth_path = Path('/opt/etc/xkeen/xkeen-ui.json')
        saved = auth_path.read_text()
        auth_path.unlink()
        auth_path.mkdir()
        assert request('POST', 'auth/reset')[0] == 500
        assert ok('GET', 'auth/login')['has_password'] is True
        auth_path.rmdir()
        auth_path.write_text(saved)
        ok('POST', 'auth/reset')
        restart_panel()
        assert ok('GET', 'auth/login')['has_password'] is True
        ok('POST', 'auth/login', {'username': 'admin', 'password': 'admin'})
        ok('PATCH', 'users/admin', {'password': 'replacement-password'})
        ok('POST', 'auth/login', {'username': 'admin', 'password': 'replacement-password'})
        ok('POST', 'auth/logout')
        assert request('GET', 'settings')[0] == 401
        assert request('POST', 'auth/login', {'password': 'wrong'})[0] == 401
        ok('POST', 'auth/login', {'password': 'replacement-password'})
        ok('PATCH', 'settings', {'auth': {'enabled': False}})
        ok('POST', 'users', {'username': 'alice', 'password': 'alice-password'})
        assert not ok('GET', 'users')['users'][1].get('password_hash')
        assert request('DELETE', 'users/admin')[1]['success'] is False
        assert request('PATCH', 'users/admin', {'username': 'other'})[1]['success'] is False
        assert request('POST', 'users', {'username': 'alice', 'password': 'duplicate'})[1]['success'] is False
        ok('POST', 'auth/login', {'username': 'alice', 'password': 'alice-password'})
        assert ok('GET', 'users')['current_user'] == 'alice'
        ok('PATCH', 'users/alice', {'username': 'bob', 'password': 'bob-password'})
        # Auth was disabled above; enable it to verify session revocation.
        ok('PATCH', 'settings', {'auth': {'enabled': True}})
        assert request('GET', 'settings')[0] == 401
        assert request('POST', 'auth/login', {'username': 'alice', 'password': 'alice-password'})[0] == 401
        ok('POST', 'auth/login', {'username': 'bob', 'password': 'bob-password'})
        # Only admin manages users and the login toggle; others may change their own password.
        assert request('DELETE', 'users/bob')[1]['success'] is False
        assert request('POST', 'users', {'username': 'eve', 'password': 'eve-password'})[1]['success'] is False
        assert request('PATCH', 'users/admin', {'password': 'taken-over'})[1]['success'] is False
        assert request('PATCH', 'users/bob', {'username': 'robert'})[1]['success'] is False
        assert request('PATCH', 'settings', {'auth': {'enabled': False}})[1]['success'] is False
        assert request('POST', 'auth/reset')[0] == 403
        assert request('PUT', 'traffic-guard', {'enabled': True})[1]['success'] is False
        for path in ['rci/', 'proxies/%2e%2e/rci/', 'proxies/%252e%252e/rci/']:
            req = urllib.request.Request(f'http://127.0.0.1:{api_port}/clash/{path}',method='POST',data=b'{}',
                headers={'Content-Type':'application/json','X-Clash-Port':'79','X-Ndma-Tkn':'inert-test-token'})
            try:
                client.open(req,timeout=10)
                raise AssertionError('Relay allowed an administrative router path')
            except urllib.error.HTTPError as error:
                assert error.code == 403, error

        # The config editor cannot reach the panel's own state or widen its file access.
        panel_config = '/opt/etc/xkeen/xkeen-ui.json'
        assert request('PUT', 'configs', {'file': panel_config, 'content': '{}'})[1]['success'] is False
        assert request('DELETE', 'configs', {'file': panel_config})[1]['success'] is False
        assert request('PATCH', 'settings', {'append_config_paths': {'xray': ['/']}})[1]['success'] is False
        assert Path(panel_config).exists()
        ok('PATCH', 'users/bob', {'password': 'bob-new-password'})
        ok('POST', 'auth/login', {'username': 'admin', 'password': 'replacement-password'})
        assert [user['username'] for user in ok('GET', 'users')['users']] == ['admin', 'bob']
        ok('DELETE', 'users/bob')
        assert request('POST', 'auth/login', {'username': 'bob', 'password': 'bob-new-password'})[0] == 401
        ok('POST', 'auth/login', {'username': 'admin', 'password': 'replacement-password'})
        ok('PATCH', 'settings', {'auth': {'enabled': False}})
        print('PASS: login, setup, reset, failed write, user creation, renaming, password changes, session revocation, admin-only management and protected admin', flush=True)

        if mihomo:
            mihomo_path = Path('/opt/etc/mihomo/config.yaml')
            mihomo_path.write_text('proxies: [broken')
            assert request('POST', 'control', {'action': 'switchCore', 'core': 'mihomo'})[1]['success'] is False
            assert ok('GET', 'control')['currentCore'] == 'xray'
            assert traffic_fixture() == fixtures[0].server_port
            assert request('POST', 'control', {'action': 'switchCore', 'core': ''})[1]['success'] is False
            controller_port = port()
            mihomo_config = {
                'mixed-port': client_port, 'allow-lan': False, 'bind-address': '127.0.0.1',
                'external-controller': f'127.0.0.1:{controller_port}', 'secret': 'local-test-secret',
                'mode': 'rule', 'log-level': 'info', 'find-process-mode': 'off',
                'dns': {'enable': False},
                'proxies': [{'name': name, 'type': 'http', 'server': '127.0.0.1', 'port': fixture.server_port}
                            for name, fixture in zip(('A', 'B'), fixtures)] + [{
                    'name': 'VLESS-Reality', 'type': 'vless', 'server': '192.0.2.1', 'port': 443,
                    'uuid': str(uuid.uuid4()), 'network': 'tcp', 'tls': True, 'flow': 'xtls-rprx-vision',
                    'servername': 'example.com', 'client-fingerprint': 'chrome',
                    'reality-opts': {'public-key': 'CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'short-id': '0123456789abcdef'},
                }],
                'proxy-groups': [
                    {'name': 'SELECT', 'type': 'select', 'proxies': ['A', 'B']},
                    *[{'name': name, 'type': kind, 'proxies': ['A', 'B'], 'url': 'http://probe.test', 'interval': 60, 'lazy': True}
                      for name, kind in [('AUTO', 'url-test'), ('FALLBACK', 'fallback'), ('BALANCE', 'load-balance')]]],
                'rules': ['MATCH,SELECT'],
            }
            mihomo_path.write_text(json.dumps(mihomo_config))
            Path('/opt/fail-mihomo-start').touch()
            assert request('POST', 'control', {'action': 'switchCore', 'core': 'mihomo'})[1]['success'] is False
            Path('/opt/fail-mihomo-start').unlink()
            assert ok('GET', 'control')['currentCore'] == 'xray'
            assert traffic_fixture() == fixtures[0].server_port
            ok('POST', 'control', {'action': 'switchCore', 'core': 'mihomo'})
            assert ok('GET', 'control')['currentCore'] == 'mihomo'
            assert any(item['file'].endswith('/mihomo/config.yaml') for item in ok('GET', 'configs')['configs'])

            def clash(method, endpoint, body=None):
                req = urllib.request.Request(f'http://127.0.0.1:{api_port}/clash/{endpoint}', method=method,
                    data=json.dumps(body).encode() if body is not None else None,
                    headers={'Content-Type': 'application/json', 'X-Clash-Port': '79'})
                with client.open(req, timeout=20) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else None

            proxies = clash('GET', 'proxies')['proxies']
            assert all(name in proxies for name in ['SELECT', 'AUTO', 'FALLBACK', 'BALANCE', 'VLESS-Reality'])
            assert proxies['SELECT']['now'] == 'A'
            assert traffic_fixture() == fixtures[0].server_port
            clash('PUT', 'proxies/SELECT', {'name': 'B'})
            assert clash('GET', 'proxies')['proxies']['SELECT']['now'] == 'B'
            assert traffic_fixture() == fixtures[1].server_port
            with socket.create_connection(('127.0.0.1', client_port), timeout=5) as held:
                held.sendall(b'CONNECT held.test:443 HTTP/1.1\r\nHost: held.test:443\r\n\r\n')
                assert b'200' in held.recv(4096)
                # Mihomo registers the tunnel shortly after replying to CONNECT.
                for _ in range(20):
                    active_connections = clash('GET', 'connections')['connections']
                    if isinstance(active_connections, list) and any(row['metadata']['host'] == 'held.test' for row in active_connections):
                        break
                    time.sleep(0.1)
                assert any(row['metadata']['host'] == 'held.test' for row in active_connections), active_connections
                clash('DELETE', 'connections')
            for _ in range(30):
                if not clash('GET', 'connections')['connections']:
                    break
                time.sleep(.05)
            assert not clash('GET', 'connections')['connections']
            assert clash('GET', 'configs')['mode'] == 'rule'
            ok('POST', 'control', {'action': 'hardRestart'})
            ok('POST', 'control', {'action': 'switchCore', 'core': 'xray'})
            assert traffic_fixture() == fixtures[0].server_port
            rules_dir = Path('/opt/etc/mihomo/rules')
            rules_dir.mkdir(exist_ok=True)
            (rules_dir / 'local.txt').write_text('example.com\n')
            mihomo_config['rule-providers'] = {
                'local': {'type': 'file', 'behavior': 'domain', 'format': 'text', 'path': './rules/local.txt'},
                'outside': {'type': 'file', 'behavior': 'domain', 'format': 'text', 'path': '/opt/etc/xkeen/xkeen-ui.json'},
            }
            mihomo_path.write_text(json.dumps(mihomo_config))
            assert ok('GET', 'rule-providers?name=local&vehicleType=file')['content'] == 'example.com\n'
            outside = request('GET', 'rule-providers?name=outside&vehicleType=file')[1]
            assert outside['success'] is False and 'session' not in json.dumps(outside), outside
            print('PASS: real Mihomo VLESS/REALITY parsing, selector/fallback/url-test/load-balance groups, API relay, traffic switching, connections, restart and core-switch rollback', flush=True)

        ok('PATCH','settings',{'auth':{'enabled':True}})
        ok('POST','auth/login',{'username':'admin','password':'replacement-password'})
        ok('PATCH','settings',{'log':{'timezone':4}})
        backup = ok('PUT', 'backup')['backup']['name']
        assert any(item['name'] == backup for item in ok('GET', 'backup')['backups'])
        def download(name):
            endpoint = 'backup/download?name=' + urllib.parse.quote(name)
            with client.open(url + endpoint, timeout=10) as response:
                data = response.read()
                assert response.headers['Content-Type'] == 'application/x-tar'
                assert response.headers['Cache-Control'] == 'no-store'
                assert "filename*=UTF-8''" + urllib.parse.quote(name, safe='') in response.headers['Content-Disposition']
                assert int(response.headers['Content-Length']) == len(data)
                return data

        def upload(data, chunked=False):
            body = (data[i:i+32768] for i in range(0,len(data),32768)) if chunked else data
            req = urllib.request.Request(url + 'backup/upload',method='POST',data=body,
                                         headers={'Content-Type':'application/x-tar'})
            with client.open(req,timeout=30) as response: return json.load(response)

        def restore(name, contents=None, failed=False, disconnect=False):
            operation=str(uuid.uuid4())
            body={'name':name,'operation_id':operation}
            if contents: body['contents']=contents
            if disconnect:
                Path('/opt/slow-restart').write_text('2')
                data=json.dumps(body).encode()
                cookie='; '.join(f'{item.name}={item.value}' for item in cookies)
                with socket.create_connection(('127.0.0.1',api_port),timeout=5) as connection:
                    connection.sendall((f'POST /api/backup HTTP/1.1\r\nHost: 127.0.0.1:{api_port}\r\n'
                        f'Cookie: {cookie}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n\r\n').encode()+data)
                    end=time.monotonic()+5
                    while time.monotonic()<end:
                        current=ok('GET','backup/restore-status')['restore']
                        if current and current['operation_id']==operation:
                            assert current['phase']=='restoring',current
                            break
                        time.sleep(.02)
                    else: raise AssertionError('Restore was not accepted before disconnect')
                result={'success':True}
            else:
                status,result=request('POST','backup',body)
                assert status==200,result
            if failed:
                assert result['success'] is False,result
                current=ok('GET','backup/restore-status')['restore']
                assert current['operation_id']==operation and current['phase']=='failed',current
                return result
            assert result['success'],result
            end=time.monotonic()+30
            while time.monotonic()<end:
                try:
                    current=ok('GET','backup/restore-status')['restore']
                    if current['operation_id']==operation and current['phase']=='done': return current
                    assert current['phase']!='failed',current
                except (OSError,urllib.error.URLError): pass
                time.sleep(.1)
            raise AssertionError('Restore/restart did not finish')

        original = download(backup)
        assert original == Path('/opt/backups',backup).read_bytes()
        before_import = config.read_bytes()
        changed_config = '{"outbounds":[{"tag":"direct","protocol":"freedom"}]}'
        config.write_text(changed_config)
        imported = upload(original,chunked=True)
        assert imported['success'],imported
        imported = imported['backup']['name']
        assert imported != backup
        assert config.read_text() == changed_config, 'Uploading must not apply/restore files'
        assert download(imported) == original
        assert any(item['name'] == imported for item in ok('GET','backup')['backups'])
        restart_count=Path('/opt/native-restarts').read_text().count('restart')
        restore(imported,['xray'])
        assert Path('/opt/native-restarts').read_text().count('restart') == restart_count+1
        assert config.read_bytes() == before_import
        assert traffic_fixture() == fixtures[0].server_port
        ok('PATCH','users/admin',{'password':'transfer-target-password'})
        ok('POST','auth/login',{'username':'admin','password':'transfer-target-password'})
        target_auth=json.loads(Path('/opt/etc/xkeen/xkeen-ui.json').read_text())['auth']
        ok('PATCH','settings',{'log':{'timezone':2}})
        boot=ok('GET','backup/restore-status')['boot_id']
        restore(imported,disconnect=True)
        assert ok('GET','backup/restore-status')['boot_id'] != boot, 'Panel did not restart'
        assert ok('GET','settings')['log']['timezone'] == 4, 'Restored settings were not loaded into memory'
        assert traffic_fixture() == fixtures[0].server_port
        assert json.loads(Path('/opt/etc/xkeen/xkeen-ui.json').read_text())['auth'] == target_auth
        unicode_name = 'Копия_с_другого_роутера_xkeen-ui.tar'
        ok('PATCH','backup',{'name':imported,'new_name':unicode_name})
        assert download(unicode_name) == original
        # A failed native restart rolls files back and brings the previous connection back.
        fallback=json.loads(before_import);fallback['log']={'loglevel':'error'}
        config.write_text(json.dumps(fallback))
        rollback_bytes=config.read_bytes()
        Path('/opt/fail-start-once').touch()
        restore(unicode_name,['xray'],failed=True)
        assert config.read_bytes()==rollback_bytes
        assert traffic_fixture()==fixtures[0].server_port
        restore(unicode_name,['xray'])
        assert config.read_bytes()==before_import
        ok('DELETE','backup',{'name':unicode_name})
        print('PASS: restored Xray restarts natively and carries real traffic; panel re-execs and loads restored settings; failed startup rolls back',flush=True)

        # Upload validation must reject dangerous or damaged archives before publishing them.
        def archive(entries):
            data=io.BytesIO()
            with tarfile.open(fileobj=data,mode='w') as tar:
                for name,kind in entries:
                    entry=tarfile.TarInfo(name)
                    if kind=='link': entry.type=tarfile.SYMTYPE;entry.linkname='/etc/passwd';tar.addfile(entry)
                    else: entry.size=2;tar.addfile(entry,io.BytesIO(b'{}'))
            return data.getvalue()
        path='opt/etc/xray/configs/04_outbounds.json'
        invalid = [b'not a tar archive',b'',archive([('../escape.json','file')]),
                   archive([('etc/passwd','file')]),archive([('opt/etc/xray/configs-escape.json','file')]),
                   archive([(path,'link')]),
                   archive([(path,'file'),(path,'file')]),archive([(path,'file')])[:513]]
        before=ok('GET','backup')['backups']
        for data in invalid: assert upload(data)['success'] is False
        assert ok('GET','backup')['backups'] == before
        assert config.read_bytes() == before_import
        # Raw streaming accepts archives above Axum's default 2 MiB JSON body limit.
        large=io.BytesIO()
        with tarfile.open(fileobj=large,mode='w') as tar:
            content=b'# fixture\n'*(230000)
            entry=tarfile.TarInfo('opt/etc/xkeen/ip_exclude.lst');entry.size=len(content)
            tar.addfile(entry,io.BytesIO(content))
        uploaded=upload(large.getvalue(),chunked=True)
        assert uploaded['success'],uploaded
        assert download(uploaded['backup']['name']) == large.getvalue()
        ok('DELETE','backup',{'name':uploaded['backup']['name']})
        # A backup-looking name cannot turn export into a general file reader.
        symlink=Path('/opt/backups/link_xkeen-ui.tar');symlink.symlink_to('/etc/passwd')
        for name in ['../xkeen-ui.tar',symlink.name]:
            try:
                client.open(url+'backup/download?name='+urllib.parse.quote(name,safe=''),timeout=10)
                raise AssertionError('Download followed an unsafe path')
            except urllib.error.HTTPError as error: assert error.code == 400
        symlink.unlink()
        for endpoint,method in [('backup/download?name='+backup,'GET'),('backup/upload','POST')]:
            try:
                urllib.request.urlopen(urllib.request.Request(url+endpoint,method=method,
                    data=original if method=='POST' else None),timeout=10)
                raise AssertionError('Archive transfer allowed without login')
            except urllib.error.HTTPError as error: assert error.code == 401
        print('PASS: binary backup export, chunked import, explicit restore, Unicode filename, validation and authentication',flush=True)
        renamed = 'smoke_xkeen-ui.tar'
        ok('PATCH', 'backup', {'name': backup, 'new_name': renamed})
        restore(renamed,['xray'])
        ok('DELETE', 'backup', {'name': renamed})
        print('PASS: backup creation, listing, renaming, selective restore and deletion', flush=True)
        journal=Path('/opt/var/log/xkeen-ui-journal.log')
        def journal_contains(text):
            end=time.monotonic()+5
            while time.monotonic()<end:
                if journal.exists() and text in journal.read_text(): return
                time.sleep(.05)
            raise AssertionError('Missing persistent journal record: '+text)
        marker='before-truncation-'+str(uuid.uuid4())
        raw_log=Path('/opt/var/log/xray/error.log')
        with raw_log.open('a') as file: file.write(marker+'\n')
        journal_contains(marker)
        raw_log.write_text('after-truncation\n')
        journal_contains('after-truncation')
        assert marker in journal.read_text(), 'Core truncation erased previous history'
        ok('POST','control',{'action':'stop'})
        ok('POST','control',{'action':'start'})
        journal_contains('XKeen: остановка — завершено')
        journal_contains('XKeen: запуск — завершено')
        assert marker in journal.read_text()
        assert 'Панель: остановка и перезапуск' in journal.read_text()
        with raw_log.open('a') as file:
            file.write(''.join(f'journal-cap-{n}\n' for n in range(1200)))
        journal_contains('journal-cap-1199')
        assert len(journal.read_text().splitlines())==1000
        assert 'journal-cap-0\n' not in journal.read_text()
        print('PASS: persistent journal keeps lifecycle events across panel/core restart and raw-file truncation; last 1000 lines retained',flush=True)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        subprocess.run([str(init), 'stop'], check=False)
        for fixture in fixtures:
            fixture.shutdown()
            fixture.server_close()
        log.close()


if __name__ == '__main__':
    main()
