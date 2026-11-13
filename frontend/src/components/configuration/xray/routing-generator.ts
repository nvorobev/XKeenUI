import type { Config } from '@/lib/types'
import { destinations, isPoolConfig, readObject, type Destination, type RoutingRule } from './routing-builder'
import catalog from './routing-catalog.json'
import discordNetworks from './routing-discord.json'

export type Category = 'block' | 'vpn' | 'direct'
export type Preset = 'full-vpn' | 'except-ru' | 'blocked-only'
export type InputKey = 'tcpPorts' | 'udpPorts' | 'ipsExact' | 'ipsCidr' | 'partial' | 'sub' | 'exact' | 'regex'
export type Flag = 'ads' | 'udp' | 'quic' | 'blocked' | 'discord' | 'local' | 'torrent'
export type Group = Record<InputKey, string> & { geo: string[]; flags: Partial<Record<Flag, boolean>> }
export type Generator = {
  strategy: string
  order: Category[]
  groups: Record<Category, Group>
  fallback: Category | ''
  bindings: Record<Category, string>
  scope: string[]
  retained: RoutingRule[]
  apiRules: RoutingRule[]
}
export const TITLES: Record<Category, string> = { block: 'Блокировка', vpn: 'VPN', direct: 'Прямое подключение' }
export const STRATEGIES = [
  { value: '', label: 'Выкл' },
  { value: 'AsIs', label: 'AsIs - только доменные имена' },
  { value: 'IPIfNonMatch', label: 'IPIfNonMatch - рекомендуется' },
  { value: 'IPOnDemand', label: 'IPOnDemand - с DNS-запросами' },
]
export const BASES = [
  { value: 'geosite_v2fly', label: 'GeoSite v2fly' },
  { value: 'geoip_v2fly', label: 'GeoIP v2fly' },
  { value: 'antifilter', label: 'AntiFilter' },
  { value: 'geosite_zkeen', label: 'GeoSite zKeen' },
  { value: 'geoip_zkeen', label: 'GeoIP zKeen' },
  { value: 'geosite_category', label: 'GeoSite Категории' },
  { value: 'geosite_region', label: 'GeoSite Регионы' },
]
export const GEO_CATALOG = catalog
export const ADS = [
  'ext:geosite_v2fly.dat:category-ads-all',
  'google-analytics',
  'analytics.yandex',
  'appcenter.ms',
  'app-measurement.com',
  'firebase.io',
  'crashlytics.com',
]
export const BLOCKED = ['ext:geosite_zkeen.dat:domains', 'ext:geosite_zkeen.dat:other', 'ext:geosite_zkeen.dat:youtube']
export const LOCAL = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']
export const DISCORD_IP = 'ext:geoip_zkeenip.dat:discord'
export const QUIC_IP = 'ext:geoip_zkeenip.dat:!ru'
export const UDP_PORTS = '135,137,138,139'
export const DISCORD_PORTS = '50000-50030'
const unique = (values: string[]) => [...new Set(values)]
export const split = (text: string) =>
  unique(
    text
      .split(/[,\n]+/)
      .map((v) => v.trim())
      .filter(Boolean)
  )
export const geoIsIp = (value: string) => /^(geoip:|ext(?:-ip)?:[^:]*?(?:geoip|zkeenip)[^:]*\.dat:)/i.test(value)
export function emptyGroup(): Group {
  return { tcpPorts: '', udpPorts: '', ipsExact: '', ipsCidr: '', partial: '', sub: '', exact: '', regex: '', geo: [], flags: {} }
}
export function emptyGenerator(bindings: Generator['bindings'], scope: string[] = ['redirect', 'tproxy']): Generator {
  return {
    strategy: 'IPIfNonMatch',
    order: ['block', 'direct', 'vpn'],
    groups: { block: emptyGroup(), vpn: emptyGroup(), direct: emptyGroup() },
    fallback: '',
    bindings,
    scope,
    retained: [],
    apiRules: [],
  }
}
export function setFlag(state: Generator, category: Category, flag: Flag, enabled: boolean): Generator {
  const next = structuredClone(state),
    group = next.groups[category]
  group.flags[flag] = enabled
  const geo = flag === 'ads' ? ADS.slice(0, 1) : flag === 'blocked' ? BLOCKED : flag === 'discord' ? [DISCORD_IP] : []
  group.geo = enabled ? unique([...group.geo, ...geo]) : group.geo.filter((v) => !geo.includes(v))
  if (flag === 'udp') {
    if (enabled && !group.udpPorts) group.udpPorts = UDP_PORTS
    else if (!enabled && group.udpPorts === UDP_PORTS) group.udpPorts = ''
  }
  if (flag === 'discord')
    group.udpPorts = enabled
      ? unique([...split(group.udpPorts), DISCORD_PORTS]).join(',')
      : split(group.udpPorts)
          .filter((v) => v !== DISCORD_PORTS)
          .join(',')
  if (flag === 'discord')
    group.ipsCidr = enabled
      ? unique([...split(group.ipsCidr), ...discordNetworks]).join(',')
      : split(group.ipsCidr)
          .filter((value) => !discordNetworks.includes(value))
          .join(',')
  return next
}
export function applyPreset(state: Generator, preset: Preset): Generator {
  let next = { ...emptyGenerator(state.bindings, state.scope), retained: state.retained, apiRules: state.apiRules }
  next = setFlag(next, 'block', 'udp', true)
  next = setFlag(next, 'direct', 'torrent', true)
  if (preset === 'blocked-only') {
    next.order = ['block', 'vpn', 'direct']
    next = setFlag(next, 'vpn', 'blocked', true)
    next.fallback = 'direct'
  } else {
    next.fallback = 'vpn'
    if (preset === 'except-ru')
      next.groups.direct.geo = GEO_CATALOG.geosite_category[0].items
        .map((i) => i.value)
        .concat([
          'ext:geosite_v2fly.dat:category-gov-ru',
          'ext:geosite_v2fly.dat:yandex',
          'ext:geosite_v2fly.dat:vk',
          'ext:geosite_v2fly.dat:steam',
          'ext:geoip_zkeenip.dat:ru',
        ])
  }
  return next
}
export function normalizeGeo(text: string, kind: 'ip' | 'site'): string[] {
  return split(text).map((value) => {
    if (/^(?:geoip:|geosite:|regexp:|ext(?:-ip|-domain|-site)?:)/i.test(value)) return value
    return `${kind === 'ip' ? 'geoip' : 'geosite'}:${value}`
  })
}
export function parseRegexes(text: string): string[] {
  const out: string[] = []
  let start = 0,
    brace = 0,
    bracket = 0,
    paren = 0,
    escaped = false
  for (let i = 0; i <= text.length; i++) {
    const c = text[i]
    if ((i === text.length || c === '\n' || (c === ',' && !brace && !bracket && !paren)) && !escaped) {
      const value = text.slice(start, i).trim()
      if (value) out.push(value.startsWith('regexp:') ? value : `regexp:${value}`)
      start = i + 1
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\') {
      escaped = true
      continue
    }
    if (c === '[') bracket++
    if (c === ']') bracket = Math.max(0, bracket - 1)
    if (!bracket) {
      if (c === '{') brace++
      if (c === '}') brace = Math.max(0, brace - 1)
      if (c === '(') paren++
      if (c === ')') paren = Math.max(0, paren - 1)
    }
  }
  return unique(out)
}
function ports(text: string): string {
  const values = split(text)
  for (const value of values) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(value),
      a = Number(match?.[1]),
      b = Number(match?.[2] ?? match?.[1])
    if (!match || a < 1 || b > 65535 || b < a) throw new Error(`Неверный порт или диапазон: ${value}`)
  }
  return values.join(',')
}
export function validIp(value: string, cidr: boolean): boolean {
  const [ip, mask, ...extra] = value.split('/')
  if (extra.length || (!cidr && mask !== undefined) || (mask !== undefined && !/^\d+$/.test(mask))) return false
  let isV6 = false
  if (ip.includes(':')) {
    try {
      if (!/^[\da-f:.]+$/i.test(ip)) return false
      new URL(`http://[${ip}]/`)
      isV6 = true
    } catch {
      return false
    }
  } else if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || ip.split('.').some((part) => Number(part) > 255)) return false
  return mask === undefined || Number(mask) <= (isV6 ? 128 : 32)
}
function domain(value: string, prefix: 'domain:' | 'full:'): string {
  const host = value.startsWith(prefix) ? value.slice(prefix.length) : value
  if (!host || /[\s/:?#,@*]/.test(host) || host.startsWith('.') || host.includes('..')) throw new Error(`Неверный домен: ${value}`)
  return prefix + host.toLowerCase()
}
function geoRule(value: string): string {
  if (
    /^(?:geoip|geosite):!?[\w@.-]+$/i.test(value) ||
    /^ext(?:-ip|-domain|-site)?:[\w.-]+\.dat:!?[\w@.-]+$/i.test(value) ||
    value.startsWith('regexp:')
  )
    return value
  throw new Error(`Неверное правило GeoIP/GeoSite: ${value}`)
}
export function generateCategories(state: Generator, targets: Destination[]): RoutingRule[] {
  if (new Set(state.order).size !== 3 || !['block', 'vpn', 'direct'].every((c) => state.order.includes(c as Category)))
    throw new Error('Неверный порядок категорий')
  const target = (category: Category) => {
    const destination = targets.find((t) => t.value === state.bindings[category])
    if (!destination) throw new Error(`Для категории «${TITLES[category]}» выберите подключение`)
    return { [destination.kind]: destination.tag }
  }
  const result: RoutingRule[] = [...state.apiRules, ...state.retained]
  for (const category of state.order) {
    const group = state.groups[category],
      flags = group.flags
    const make = (fields: RoutingRule): RoutingRule => ({
      type: 'field',
      ...(state.scope.length ? { inboundTag: [...state.scope] } : {}),
      ...target(category),
      ...fields,
    })
    const other: RoutingRule[] = [],
      domains: string[] = [],
      ips: string[] = []
    if (category === 'block') {
      if (flags.ads) domains.push(...ADS)
      if (flags.udp) other.push(make({ network: 'udp', port: ports(group.udpPorts || UDP_PORTS) }))
      // Keep the port/network restriction attached to the IP condition. The
      // reference's generic IP merge loses conditions when combined with GeoIP.
      if (flags.quic) other.push(make({ network: 'udp', port: '443', ip: [QUIC_IP] }))
    }
    if (category === 'vpn') {
      if (flags.blocked) domains.push(...BLOCKED)
      if (flags.discord) {
        if (!split(group.udpPorts).includes(DISCORD_PORTS)) other.push(make({ network: 'udp', port: DISCORD_PORTS }))
        ips.push(...discordNetworks, DISCORD_IP)
      }
    }
    if (category === 'direct') {
      if (flags.local) ips.push(...LOCAL)
      if (flags.torrent) other.push(make({ protocol: ['bittorrent'] }))
    }
    if (group.tcpPorts.trim()) other.push(make({ network: 'tcp', port: ports(group.tcpPorts) }))
    if (group.udpPorts.trim() && !(category === 'block' && flags.udp)) other.push(make({ network: 'udp', port: ports(group.udpPorts) }))
    for (const value of split(group.ipsExact)) {
      if (!validIp(value, false)) throw new Error(`Неверный IP-адрес: ${value}`)
      ips.push(value)
    }
    for (const value of split(group.ipsCidr)) {
      if (!validIp(value, true)) throw new Error(`Неверная подсеть: ${value}`)
      ips.push(value)
    }
    domains.push(
      ...parseRegexes(group.regex),
      ...split(group.partial),
      ...split(group.sub).map((v) => domain(v, 'domain:')),
      ...split(group.exact).map((v) => domain(v, 'full:'))
    )
    for (const value of group.geo) {
      const validated = geoRule(value)
      ;(geoIsIp(validated) ? ips : domains).push(validated)
    }
    result.push(...other)
    if (domains.length) result.push(make({ domain: unique(domains) }))
    if (ips.length) result.push(make({ ip: unique(ips) }))
  }
  if (state.fallback)
    result.push({
      type: 'field',
      ...(state.scope.length ? { inboundTag: [...state.scope] } : {}),
      ...target(state.fallback),
      network: 'tcp,udp',
    })
  return result
}
export function buildGenerator(content: string, state: Generator, targets: Destination[]) {
  const json = readObject(content),
    originalRouting = json.routing
  const routing =
    originalRouting && typeof originalRouting === 'object' && !Array.isArray(originalRouting) ? { ...(originalRouting as RoutingRule) } : {}
  if (routing.script) throw new Error('routing.script перекрывает правила. Отключите его в основном редакторе перед конструированием.')
  const rules = generateCategories(state, targets)
  if (!STRATEGIES.some((s) => s.value === state.strategy)) throw new Error('Выберите стратегию обработки доменов')
  if (state.strategy) routing.domainStrategy = state.strategy
  else delete routing.domainStrategy
  routing.rules = rules
  return { content: JSON.stringify({ ...json, routing }, null, 2), routing, rules }
}
function addText(group: Group, key: InputKey, values: string[]) {
  group[key] = unique([...split(group[key]), ...values]).join('\n')
}
export function loadGenerator(content: string, configs: Config[]): { state: Generator; targets: Destination[] } {
  const source = readObject(content),
    targets = destinations(configs)
  const routing = source.routing as { rules?: RoutingRule[]; domainStrategy?: string } | undefined
  const rules = Array.isArray(routing?.rules) ? routing.rules : []
  const bindings: Generator['bindings'] = {
    block: targets.find((t) => t.protocol === 'blackhole')?.value ?? '',
    direct: targets.find((t) => t.protocol === 'freedom')?.value ?? '',
    vpn: '',
  }
  const proxyTargets = targets.filter(
    (t) => t.kind === 'balancerTag' || !['freedom', 'blackhole', 'dns', 'loopback'].includes(t.protocol ?? '')
  )
  const firstProxyRule = rules.find((r) => proxyTargets.some((t) => t.tag === (r.outboundTag ?? r.balancerTag)))
  bindings.vpn =
    proxyTargets.find((t) => t.tag === (firstProxyRule?.outboundTag ?? firstProxyRule?.balancerTag))?.value ?? proxyTargets[0]?.value ?? ''
  const apiTags = new Set(
    configs
      .filter((c) => !isPoolConfig(c.file))
      .flatMap((c) => {
        try {
          const api = readObject(c.content ?? '').api as { tag?: string } | undefined
          return api?.tag ? [api.tag] : []
        } catch {
          return []
        }
      })
  )
  const localApi = source.api as { tag?: string } | undefined
  if (localApi?.tag) apiTags.add(localApi.tag)
  const inbound = configs
    .filter((c) => !isPoolConfig(c.file))
    .flatMap((c) => {
      try {
        const inputs = readObject(c.content ?? '').inbounds
        return Array.isArray(inputs)
          ? inputs.map((i) => i.tag).filter((tag): tag is string => typeof tag === 'string' && !apiTags.has(tag))
          : []
      } catch {
        return []
      }
    })
  const transparent = inbound.filter((tag) => tag === 'tproxy' || tag === 'redirect')
  const scopedRule = rules.find((r) => Array.isArray(r.inboundTag) && !apiTags.has(r.outboundTag as string))
  const scope = scopedRule ? (scopedRule.inboundTag as string[]) : transparent
  const state = emptyGenerator(bindings, scope)
  state.strategy = routing?.domainStrategy ?? ''
  const encountered: Category[] = []
  for (const rule of rules) {
    if (apiTags.has(rule.outboundTag as string)) {
      state.apiRules.push(rule)
      continue
    }
    const category = (Object.keys(bindings) as Category[]).find((c) => {
      const t = targets.find((t) => t.value === bindings[c])
      return t && rule[t.kind] === t.tag
    })
    const validScope = JSON.stringify(rule.inboundTag ?? []) === JSON.stringify(scope)
    const knownKeys = ['type', 'inboundTag', 'outboundTag', 'balancerTag', 'domain', 'ip', 'network', 'port', 'protocol']
    const conditions = ['domain', 'ip', 'port', 'protocol'].filter((key) => rule[key] !== undefined)
    if (
      category === 'block' &&
      validScope &&
      Object.keys(rule).every((key) => knownKeys.includes(key)) &&
      rule.network === 'udp' &&
      rule.port === '443' &&
      JSON.stringify(rule.ip) === JSON.stringify([QUIC_IP])
    ) {
      state.groups.block.flags.quic = true
      if (!encountered.includes('block')) encountered.push('block')
      continue
    }
    if (
      !category ||
      !validScope ||
      Object.keys(rule).some((key) => !knownKeys.includes(key)) ||
      conditions.length > 1 ||
      (rule.network && !['tcp', 'udp', 'tcp,udp', 'udp,tcp'].includes(String(rule.network)))
    ) {
      state.retained.push(rule)
      continue
    }
    const group = state.groups[category]
    if (!encountered.includes(category)) encountered.push(category)
    if (!conditions.length && ['tcp,udp', 'udp,tcp'].includes(String(rule.network)) && rule === rules.at(-1)) {
      state.fallback = category
      continue
    }
    if (conditions[0] === 'port' && ['tcp', 'udp'].includes(String(rule.network))) {
      addText(group, rule.network === 'tcp' ? 'tcpPorts' : 'udpPorts', [String(rule.port)])
      continue
    }
    if (rule.network) {
      state.retained.push(rule)
      continue
    }
    if (Array.isArray(rule.domain)) {
      for (const value of rule.domain as string[]) {
        if (value.startsWith('regexp:')) group.regex += (group.regex ? '\n' : '') + value
        else if (value.startsWith('domain:')) addText(group, 'sub', [value])
        else if (value.startsWith('full:')) addText(group, 'exact', [value])
        else if (/^(?:geosite:|ext(?:-domain|-site)?:)/.test(value)) group.geo.push(value)
        else addText(group, 'partial', [value])
      }
      continue
    }
    if (Array.isArray(rule.ip)) {
      for (const value of rule.ip as string[]) {
        if (/^(?:geoip:|ext(?:-ip)?:)/.test(value)) group.geo.push(value)
        else addText(group, value.includes('/') ? 'ipsCidr' : 'ipsExact', [value])
      }
      continue
    }
    if (Array.isArray(rule.protocol) && JSON.stringify(rule.protocol) === '["bittorrent"]' && category === 'direct') {
      group.flags.torrent = true
      continue
    }
    state.retained.push(rule)
  }
  const block = state.groups.block,
    vpn = state.groups.vpn,
    direct = state.groups.direct
  if (ADS.every((value) => block.geo.includes(value) || split(block.partial).includes(value))) {
    block.flags.ads = true
    block.partial = split(block.partial)
      .filter((v) => !ADS.includes(v))
      .join('\n')
  }
  if (BLOCKED.every((value) => vpn.geo.includes(value))) vpn.flags.blocked = true
  if (block.udpPorts.replace(/\s/g, '') === UDP_PORTS) block.flags.udp = true
  if (vpn.geo.includes(DISCORD_IP) && split(vpn.udpPorts).includes(DISCORD_PORTS)) vpn.flags.discord = true
  if (LOCAL.every((value) => split(direct.ipsCidr).includes(value))) {
    direct.flags.local = true
    direct.ipsCidr = split(direct.ipsCidr)
      .filter((v) => !LOCAL.includes(v))
      .join('\n')
  }
  // A category occurring in several separated runs cannot be regrouped safely.
  const runs = rules
    .filter((r) => !apiTags.has(r.outboundTag as string))
    .map((r) =>
      (Object.keys(bindings) as Category[]).find((c) => {
        const t = targets.find((t) => t.value === bindings[c])
        return t && r[t.kind] === t.tag
      })
    )
    .filter(Boolean)
  const compressed = runs.filter((c, i) => c !== runs[i - 1])
  const withoutFallback = state.fallback && compressed.at(-1) === state.fallback ? compressed.slice(0, -1) : compressed
  if (state.retained.length || new Set(withoutFallback).size !== withoutFallback.length) {
    state.retained = rules.filter((r) => !apiTags.has(r.outboundTag as string))
    state.groups = { block: emptyGroup(), vpn: emptyGroup(), direct: emptyGroup() }
    state.fallback = ''
  }
  state.order = unique([...encountered, ...state.order]) as Category[]
  return { state, targets }
}
