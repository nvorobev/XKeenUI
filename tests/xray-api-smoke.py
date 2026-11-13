#!/usr/bin/env python3
"""Real Xray API/routing smoke test. Usage: python3 tests/xray-api-smoke.py /path/to/xray"""
import http.server
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def proxy_server(marker):
    class Proxy(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_CONNECT(self):
            self.send_response(200)
            self.end_headers()
            while self.rfile.readline().strip():
                pass
            body = marker.encode()
            self.wfile.write(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode()
                             + b'\r\nConnection: close\r\n\r\n' + body)
            self.wfile.flush()

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    binary = str(Path(sys.argv[1]).resolve())
    fixtures = [proxy_server(marker) for marker in ('server-a', 'server-b', 'direct')]
    api_port, proxy_port = free_port(), free_port()
    address = f'127.0.0.1:{api_port}'
    tags = ['xkeen-ui-server-a.', 'xkeen-ui-server-b.', 'direct']
    config = {
        'log': {'loglevel': 'none'},
        'api': {'tag': 'api', 'listen': address, 'services': ['RoutingService']},
        'inbounds': [{'listen': '127.0.0.1', 'port': proxy_port, 'protocol': 'http'}],
        'outbounds': [
            {'tag': tag, 'protocol': 'http', 'settings': {'servers': [{'address': '127.0.0.1', 'port': fixture.server_port}]}}
            for tag, fixture in zip(tags, fixtures)
        ],
        'routing': {
            'rules': [
                {'type': 'field', 'domain': ['full:direct.test'], 'outboundTag': 'direct'},
                {'type': 'field', 'network': 'tcp,udp', 'balancerTag': 'xkeen-ui-servers'},
            ],
            'balancers': [{'tag': 'xkeen-ui-servers', 'selector': [tags[0]], 'strategy': {'type': 'random'}}],
        },
    }

    def api(*args):
        return subprocess.check_output([binary, 'api', args[0], '--server', address, '--timeout', '1', *args[1:]], stderr=subprocess.PIPE, timeout=3)

    def get(host):
        with socket.create_connection(('127.0.0.1', proxy_port), timeout=5) as sock:
            sock.sendall(f'GET http://{host}/ HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n'.encode())
            response = b''
            while chunk := sock.recv(8192):
                response += chunk
            return response.split(b'\r\n\r\n', 1)[1].decode()

    with tempfile.TemporaryDirectory(prefix='xkeen-smoke-') as directory:
        path = Path(directory, 'config.json')
        path.write_text(json.dumps(config))
        child = None

        def start():
            process = subprocess.Popen([binary, 'run', '-c', str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(20):
                    if process.poll() is not None:
                        raise AssertionError('Xray exited during startup')
                    try:
                        api('bi', '--json', 'xkeen-ui-servers')
                        return process
                    except (subprocess.SubprocessError, OSError):
                        time.sleep(.1)
                raise AssertionError('Xray API did not become ready')
            except BaseException:
                process.kill()
                process.wait()
                raise

        try:
            child = start()
            assert get('pool.test') == 'server-a'
            pid = child.pid
            api('bo', '-b', 'xkeen-ui-servers', tags[1])
            state = json.loads(api('bi', '--json', 'xkeen-ui-servers'))
            assert state['balancer']['override']['target'] == tags[1], state
            assert get('pool.test') == 'server-b'
            assert get('direct.test') == 'direct'
            assert child.pid == pid and child.poll() is None
            print('PASS: API confirmation, proxy switching without restart, unrelated routing preserved')

            config['routing']['balancers'][0]['selector'] = [tags[1]]
            path.write_text(json.dumps(config))
            child.terminate()
            child.wait(timeout=5)
            child = start()
            assert get('pool.test') == 'server-b'
            print('PASS: selected server survives core restart without restoring an API override')

            config['outbounds'][0]['protocol'] = 'invalid-protocol-for-test'
            path.write_text(json.dumps(config))
            result = subprocess.run([binary, 'run', '-test', '-c', str(path)], capture_output=True, timeout=6)
            assert result.returncode != 0
            assert get('pool.test') == 'server-b'
            print('PASS: invalid candidate config is rejected while the live core continues serving')
        finally:
            if child and child.poll() is None:
                child.terminate()
                child.wait(timeout=5)
            for fixture in fixtures:
                fixture.shutdown()
                fixture.server_close()


if __name__ == '__main__':
    main()
