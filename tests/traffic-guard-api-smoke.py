#!/usr/bin/env python3
"""Strict guard API + real Xray probe. Disposable Linux container with NET_ADMIN only."""
import http.cookiejar
import http.server
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import threading
import time
import urllib.request


def main():
    assert os.environ.get('XKEEN_UI_GUARD_TEST') == '1'
    assert not Path('/opt/etc/xkeen').exists(), 'Empty disposable /opt required'
    binary, xray = map(lambda p: str(Path(p).resolve()), sys.argv[1:3])
    mihomo = str(Path(sys.argv[3]).resolve()) if len(sys.argv)>3 else None
    for name in ['etc/xkeen','etc/xray/configs','etc/init.d','etc/ndm/netfilter.d','sbin','var/log/xray']:
        Path('/opt',name).mkdir(parents=True,exist_ok=True)
    Path('/opt/sbin/xray').symlink_to(xray)
    Path('/opt/etc/init.d/S99xkeen').write_text('#!/bin/sh\nname_client="xray"\n')
    Path('/opt/etc/ndm/netfilter.d/proxy.sh').write_text('networks="tcp udp"\npolicy_mark="0xffffaaa"\nport_donor="80,443"\niptables_supported=true\nip6tables_supported=true\n')
    fixture_class = runpy.run_path('tests/panel-api-smoke.py')['Proxy']
    def fixture(port=0):
        server = http.server.ThreadingHTTPServer(('127.0.0.1',port),fixture_class)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        return server
    remote = fixture(); remote_port = remote.server_port
    config = {'log':{'loglevel':'warning'},'outbounds':[{'tag':'vpn','protocol':'http','settings':{'servers':[{'address':'127.0.0.1','port':remote_port}]}},{'tag':'direct','protocol':'freedom'}]}
    Path('/opt/etc/xray/configs/04_outbounds.json').write_text(json.dumps(config))
    log = open('/opt/test.log','wb')
    env = {**os.environ,'PATH':'/opt/sbin:'+os.environ['PATH']}
    core = subprocess.Popen([xray,'run','-confdir','/opt/etc/xray/configs'],stdout=log,stderr=log,env=env)
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
    client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    process=None
    def request(method,path,body=None):
        req=urllib.request.Request(f'http://127.0.0.1:{port}/api/{path}',method=method,
            data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
        with client.open(req,timeout=30) as res: data=json.load(res)
        assert data.get('success',True),data
        return data
    def wait(condition,label,seconds=35):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            try:
                if condition():return
            except (OSError,urllib.error.URLError):pass
            time.sleep(.25)
        raise AssertionError(label+'\n'+Path('/opt/test.log').read_text())
    def start():
        child=subprocess.Popen([binary,'--port',str(port)],stdout=log,stderr=log,env=env)
        wait(lambda:request('GET','auth/login'),'panel startup',10)
        return child
    def gate(target):
        return subprocess.run(['iptables','-C','xkeen_ui_gate','-j',target],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
    try:
        process=start();request('POST','auth/login',{'username':'admin','password':'admin'})
        request('PATCH','settings',{'clash_api':{'ping_url':'http://probe.test','ping_timeout':1000}})
        enabled=request('PUT','traffic-guard',{'enabled':True,'mode':'strict'})
        assert enabled['mode']=='strict'
        wait(lambda:request('GET','traffic-guard')['health']['blocked'] is False and gate('RETURN'),'healthy VPN did not open gate')
        print('PASS: API persists strict mode; real Xray outbound probe opens the gate',flush=True)
        remote.shutdown();remote.server_close();remote=None
        wait(lambda:request('GET','traffic-guard')['health']['blocked'] is True and gate('DROP'),'failed VPN did not close gate')
        print('PASS: VPN outage closes gate without a browser action',flush=True)
        remote=fixture(remote_port)
        wait(lambda:request('GET','traffic-guard')['health']['blocked'] is False and gate('RETURN'),'VPN recovery did not reopen gate')
        print('PASS: VPN recovery automatically reopens Internet',flush=True)
        process.terminate();process.wait(timeout=5)
        wait(lambda:gate('DROP'),'daemon exit did not close gate',6)
        process=start()
        wait(lambda:request('GET','traffic-guard')['mode']=='strict' and request('GET','traffic-guard')['health']['blocked'] is False,'mode did not survive panel restart')
        print('PASS: watchdog closes after panel exit; strict settings survive restart and fresh probes recover',flush=True)
        request('PUT','traffic-guard',{'enabled':False})
        assert subprocess.run(['iptables','-S','xkeen_ui_gate'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
        time.sleep(3)
        assert subprocess.run(['iptables','-S','xkeen_ui_gate'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
        print('PASS: Disable removes gates and a queued watchdog does not reinstall them',flush=True)
        if mihomo:
            process.terminate();process.wait(timeout=5)
            core.terminate();core.wait(timeout=5)
            Path('/opt/sbin/mihomo').symlink_to(mihomo)
            Path('/opt/etc/mihomo').mkdir(exist_ok=True)
            Path('/opt/etc/init.d/S99xkeen').write_text('#!/bin/sh\nname_client="mihomo"\n')
            sock=socket.socket();sock.bind(('127.0.0.1',0));controller_port=sock.getsockname()[1];sock.close()
            cfg={'external-controller':f'127.0.0.1:{controller_port}','mode':'rule','dns':{'enable':False},
                 'proxies':[{'name':'A','type':'http','server':'127.0.0.1','port':remote_port}],
                 'proxy-groups':[{'name':'VPN','type':'select','proxies':['A','DIRECT']}],'rules':['MATCH,VPN']}
            Path('/opt/etc/mihomo/config.yaml').write_text(json.dumps(cfg))
            remote.delay=.02
            core=subprocess.Popen([mihomo,'-d','/opt/etc/mihomo'],stdout=log,stderr=log,env=env)
            def clash(method,path,body=None):
                req=urllib.request.Request(f'http://127.0.0.1:{controller_port}/{path}',method=method,
                    data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
                with urllib.request.urlopen(req,timeout=10) as res:
                    raw=res.read();return json.loads(raw) if raw else None
            wait(lambda:clash('GET','version'),'Mihomo startup',10)
            process=start()
            request('PUT','traffic-guard',{'enabled':True,'mode':'strict','target':'VPN'})
            wait(lambda:request('GET','traffic-guard')['health']['blocked'] is False and gate('RETURN'),'Mihomo VPN probe did not open gate')
            clash('PUT','proxies/VPN',{'name':'DIRECT'})
            wait(lambda:request('GET','traffic-guard')['health']['blocked'] is True and gate('DROP'),'DIRECT must never count as a healthy VPN')
            clash('PUT','proxies/VPN',{'name':'A'})
            wait(lambda:request('GET','traffic-guard')['health']['blocked'] is False and gate('RETURN'),'Mihomo VPN recovery did not reopen gate')
            request('PUT','traffic-guard',{'enabled':False})
            print('PASS: real Mihomo group probing opens for VPN, blocks DIRECT selection and recovers automatically',flush=True)

    finally:
        for child in [process,core]:
            if child is not None and child.poll() is None:child.terminate();child.wait(timeout=5)
        if remote:remote.shutdown();remote.server_close()
        log.close()


if __name__=='__main__':main()
