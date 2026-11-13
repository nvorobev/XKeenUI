#!/usr/bin/env python3
"""Validate constructor output with the real Xray core and real GeoIP/GeoSite.

No router or remote proxy is used. Unavailable catalogue entries must be disabled
by the UI; report them separately and require Xray to reject missing categories.
"""
import argparse
import concurrent.futures
import json
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile


def varint(data, pos):
    value = shift = 0
    while True:
        byte = data[pos]; pos += 1
        value |= (byte & 127) << shift
        if byte < 128: return value, pos
        shift += 7
        if shift > 63: raise ValueError('Invalid protobuf varint')


def fields(data):
    pos = 0
    while pos < len(data):
        key, pos = varint(data, pos)
        kind, number = key & 7, key >> 3
        if kind == 2:
            size, pos = varint(data, pos)
            value = data[pos:pos+size]; pos += size
        elif kind == 0: value, pos = varint(data, pos)
        elif kind in (1, 5):
            size = 8 if kind == 1 else 4
            value = data[pos:pos+size]; pos += size
        else: raise ValueError('Unsupported wire type')
        yield number, kind, value


def category_codes(path):
    return {str(value.decode()).lower() for tag, kind, entry in fields(path.read_bytes()) if tag == 1 and kind == 2
            for field, wire, value in fields(entry) if field == 1 and wire == 2}


def references(config):
    for rule in config['routing']['rules']:
        for field in ('domain', 'ip'):
            for value in rule.get(field, []):
                if value.startswith('ext:'):
                    filename, tag = value[4:].split(':', 1)
                elif value.startswith(('geoip:', 'geosite:')):
                    prefix, tag = value.split(':', 1); filename = prefix + '.dat'
                else: continue
                yield filename, tag.lstrip('!').split('@')[0].lower()


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('xray'); parser.add_argument('cases'); parser.add_argument('assets'); parser.add_argument('--report'); parser.add_argument('--download', action='store_true')
    args = parser.parse_args(); assets = Path(args.assets).resolve()
    if args.download:
        assets.mkdir(parents=True, exist_ok=True)
        manifest = json.loads(Path(__file__).with_name('routing-geo-assets.json').read_text())
        for item in manifest:
            path = assets/item['file']
            if not path.exists():
                subprocess.run(['curl','--retry','3','-fLsS',item['source'],'-o',str(path)],check=True)
            assert hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256'], f'Checksum mismatch: {path}'
    files = {p.name: category_codes(p) for p in assets.glob('*.dat')}
    # Standard prefixes refer to the standard asset names; test both spellings.
    for short, long in [('geosite.dat','geosite_v2fly.dat'),('geoip.dat','geoip_v2fly.dat')]:
        if short not in files and long in files:
            (assets/short).symlink_to(long); files[short] = files[long]
    cases = json.loads(Path(args.cases).read_text())
    def validate(case):
        config = {**case['config'], 'log': {'loglevel': 'error'}, 'inbounds': [
            {'tag': 'redirect', 'listen': '127.0.0.1', 'port': 18881, 'protocol': 'socks'},
            {'tag': 'tproxy', 'listen': '127.0.0.1', 'port': 18882, 'protocol': 'socks'}],
            'outbounds': [{'tag':'vless-reality','protocol':'freedom'}, {'tag':'direct','protocol':'freedom'}, {'tag':'block','protocol':'blackhole'}]}
        missing = [f'{filename}:{tag}' for filename,tag in references(case['config']) if tag not in files.get(filename,set())]
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as file:
            json.dump(config,file); file.flush()
            result = subprocess.run([args.xray,'run','-test','-config',file.name],env={**os.environ,'XRAY_LOCATION_ASSET':str(assets)},capture_output=True,text=True,timeout=30)
        output = result.stdout + result.stderr
        if missing:
            assert result.returncode != 0, (case['name'],'Xray unexpectedly accepted missing category',missing)
            return {'name':case['name'],'status':'unavailable','missing':missing}
        assert result.returncode == 0, (case['name'],output)
        return {'name':case['name'],'status':'valid'}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: results = list(pool.map(validate,cases))
    # Every individual catalogue item is checked in all three actions.
    valid = sum(item['status']=='valid' for item in results)
    unavailable = sorted({value for item in results for value in item.get('missing',[])})
    report = {'total':len(results),'valid':valid,'unavailable_categories':unavailable,'results':results}
    if args.report: Path(args.report).write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(f'PASS: {valid} generated configs accepted by real Xray; {len(results)-valid} correctly rejected for missing Geo categories')
    print('Unavailable catalogue categories:',json.dumps(unavailable,ensure_ascii=False))


if __name__ == '__main__': main()
