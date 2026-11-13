#!/usr/bin/env python3
"""Real netfilter regression test. Run only in a disposable Linux container with
NET_ADMIN + SYS_ADMIN. All interfaces, namespaces and /opt changes are container-local.
No external server or router is used.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


def run(*args, check=True, **kwargs):
    return subprocess.run(args, check=check, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, **kwargs)


def main():
    assert os.environ.get('XKEEN_UI_GUARD_TEST') == '1', 'Disposable test container required'
    children = []
    with tempfile.TemporaryDirectory(prefix='guard-test-') as temp:
        root = Path(temp)
        hook = root/'guard.sh'
        shutil.copyfile('backend/src/traffic_guard.sh', hook)
        proxy = root/'proxy.sh'
        proxy.write_text('networks="tcp udp"\nport_donor="80,443"\nport_exclude=""\n'
                         'policy_mark="0xffffaaa"\niptables_supported=true\nip6tables_supported=true\n'
                         'exclude_list="10.0.0.0/8 203.0.113.2"\nexclude_list="fc00::/7"\n')
        cfg = root/'config.json'; cfg.write_text(json.dumps({'mode':'strict', 'policy_mark':'0xffffaaa'}))
        health = root/'health'
        env = {**os.environ, 'GUARD_HOOK':str(hook), 'GUARD_CONFIG':str(cfg),
               'XKEEN_HOOK':str(proxy), 'GUARD_HEALTH':str(health),
               'GUARD_LOCK':str(root/'lock'), 'GUARD_WATCH_LOCK':str(root/'watch'), 'GUARD_NO_WATCH':'1'}

        def apply(action=''):
            result = run('sh', str(hook), *([action] if action else []), env=env)
            return result

        def lease(seconds=35, pid=None):
            uptime = int(float(Path('/proc/uptime').read_text().split()[0]))
            health.write_text(f'{pid or os.getpid()} {uptime+seconds}\n')

        def namespace():
            child = subprocess.Popen(['unshare','-n','--','sleep','300'])
            children.append(child)
            for _ in range(100):
                if child.poll() is not None: raise AssertionError('Network namespace creation failed')
                if os.readlink(f'/proc/{child.pid}/ns/net') != os.readlink('/proc/self/ns/net'): break
                time.sleep(.02)
            return child.pid

        def ns(pid, *args, **kwargs): return run('nsenter','-t',str(pid),'-n',*args,**kwargs)

        try:
            client, wan = namespace(), namespace()
            for name, peer, pid in [('lan','client',client), ('wan','server',wan)]:
                run('ip','link','add',name,'type','veth','peer','name',peer)
                run('ip','link','set',peer,'netns',str(pid))
                run('ip','link','set',name,'up'); ns(pid,'ip','link','set',peer,'up'); ns(pid,'ip','link','set','lo','up')
            for dev, v4, v6 in [('lan','10.42.0.1/24','fd42::1/64'),('wan','203.0.113.1/24','2001:db8:42::1/64')]:
                run('ip','addr','add',v4,'dev',dev); run('ip','-6','addr','add',v6,'dev',dev,'nodad')
            for pid, dev, v4, v6, gw4, gw6 in [(client,'client','10.42.0.2/24','fd42::2/64','10.42.0.1','fd42::1'),
                                              (wan,'server','203.0.113.2/24','2001:db8:42::2/64','203.0.113.1','2001:db8:42::1')]:
                ns(pid,'ip','addr','add',v4,'dev',dev); ns(pid,'ip','-6','addr','add',v6,'dev',dev,'nodad')
                ns(pid,'ip','route','add','default','via',gw4); ns(pid,'ip','-6','route','add','default','via',gw6)
            assert Path('/proc/sys/net/ipv6/conf/all/forwarding').read_text().strip() == '1', 'Start container with IPv6 forwarding enabled'
            for family in ['iptables','ip6tables']:
                run(family,'-t','mangle','-A','PREROUTING','-i','lan','-j','CONNMARK','--set-mark','0xffffaaa')
                run(family,'-t','mangle','-A','PREROUTING','-i','lan','-j','MARK','--set-mark','0xffffaaa')
            # Emulate REDIRECT to Xray. A local listener represents a proxy that might use direct.
            run('iptables','-t','nat','-A','PREROUTING','-i','lan','-p','tcp','--dport','443','-j','REDIRECT','--to-port','18080')
            for pid, bind, port in [(None,'0.0.0.0',18080),(None,'::',18082),(wan,'0.0.0.0',8080),(wan,'::',8081)]:
                cmd=['python3','-m','http.server',str(port),'--bind',bind,'--directory',str(root)]
                if pid: cmd=['nsenter','-t',str(pid),'-n',*cmd]
                children.append(subprocess.Popen(cmd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            # TPROXY overwrites the packet mark. Its original connection mark must still protect it.
            run('iptables','-t','mangle','-A','PREROUTING','-i','lan','-p','udp','--dport','8443',
                '-j','TPROXY','--on-port','18081','--tproxy-mark','0x111')
            run('ip','rule','add','fwmark','0x111','table','111')
            run('ip','route','add','local','0.0.0.0/0','dev','lo','table','111')
            udp_server = "import socket\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\ns.setsockopt(socket.SOL_IP,19,1)\ns.bind(('0.0.0.0',18081))\nwhile True:\n b,a=s.recvfrom(1024)\n s.sendto(b,a)"
            children.append(subprocess.Popen(['python3','-c',udp_server],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            time.sleep(.5)

            def udp():
                code = "import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(1); s.sendto(b'probe',('203.0.113.2',8443)); assert s.recvfrom(1024)[0]==b'probe'"
                return ns(client,'python3','-c',code,check=False).returncode == 0

            def fetch(url, pid=client):
                prefix=['nsenter','-t',str(pid),'-n'] if pid else []
                return run(*prefix,'curl','--noproxy','*','-fsS','--max-time','1',url,check=False).returncode == 0

            def stream_peer(pid, role, transport, address, port):
                # Keep the same socket/conntrack entry across the gate transition.
                code = '''import socket, sys
role, transport, address, port = sys.argv[1:]
s = socket.socket(socket.AF_INET6 if ':' in address else socket.AF_INET,
                  socket.SOCK_DGRAM if transport == 'udp' else socket.SOCK_STREAM)
s.settimeout(3)
if role == 'server':
 s.bind((address, int(port)))
 if transport == 'tcp': s.listen(1)
 print('READY', flush=True)
 if transport == 'tcp':
  s, _ = s.accept(); s.settimeout(3)
  assert s.recv(1024) == b'open'; s.sendall(b'open')
 else:
  data, peer = s.recvfrom(1024); assert data == b'open'; s.connect(peer); s.send(b'open')
else:
 s.connect((address, int(port))); s.send(b'open'); assert s.recv(1024) == b'open'
print('CONNECTED', flush=True)
s.settimeout(.7)
for command in sys.stdin:
 s.settimeout(20 if command.strip() == 'recvwait' else .7)
 if command.strip() == 'send':
  try: s.send(b'late'); print('SENT', flush=True)
  except OSError: print('CLOSED', flush=True)
 else:
  try: print(s.recv(1024).decode() or 'CLOSED', flush=True)
  except socket.timeout: print('TIMEOUT', flush=True)
'''
                prefix = ['nsenter','-t',str(pid),'-n'] if pid else []
                child = subprocess.Popen([*prefix,'python3','-u','-c',code,role,transport,address,str(port)],
                                         stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                children.append(child)
                return child

            def command(child, action):
                child.stdin.write(action+'\n'); child.stdin.flush()
                return child.stdout.readline().strip()

            def open_stream(transport, address, port, local=False):
                server = stream_peer(None if local else wan,'server',transport,'0.0.0.0' if ':' not in address else '::',port)
                assert server.stdout.readline().strip() == 'READY'
                peer = stream_peer(client,'client',transport,address,444 if local else port)
                assert peer.stdout.readline().strip() == 'CONNECTED'
                assert server.stdout.readline().strip() == 'CONNECTED'
                return peer, server

            # Some proxy configurations mark router-originated probes too. Their
            # original OUTPUT packets and INPUT replies must not be mistaken for clients.
            for family, address in [('iptables','203.0.113.2'),('ip6tables','2001:db8:42::2')]:
                run(family,'-t','mangle','-A','OUTPUT','-d',address,'-p','tcp','-j','CONNMARK','--set-mark','0xffffaaa')

            apply()
            ns(client,'ip','-6','neigh','flush','dev','client')
            run('ip','-6','neigh','flush','dev','lan')
            assert fetch('http://[fd42::1]:18082/'), 'IPv6 LAN neighbor discovery must work with a closed gate'
            assert not fetch('http://203.0.113.2:8080/'), 'Strict mode must ignore public exclusions and port_donor'
            assert not fetch('http://203.0.113.2:443/'), 'REDIRECT must not bypass the gate through INPUT'
            assert not fetch('http://[2001:db8:42::2]:8081/'), 'IPv6 Internet must also be blocked'
            assert not udp(), 'TPROXY must remain blocked after overwriting the packet mark'
            assert fetch('http://10.42.0.1:18080/'), 'LAN/panel access must remain available'
            assert fetch('http://203.0.113.2:8080/',None), 'Router probes must remain possible while clients are blocked'
            assert fetch('http://[2001:db8:42::2]:8081/',None), 'Marked IPv6 router probes must remain possible'
            print('PASS: closed initially, all ports/public exclusions/direct/REDIRECT/IPv6 blocked; LAN and router probes preserved',flush=True)
            lease(); apply('tick')
            for family in ['iptables','ip6tables']:
                run(family,'-D','OUTPUT','-m','conntrack','--ctdir','REPLY','-m','connmark','--mark','0xffffaaa','-j','xkeen_ui_lock')
            apply('tick')
            for family in ['iptables','ip6tables']:
                run(family,'-C','OUTPUT','-m','conntrack','--ctdir','REPLY','-m','connmark','--mark','0xffffaaa','-j','xkeen_ui_lock')
            assert fetch('http://203.0.113.2:8080/') and fetch('http://203.0.113.2:443/')
            if not fetch('http://[2001:db8:42::2]:8081/'):
                for cmd in [('ip6tables','-nvL'),('ip','-6','route'),('ip','-6','rule')]:
                    print(run(*cmd).stdout,flush=True)
                print(ns(client,'ip','-6','route').stdout,flush=True)
                print(ns(wan,'ip','-6','route').stdout,flush=True)
                raise AssertionError('IPv6 gate did not reopen')
            assert udp(), 'Healthy VPN must reopen TPROXY client traffic'
            run('iptables','-t','nat','-A','PREROUTING','-i','lan','-p','tcp','--dport','444',
                '-j','REDIRECT','--to-port','18090')
            streams = [
                ('forwarded UDP', *open_stream('udp','203.0.113.2',8082)),
                ('forwarded TCP', *open_stream('tcp','203.0.113.2',8083)),
                ('IPv6 UDP', *open_stream('udp','2001:db8:42::2',8084)),
                ('REDIRECT TCP', *open_stream('tcp','203.0.113.2',18090,local=True)),
            ]
            lease(-1); apply('tick'); assert not fetch('http://203.0.113.2:8080/')
            for name, peer, server in streams:
                assert command(server,'send') == 'SENT'
                assert command(peer,'recv') == 'TIMEOUT', f'Existing {name} reply stream bypassed the closed gate'
                assert command(peer,'send') == 'SENT'
                assert command(server,'recv') == 'TIMEOUT', f'Existing {name} request stream bypassed the closed gate'
            assert fetch('http://10.42.0.1:18080/'), 'Closing existing streams must preserve LAN/panel access'
            assert fetch('http://203.0.113.2:8080/',None), 'Closing existing streams must preserve router probes'
            lease(); apply('tick')
            for name, peer, server in streams:
                # Drain delayed TCP data after reopening; UDP data was dropped.
                if 'TCP' in name:
                    assert command(peer,'recvwait') == 'late', f'{name} did not resume after recovery'
                    assert command(server,'recvwait') == 'late', f'{name} requests did not resume after recovery'
                assert command(server,'send') == 'SENT'
                assert command(peer,'recv') == 'late', f'{name} did not reopen after recovery'
            lease(-1); apply('tick')
            print('PASS: established TCP/UDP/IPv6/REDIRECT streams stop in both directions and recover; LAN/probes preserved',flush=True)
            print('PASS: watchdog repairs missing OUTPUT protection for both address families',flush=True)
            lease(pid=99999999); apply('tick'); assert not fetch('http://203.0.113.2:443/')
            print('PASS: fresh successful lease opens both families; expired lease/dead daemon closes again',flush=True)
            # A hook that was removed on service stop still has a saved policy to protect.
            proxy.unlink(); health.unlink(); apply()
            assert not fetch('http://203.0.113.2:443/')
            print('PASS: strict mode survives missing proxy.sh using the persisted policy mark',flush=True)
            # Independent watchdog must close an open gate without a daemon or firewall event.
            lease(1); apply()
            env['GUARD_NO_WATCH']='0'; apply()
            time.sleep(4)
            assert not fetch('http://203.0.113.2:8080/')
            print('PASS: independent watchdog expires a stale success without another API/firewall event',flush=True)
            apply('remove')
            assert fetch('http://203.0.113.2:8080/') and fetch('http://203.0.113.2:443/')
            for family in ['iptables','ip6tables']:
                for parent in ['INPUT','FORWARD','OUTPUT']:
                    assert 'xkeen_ui_lock' not in run(family,'-S',parent).stdout, 'Disable left a strict jump behind'
            print('PASS: disabling removes INPUT/FORWARD/OUTPUT gates and restores traffic',flush=True)
        finally:
            hook.unlink(missing_ok=True)
            for child in children:
                if child.poll() is None: child.terminate()
            for child in children:
                try: child.wait(timeout=3)
                except subprocess.TimeoutExpired: child.kill(); child.wait()


if __name__ == '__main__': main()
