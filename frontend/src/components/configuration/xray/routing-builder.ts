import type { Config } from '@/lib/types'
import { parse, type ParseError } from 'jsonc-parser'

export type Destination = { value: string; label: string; kind: 'outboundTag' | 'balancerTag'; tag: string; protocol?: string }
export type Condition = 'domain' | 'ip' | 'port' | 'protocol' | 'sourceIP' | 'all'
export type DraftRule = {
  id: string
  condition: Condition
  values: string
  network: string
  target: string
  extra?: RoutingRule
  extraInputs?: Record<string, string>
  original?: { rule: RoutingRule; condition: Condition; values: string; network: string; target: string }
}
export const IMPLICIT_DEFAULT = '__implicit_default__'
export const isPoolConfig = (file: string) => /(?:^|\/)(07_pool|zz-xkeen-ui-servers-tail)\.json$/.test(file)

export type RoutingRule = Record<string, unknown>
export const CONDITIONS: Record<Condition, string> = {
  domain: 'Домены / GeoSite',
  ip: 'IP / подсети / GeoIP',
  port: 'Порты назначения',
  protocol: 'Протокол приложения',
  sourceIP: 'IP устройства в локальной сети',
  all: 'Любое подключение / дополнительные условия',
}
export const STRATEGIES: Record<string, string> = {
  AsIs: 'По имени домена, без DNS для правил IP',
  IPIfNonMatch: 'Сначала домены; если совпадений нет — проверить IP через DNS',
  IPOnDemand: 'Проверять IP через DNS при встрече правила IP',
}
export function readObject(content: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const value = parse(content, errors, { allowTrailingComma: true })
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Исправьте JSON файла перед открытием конструктора')
  return value
}
export function destinations(configs: Config[]): Destination[] {
  const result = new Map<string, Destination>()
  for (const config of configs) {
    if (isPoolConfig(config.file)) continue
    let json: Record<string, unknown>
    try {
      json = readObject(config.content ?? '')
    } catch {
      continue
    }
    if (Array.isArray(json.outbounds))
      for (const outbound of json.outbounds) {
        if (!outbound || typeof outbound.tag !== 'string' || !outbound.tag || typeof outbound.protocol !== 'string') continue
        const tag = outbound.tag
        const protocol = outbound.protocol
        result.set(`outboundTag:${tag}`, {
          value: `outboundTag:${tag}`,
          tag,
          kind: 'outboundTag',
          protocol,
          label: `${protocol === 'freedom' ? 'Напрямую' : protocol === 'blackhole' ? 'Блокировать' : 'Через прокси'} · ${tag}`,
        })
      }
    const routing = json.routing as { balancers?: { tag?: string }[] } | undefined
    if (Array.isArray(routing?.balancers))
      for (const balancer of routing.balancers)
        if (balancer.tag) {
          const tag = balancer.tag
          result.set(`balancerTag:${tag}`, { value: `balancerTag:${tag}`, tag, kind: 'balancerTag', label: `Балансировщик · ${tag}` })
        }
  }
  return [...result.values()]
}
const splitValues = (value: string) => [
  ...new Set(
    value
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  ),
]
function valuesFor(rule: DraftRule): string[] {
  // Regexp may contain commas (quantifiers); one expression per line is unambiguous.
  const values =
    rule.condition === 'domain'
      ? [
          ...new Set(
            rule.values
              .split('\n')
              .flatMap((line) => (line.trim().startsWith('regexp:') ? [line.trim()] : splitValues(line)))
              .filter(Boolean)
          ),
        ]
      : splitValues(rule.values)
  if (!values.length) throw new Error('Заполните условие каждого правила или удалите пустое правило')
  if (rule.condition === 'domain')
    return values.map((value) => {
      if (/^(domain|full|keyword|regexp|geosite|ext|ext-domain|ext-site):\S/.test(value)) return value
      if (/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(value) && !value.includes('..')) return `domain:${value.toLowerCase()}`
      throw new Error(`Некорректный домен: ${value}. Укажите имя без https:// и пути`)
    })
  if (rule.condition === 'port')
    for (const value of values) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(value)
      const a = Number(m?.[1]),
        b = Number(m?.[2] ?? m?.[1])
      if (!m || a < 1 || b > 65535 || a > b) throw new Error(`Некорректный порт или диапазон: ${value}`)
    }
  if (rule.condition === 'protocol' && values.some((v) => !['http', 'tls', 'quic', 'bittorrent'].includes(v)))
    throw new Error('Протоколы: http, tls, quic, bittorrent')
  return values
}
export function generateRouting(
  content: string,
  draft: DraftRule[],
  fallback: string,
  strategy: string,
  targets: Destination[],
  apiTags: string[] = [],
  fallbackTemplate?: RoutingRule
) {
  const json = readObject(content)
  const routing =
    json.routing && typeof json.routing === 'object' && !Array.isArray(json.routing) ? (json.routing as Record<string, unknown>) : {}
  if (routing.script)
    throw new Error('В файле используется routing.script. Сначала отключите скрипт, чтобы он не перекрывал правила конструктора')
  if (!STRATEGIES[strategy]) throw new Error('Выберите стратегию обработки доменов')
  const targetRule = (value: string) => {
    const target = targets.find((t) => t.value === value)
    if (!target) throw new Error('Выберите существующее подключение для каждого правила и остального трафика')
    return { [target.kind]: target.tag }
  }
  // Preserve API control-plane rules, otherwise a final catch-all would intercept them.
  const existing = Array.isArray(routing.rules) ? (routing.rules as RoutingRule[]) : []
  const protectedTags = new Set([...apiTags, (json.api as { tag?: string } | undefined)?.tag].filter(Boolean))
  const apiRules = existing.filter((r) => typeof r.outboundTag === 'string' && protectedTags.has(r.outboundTag))
  const rules: RoutingRule[] = [
    ...apiRules,
    ...draft.map((rule) => {
      const original = rule.original
      if (
        original &&
        rule.condition === original.condition &&
        rule.values === original.values &&
        rule.network === original.network &&
        rule.target === original.target &&
        !Object.keys(rule.extraInputs ?? {}).length
      ) {
        return structuredClone(original.rule)
      }
      const extra = { ...rule.extra }
      for (const [key, input] of Object.entries(rule.extraInputs ?? {})) {
        if (!input.trim()) {
          delete extra[key]
          continue
        }
        const values = valuesFor({ ...rule, condition: key as Condition, values: input })
        extra[key] = key === 'port' ? values.join(',') : values
      }
      const unchangedValues = original && rule.condition === original.condition && rule.values === original.values
      const values = rule.condition === 'all' || unchangedValues ? [] : valuesFor(rule)
      const primary =
        rule.condition === 'all'
          ? {}
          : {
              [rule.condition]: unchangedValues ? original.rule[rule.condition] : rule.condition === 'port' ? values.join(',') : values,
            }
      return { ...extra, type: 'field', ...primary, ...(rule.network ? { network: rule.network } : {}), ...targetRule(rule.target) }
    }),
    ...(fallback === IMPLICIT_DEFAULT
      ? []
      : [
          {
            ...Object.fromEntries(Object.entries(fallbackTemplate ?? {}).filter(([key]) => !['outboundTag', 'balancerTag'].includes(key))),
            type: 'field',
            network: fallbackTemplate?.network ?? 'tcp,udp',
            ...targetRule(fallback),
          },
        ]),
  ]

  const next = { ...routing, ...(strategy !== 'AsIs' || routing.domainStrategy ? { domainStrategy: strategy } : {}), rules }
  return {
    content: JSON.stringify({ ...json, routing: next }, null, 2),
    routing: next,
    rules,
    replaced: existing.length - apiRules.length,
    preserved: apiRules.length,
  }
}
export function describeRule(rule: RoutingRule): string {
  const parts: string[] = []
  for (const [key, name] of Object.entries(CONDITIONS))
    if (rule[key]) parts.push(`${name}: ${Array.isArray(rule[key]) ? rule[key].join(', ') : rule[key]}`)
  if (rule.inboundTag) parts.push(`Вход: ${String(rule.inboundTag)}`)
  if (rule.network && rule.network !== 'tcp,udp') parts.push(`Транспорт: ${String(rule.network).toUpperCase()}`)
  return parts.join(' И ') || 'Весь остальной TCP/UDP трафик'
}

export function readRoutingDraft(content: string, apiTags: string[] = []) {
  const json = readObject(content)
  const routing = json.routing as { rules?: RoutingRule[]; domainStrategy?: string } | undefined
  const protectedTags = new Set([...apiTags, (json.api as { tag?: string } | undefined)?.tag].filter(Boolean))
  const rules = Array.isArray(routing?.rules) ? routing.rules.filter((r) => !protectedTags.has(r.outboundTag as string)) : []
  let fallback = IMPLICIT_DEFAULT
  let fallbackTemplate: RoutingRule | undefined
  const last = rules.at(-1)
  const destination = (r: RoutingRule) => (r.balancerTag ? `balancerTag:${r.balancerTag}` : `outboundTag:${r.outboundTag ?? ''}`)
  if (
    last &&
    typeof last.network === 'string' &&
    last.network
      .split(',')
      .map((v) => v.trim())
      .sort()
      .join(',') === 'tcp,udp' &&
    Object.keys(last).every((key) => ['type', 'ruleTag', 'network', 'outboundTag', 'balancerTag'].includes(key))
  ) {
    fallback = destination(last)
    fallbackTemplate = rules.pop()
  }
  const draft = rules.map((rule, index): DraftRule => {
    const condition = (Object.keys(CONDITIONS).find((key) => key !== 'all' && rule[key] !== undefined) ?? 'all') as Condition
    const value = rule[condition]
    const values = value === undefined ? '' : Array.isArray(value) ? value.join('\n') : String(value)
    const network = typeof rule.network === 'string' ? rule.network : ''
    const target = destination(rule)
    const extra = Object.fromEntries(
      Object.entries(rule).filter(([key]) => ![condition, 'network', 'outboundTag', 'balancerTag'].includes(key))
    )
    return {
      id: `existing-${index}`,
      condition,
      values,
      network,
      target,
      extra,
      original: { rule: structuredClone(rule), condition, values, network, target },
    }
  })
  return { draft, fallback, fallbackTemplate, strategy: routing?.domainStrategy ?? 'AsIs' }
}
