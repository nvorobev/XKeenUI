#!/usr/bin/env python3
"""Exercise the actual installer download function with isolated files and fake network."""
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile


def main():
    root = Path(__file__).resolve().parents[1]
    source = (root / 'setup.sh').read_text()
    function = source[source.index('fetch() {'):source.index('\ninstall_xkeenui() {')]
    fake = f'#!{sys.executable}\n' + '''import hashlib, os, pathlib, sys
if pathlib.Path(sys.argv[0]).name == 'curl':
    url = next(arg for arg in sys.argv if arg.startswith('https://'))
    log = pathlib.Path(os.environ['CURL_LOG'])
    with log.open('a') as f: f.write(url + '\\n')
    if '-w' in sys.argv:  # resolving /releases/latest
        print('https://github.com/nvorobev/XKeenUI/releases/tag/v9.9.9', end='')
        sys.exit(0)
    if os.environ['CASE'] == 'network-failure': sys.exit(22)
    if os.environ['CASE'] == 'flaky' and not url.endswith('/SHA256SUMS') and log.read_text().count(url) == 1: sys.exit(28)
    target = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])
    if url.endswith('/SHA256SUMS'):
        digest = hashlib.sha256(b'new-binary').hexdigest()
        if os.environ['CASE'] == 'bad-checksum': digest = '0' * 64
        target.write_text(digest + '  xkeen-ui-arm64-v8a\\n')
    else: target.write_bytes(b'new-binary')
else:
    for line in pathlib.Path(sys.argv[-1]).read_text().splitlines():
        digest, name = line.split()
        if hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() != digest: sys.exit(1)
'''
    with tempfile.TemporaryDirectory(prefix='xkeen-init-') as directory:
        init = Path(directory)/'S99xkeen-ui'
        function_init = source[source.index('create_xkeenui_init() {'):source.index('\nget_status() {')]
        script_init = f'XKEENUI_INIT={shlex.quote(str(init))}\n' + function_init + '\ncreate_xkeenui_init\n'
        subprocess.run(['bash', '-ec', script_init], check=True)
        assert os.access(init, os.X_OK) and 'ENABLED=yes' in init.read_text()
        assert '[INIT] action=' in init.read_text() and '${1:-start}' in init.read_text()
        init.write_text(init.read_text().replace('ENABLED=yes','ENABLED=no').replace('-p 1000','-p 1888'))
        init.chmod(0o644)
        subprocess.run(['bash', '-ec', script_init], check=True)
        assert os.access(init, os.X_OK) and 'ENABLED=no' in init.read_text() and '-p 1888' in init.read_text()
        subprocess.run(['sh','-n',str(init)],check=True)
        print('PASS: installer init registration, custom port/disable preservation, executable bit and startup marker')
    for scenario in ('success', 'flaky', 'bad-checksum', 'network-failure'):
        with tempfile.TemporaryDirectory(prefix='xkeen-installer-') as directory:
            path = Path(directory)
            binaries = path / 'bin'
            binaries.mkdir()
            for name in ('curl', 'sha256sum'):
                executable = binaries / name
                executable.write_text(fake)
                executable.chmod(0o755)
            installed = path / 'installed'
            installed.write_bytes(b'old-binary')
            script = 'BETA=false\nLOCAL=false\nARCH=arm64-v8a\n'
            script += f'XKEENUI_BIN={shlex.quote(str(installed))}\nXKEENUI_INIT={shlex.quote(str(path / "missing-init"))}\n'
            script += 'spinner() { wait "$1"; }\nsleep() { :; }\n'
            script += function.replace('/opt/tmp', str(path / 'tmp')) + '\ndownload_files\n'
            log = path / 'curl.log'
            env = {**os.environ, 'CASE': scenario, 'CURL_LOG': str(log), 'PATH': f'{binaries}:/usr/bin:/bin'}
            result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, timeout=10)
            ok = scenario in ('success', 'flaky')
            assert result.returncode == (0 if ok else 1), result.stderr.decode()
            assert installed.read_bytes() == (b'new-binary' if ok else b'old-binary')
            # The exact resolved version is announced and downloaded.
            assert 'v9.9.9' in result.stdout.decode(), result.stdout.decode()
            if scenario != 'network-failure':
                assert '/releases/download/v9.9.9/xkeen-ui-arm64-v8a' in log.read_text()
            print(f'PASS: installer {scenario}')


if __name__ == '__main__':
    main()
