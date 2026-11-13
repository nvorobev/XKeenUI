import type { Destination } from '../src/components/configuration/xray/routing-builder'
import {
  applyPreset,
  emptyGenerator,
  generateCategories,
  GEO_CATALOG,
  normalizeGeo,
  setFlag,
  type Category,
  type Flag,
  type InputKey,
  type Preset,
} from '../src/components/configuration/xray/routing-generator'
import reference from './fixtures/routing-reference.json'
export const targets: Destination[] = [
  { value: 'outboundTag:block', tag: 'block', kind: 'outboundTag', protocol: 'blackhole', label: 'Блокировка' },
  { value: 'outboundTag:vless-reality', tag: 'vless-reality', kind: 'outboundTag', protocol: 'vless', label: 'VPN' },
  { value: 'outboundTag:direct', tag: 'direct', kind: 'outboundTag', protocol: 'freedom', label: 'Напрямую' },
]
export const fresh = () => emptyGenerator({ block: targets[0].value, vpn: targets[1].value, direct: targets[2].value })
const flags: Record<string, [Category, Flag]> = {
  blockQuic: ['block', 'quic'],
  blockedSites: ['vpn', 'blocked'],
  discord: ['vpn', 'discord'],
  localNetworks: ['direct', 'local'],
  torrent: ['direct', 'torrent'],
  'block-blockAds': ['block', 'ads'],
  'block-blockUdp': ['block', 'udp'],
}
const inputs: Record<string, InputKey> = {
  'ports-tcp': 'tcpPorts',
  'ports-udp': 'udpPorts',
  'ips-exact': 'ipsExact',
  'ips-cidr': 'ipsCidr',
  'domains-partial': 'partial',
  'domains-sub': 'sub',
  'domains-exact': 'exact',
  'domains-regex': 'regex',
}
export function referenceState(item: (typeof reference)[number]) {
  const name = item.name
  let state = fresh()
  if (flags[name]) {
    const [category, flag] = flags[name]
    state = setFlag(state, category, flag, true)
  } else if (name.endsWith('CatchAll')) state.fallback = name.replace('CatchAll', '') as Category
  else if (name.startsWith('preset-')) state = applyPreset(state, name.slice(7) as Preset)
  else if (name.startsWith('strategy-')) state.strategy = name.slice(9) === 'off' ? '' : name.slice(9)
  else if (name.startsWith('order-')) {
    state = setFlag(state, 'block', 'udp', true)
    state = setFlag(state, 'direct', 'torrent', true)
    state = setFlag(state, 'vpn', 'discord', true)
    state.strategy = 'IPOnDemand'
    state.order = ['block', 'vpn', 'direct']
  } else {
    const [category, ...parts] = name.split('-'),
      key = parts.join('-'),
      group = state.groups[category as Category]
    if (key.startsWith('catalog-'))
      group.geo = (GEO_CATALOG[key.slice(8) as keyof typeof GEO_CATALOG] ?? []).flatMap((g) => g.items.map((i) => i.value))
    else if (key.startsWith('geo-manual-'))
      group.geo = normalizeGeo('input' in item ? String(item.input) : '', key.endsWith('ip') ? 'ip' : 'site')
    else group[inputs[key]] = 'input' in item ? String(item.input) : ''
  }
  return state
}
export const referenceVectors = reference.map((item) => {
  const state = referenceState(item)
  return {
    name: item.name,
    state,
    expected: item.config,
    actual: { routing: { ...(state.strategy ? { domainStrategy: state.strategy } : {}), rules: generateCategories(state, targets) } },
  }
})
export function coreVectors() {
  const cases = referenceVectors.map((v) => ({ name: v.name, config: v.actual }))
  for (const category of ['block', 'vpn', 'direct'] as Category[])
    for (const [base, groups] of Object.entries(GEO_CATALOG))
      for (const item of groups.flatMap((g) => g.items)) {
        const state = fresh()
        state.groups[category].geo = [item.value]
        cases.push({
          name: `single-${category}-${base}-${item.text}`,
          config: { routing: { domainStrategy: state.strategy, rules: generateCategories(state, targets) } },
        })
      }
  for (const category of ['block', 'vpn', 'direct'] as Category[]) {
    const state = fresh()
    Object.assign(state.groups[category], {
      tcpPorts: '1,65535,20-25',
      udpPorts: '53,443',
      ipsExact: '127.0.0.1,::1,2001:db8::1',
      ipsCidr: '0.0.0.0/0,10.0.0.0/8,::/0,2001:db8::/32',
      partial: 'tracker',
      sub: 'domain:example.com',
      exact: 'full:localhost',
      regex: 'regexp:^a{1,3}\\.example$',
    })
    cases.push({
      name: `combined-${category}-ipv6-regex-and-domains`,
      config: { routing: { domainStrategy: state.strategy, rules: generateCategories(state, targets) } },
    })
  }
  const safe = setFlag(fresh(), 'block', 'quic', true)
  safe.groups.block.geo = ['geoip:ru']
  cases.push({
    name: 'quic-plus-geoip-keeps-port-condition',
    config: { routing: { domainStrategy: safe.strategy, rules: generateCategories(safe, targets) } },
  })
  return cases
}
