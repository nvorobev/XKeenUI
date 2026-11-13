import { ResultRow, type RouteTestRunResponse } from '@/components/modals/RouteTester'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { apiCall } from '@/lib/api'
import { useAppActions } from '@/lib/store'
import type { Config } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  IconArrowDown,
  IconArrowUp,
  IconBan,
  IconBolt,
  IconCode,
  IconCopy,
  IconDownload,
  IconFileCode,
  IconLock,
  IconMap,
  IconSettings,
  IconShield,
  IconTable,
  IconTrash,
  IconWorld,
} from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ProviderEditor } from '../editor/ProviderEditor'
import { isPoolConfig, readObject, type Destination, type RoutingRule } from './routing-builder'
import {
  ADS,
  BASES,
  BLOCKED,
  DISCORD_IP,
  GEO_CATALOG,
  STRATEGIES,
  TITLES,
  applyPreset,
  buildGenerator,
  emptyGenerator,
  geoIsIp,
  loadGenerator,
  normalizeGeo,
  setFlag,
  type Category,
  type Flag,
  type Generator,
  type Group,
  type InputKey,
  type Preset,
} from './routing-generator'
import { RoutingMap } from './RoutingMap'
import type { Snapshot } from './servers/model'

function GeoField({
  id,
  label,
  value,
  kind,
  onChange,
  placeholder,
  help,
}: {
  id: string
  label: string
  value: string[]
  kind: 'ip' | 'site' | 'all'
  onChange: (value: string[]) => void
  placeholder?: string
  help?: string
}) {
  const external = value.join('\n')
  const [draft, setDraft] = useState({ external, text: external })
  if (external !== draft.external) setDraft({ external, text: external })

  return (
    <TextField
      id={id}
      label={label}
      value={draft.text}
      placeholder={placeholder}
      help={help}
      onChange={(raw) => {
        const next =
          kind === 'all'
            ? raw
                .split(/[,\n]+/)
                .map((v) => v.trim())
                .filter(Boolean)
            : normalizeGeo(raw, kind)
        setDraft({ external: next.join('\n'), text: raw })
        onChange(next)
      }}
    />
  )
}

type GeoStatus = { loading?: boolean; error?: string; categories?: string[] }
type GeoReply = { success: boolean; error?: string; site_files?: string[]; ip_files?: string[]; categories?: string[] }
const PRESETS = [
  { value: 'full-vpn', label: 'Весь трафик через VPN', icon: IconWorld },
  { value: 'except-ru', label: 'VPN кроме РФ', icon: IconWorld },
  { value: 'blocked-only', label: 'Только заблокированные', icon: IconLock },
] as const
const ICONS = { block: IconBan, vpn: IconShield, direct: IconWorld }
const FLAGS: Record<Category, { key: Flag; label: string }[]> = {
  block: [
    { key: 'ads', label: 'Блокировать рекламу' },
    { key: 'udp', label: 'Блокировать уязвимые UDP порты' },
    { key: 'quic', label: 'Блокировать QUIC/HTTP3' },
  ],
  vpn: [
    { key: 'blocked', label: 'Заблокированные сайты' },
    { key: 'discord', label: 'Discord' },
  ],
  direct: [
    { key: 'local', label: 'Локальные сети' },
    { key: 'torrent', label: 'Торренты' },
  ],
}
const CATCH = {
  block: ['Блокировать остальное', 'Применить блокировку ко всему трафику, не подпадающему под другие правила'],
  vpn: ['Всё через VPN', 'Отправлять через VPN весь трафик, не подпадающий под другие правила'],
  direct: ['Всё напрямую', 'Отправлять напрямую весь трафик, не подпадающий под другие правила'],
}
function Choice({
  label,
  value,
  items,
  onChange,
}: {
  label: string
  value: string
  items: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} items={items} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}
function Check({
  id,
  label,
  checked,
  description,
  disabled,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  description?: string
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <Field orientation="horizontal" data-disabled={disabled}>
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <div className="flex min-w-0 flex-col gap-1">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
      </div>
    </Field>
  )
}
function TextField({
  id,
  label,
  value,
  placeholder,
  help,
  onChange,
}: {
  id: string
  label: string
  value: string
  placeholder?: string
  help?: string
  onChange: (value: string) => void
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea id={id} rows={2} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {help && <FieldDescription>{help}</FieldDescription>}
    </Field>
  )
}
function Section({ title, icon: Icon, children }: { title: string; icon: typeof IconWorld; children: React.ReactNode }) {
  return (
    <section className="bg-card flex flex-col gap-5 rounded-xl border p-5 shadow-sm">
      <h3 className="flex items-center gap-3 text-base font-semibold">
        <Icon className="size-5 shrink-0" />
        {title}
      </h3>
      {children}
    </section>
  )
}
export function CategoryControls({
  category,
  state,
  targets,
  base,
  geoStatus,
  onBase,
  onChange,
}: {
  category: Category
  state: Generator
  targets: Destination[]
  base: string
  geoStatus: Record<string, GeoStatus>
  onBase: (base: string) => void
  onChange: (state: Generator) => void
}) {
  const group = state.groups[category],
    title = TITLES[category]
  const patch = (value: Partial<Group>) => {
    const next = { ...group, ...value }
    if (value.geo)
      next.flags = {
        ...next.flags,
        ads: !!next.flags.ads && value.geo.includes(ADS[0]),
        blocked: !!next.flags.blocked && BLOCKED.every((entry) => value.geo!.includes(entry)),
        discord: !!next.flags.discord && value.geo.includes(DISCORD_IP),
      }
    onChange({ ...state, groups: { ...state.groups, [category]: next } })
  }
  const field = (key: InputKey, label: string, placeholder: string, help: string) => (
    <TextField
      key={key}
      id={`${category}-${key}`}
      label={label}
      value={group[key]}
      placeholder={placeholder}
      help={help}
      onChange={(value) => patch({ [key]: value })}
    />
  )
  const groups = GEO_CATALOG[base as keyof typeof GEO_CATALOG] ?? []
  const target = targets.find((t) => t.value === state.bindings[category])
  const categoryTargets = targets.filter((t) =>
    category === 'block'
      ? t.protocol === 'blackhole'
      : category === 'direct'
        ? t.protocol === 'freedom'
        : t.kind === 'balancerTag' || !['freedom', 'blackhole', 'dns', 'loopback'].includes(t.protocol ?? '')
  )
  function unavailable(value: string) {
    const match = /^ext:([^:]+):!?(.+)$/.exec(value)
    if (!match) return ''
    const info = geoStatus[match[1]]
    if (geoStatus.load?.error) return geoStatus.load.error
    if (!info) return geoStatus.ready ? 'База не установлена на роутере' : 'Проверяем базу на роутере…'
    if (info.loading) return 'Проверяем базу на роутере…'
    if (info.error) return info.error
    if (!info.categories?.some((tag) => tag.toLowerCase() === match[2].toLowerCase())) return 'Категории нет в установленной базе'
    return ''
  }
  return (
    <Section title={title} icon={ICONS[category]}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant={category === 'block' ? 'destructive' : category === 'vpn' ? 'sky' : 'emerald'}>{title}</Badge>
        <span className="text-muted-foreground text-xs">{target?.tag ?? 'Выберите подключение'}</span>
      </div>
      {FLAGS[category].map((flag) => (
        <Check
          key={flag.key}
          id={`${category}-${flag.key}`}
          label={flag.label}
          checked={!!group.flags[flag.key]}
          onChange={(enabled) => onChange(setFlag(state, category, flag.key, enabled))}
        />
      ))}
      <Accordion type="single" collapsible>
        <AccordionItem value="ports">
          <AccordionTrigger>
            Порты для {category === 'block' ? 'блокировки' : category === 'vpn' ? 'VPN' : 'прямого подключения'}
          </AccordionTrigger>
          <AccordionContent>
            <FieldGroup>
              {field(
                'tcpPorts',
                'TCP порты',
                category === 'direct' ? 'Например: 22,3389,5900,8080-8090' : 'Например: 80,443,1000-2000',
                'Укажите TCP порты через запятую или диапазоном'
              )}
              {field(
                'udpPorts',
                'UDP порты',
                category === 'block' ? 'Например: 53,123,137-139' : 'Например: 443,1194,3478-3479',
                category === 'block' ? 'По умолчанию блокируются порты 135,137,138,139' : 'Укажите UDP порты через запятую или диапазоном'
              )}
            </FieldGroup>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="ips">
          <AccordionTrigger>
            IP адреса для {category === 'block' ? 'блокировки' : category === 'vpn' ? 'VPN' : 'прямого подключения'}
          </AccordionTrigger>
          <AccordionContent>
            <FieldGroup>
              {field(
                'ipsExact',
                'Точное совпадение',
                category === 'direct' ? 'Например: 192.168.1.1,10.0.0.1' : 'Например: 8.8.8.8,1.1.1.1',
                'Укажите конкретные IPv4 или IPv6 адреса через запятую'
              )}
              {field('ipsCidr', 'CIDR диапазоны', 'Например: 192.168.0.0/16,10.0.0.0/8', 'Укажите диапазоны IP адресов в формате CIDR')}
            </FieldGroup>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="domains">
          <AccordionTrigger>
            Домены для {category === 'block' ? 'блокировки' : category === 'vpn' ? 'VPN' : 'прямого подключения'}
          </AccordionTrigger>
          <AccordionContent>
            <FieldGroup>
              {field(
                'partial',
                'Частичное совпадение',
                category === 'block' ? 'Например: ad,tracker,analytics' : 'Например: google,facebook,netflix',
                'Совпадение с любой частью доменного имени'
              )}
              {field(
                'sub',
                'Поддомены',
                'Например: domain:example.com,domain:youtube.com',
                'Домен и все его поддомены. Префикс domain: добавляется автоматически'
              )}
              {field(
                'exact',
                'Точное совпадение',
                'Например: full:example.com,full:localhost',
                'Только указанный домен. Префикс full: добавляется автоматически'
              )}
              {field(
                'regex',
                'Регулярное выражение',
                'Например: regexp:^ads\\..+$',
                'Правила regexp:. Можно вводить по одному на строку; выражения проверяются Xray перед применением'
              )}
            </FieldGroup>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="geo">
          <AccordionTrigger>GeoIP/GeoSite</AccordionTrigger>
          <AccordionContent>
            <FieldGroup>
              <Choice label="База данных" value={base} items={[{ value: '', label: 'Выберите базу данных' }, ...BASES]} onChange={onBase} />
              <FieldDescription>Выберите базу данных для загрузки правил</FieldDescription>
              {groups.map((geoGroup) => (
                <fieldset key={geoGroup.name} className="flex flex-col gap-3 rounded-lg border p-3">
                  <legend className="px-1 font-medium">{geoGroup.name}</legend>
                  {geoGroup.items.map((item) => {
                    const reason = unavailable(item.value)
                    return (
                      <Check
                        key={item.value}
                        id={`${category}-geo-${item.value.replace(/[^\w]/g, '-')}`}
                        label={item.text}
                        description={reason || item.description}
                        disabled={!!reason && !group.geo.includes(item.value)}
                        checked={group.geo.includes(item.value)}
                        onChange={(checked) =>
                          patch({ geo: checked ? [...new Set([...group.geo, item.value])] : group.geo.filter((v) => v !== item.value) })
                        }
                      />
                    )
                  })}
                </fieldset>
              ))}
              {base && !groups.length && (
                <FieldDescription>В этой базе образца нет готовых пунктов. Используйте ручной ввод.</FieldDescription>
              )}
              <GeoField
                id={`${category}-geo-ip`}
                label="GeoIP (ручной ввод)"
                kind="ip"
                value={group.geo.filter(geoIsIp)}
                placeholder="Например: geoip:ru,geoip:cn"
                help="GeoIP правила с префиксом geoip:"
                onChange={(values) => patch({ geo: [...group.geo.filter((v) => !geoIsIp(v)), ...values] })}
              />
              <GeoField
                id={`${category}-geo-site`}
                label="GeoSite (ручной ввод)"
                kind="site"
                value={group.geo.filter((v) => !geoIsIp(v))}
                placeholder="Например: geosite:category-ads-all"
                help="GeoSite правила с префиксом geosite:"
                onChange={(values) => patch({ geo: [...group.geo.filter(geoIsIp), ...values] })}
              />
              <div className="flex items-start gap-2">
                <GeoField
                  id={`${category}-geo-summary`}
                  label="Выбранные правила"
                  kind="all"
                  value={group.geo}
                  onChange={(geo) => patch({ geo })}
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={`Очистить правила ${title}`}
                  onClick={() => patch({ geo: [], flags: { ...group.flags, ads: false, blocked: false, discord: false } })}
                >
                  <IconTrash />
                </Button>
              </div>
            </FieldGroup>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <Check
        id={`${category}-catchAll`}
        label={CATCH[category][0]}
        description={CATCH[category][1]}
        checked={state.fallback === category}
        onChange={(checked) => onChange({ ...state, fallback: checked ? category : '' })}
      />
      {categoryTargets.length !== 1 && (
        <Choice
          label="Выходное подключение"
          value={state.bindings[category]}
          items={categoryTargets.map((t) => ({ value: t.value, label: t.label }))}
          onChange={(value) => onChange({ ...state, bindings: { ...state.bindings, [category]: value } })}
        />
      )}
    </Section>
  )
}
export function RoutingConstructor({
  configs,
  file,
  content,
  onTransfer,
  onApply,
  onClose,
}: {
  configs: Config[]
  file: string
  content: string
  onTransfer: (content: string) => void
  onApply?: (content: string) => Promise<boolean>
  onClose: () => void
}) {
  const { showToast } = useAppActions()
  const [initial] = useState(() =>
    loadGenerator(
      content,
      configs.map((c) => (c.file === file ? { ...c, content } : c))
    )
  )
  const [state, setState] = useState(initial.state),
    [edited, setEdited] = useState(false),
    [preset, setPreset] = useState(''),
    [orderSelection, setOrderSelection] = useState<Category>('block')
  const [bases, setBases] = useState<Record<Category, string>>({ block: '', vpn: '', direct: '' }),
    [geoStatus, setGeoStatus] = useState<Record<string, GeoStatus>>({}),
    [geoReload, setGeoReload] = useState(0)
  const [applying, setApplying] = useState(false),
    [tab, setTab] = useState('map'),
    [showOriginal, setShowOriginal] = useState(false)
  const [query, setQuery] = useState(''),
    [port, setPort] = useState('443'),
    [network, setNetwork] = useState('tcp'),
    [inbound, setInbound] = useState(initial.state.scope[0] ?? ''),
    [running, setRunning] = useState(false)
  const [testResult, setTestResult] = useState<{ key: string; data: RouteTestRunResponse } | null>(null),
    [expanded, setExpanded] = useState(false)
  const busy = useRef(false),
    mounted = useRef(true)
  const poolActive = configs.some((c) => isPoolConfig(c.file))
  const [poolSnapshot, setPoolSnapshot] = useState<Snapshot | null>(null)
  useEffect(() => {
    if (!poolActive) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try {
        const snapshot = await apiCall<Snapshot>('GET', 'xray/servers', undefined, { timeoutMs: 15000 })
        if (alive && snapshot.success) setPoolSnapshot(snapshot)
      } catch {
        /* Optional diagram metadata; the routing preview remains available. */
      } finally {
        if (alive) timer = setTimeout(() => void refresh(), 15000)
      }
    }
    void refresh()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [poolActive])
  const pool = poolSnapshot?.settings
    ? {
        targetTag: poolSnapshot.settings.target_tag,
        auto: poolSnapshot.settings.auto,
        selectedName: poolSnapshot.servers.find((server) => server.id === poolSnapshot.settings?.selected_id)?.name,
      }
    : undefined
  const shadowing = configs.find((c) => {
    if (isPoolConfig(c.file) || c.file <= file || c.file.slice(0, c.file.lastIndexOf('/')) !== file.slice(0, file.lastIndexOf('/')))
      return false
    try {
      return readObject(c.content ?? '').routing != null
    } catch {
      return false
    }
  })
  const built = useMemo(() => {
    try {
      return { value: buildGenerator(content, state, initial.targets), error: '' }
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : 'Ошибка построения конфигурации' }
    }
  }, [content, state, initial.targets])
  const generated = built.value,
    previewContent = !edited || showOriginal ? content : (generated?.content ?? content)
  const previewRouting = readObject(previewContent).routing as { rules?: RoutingRule[]; domainStrategy?: string } | undefined
  const previewRules = Array.isArray(previewRouting?.rules) ? previewRouting.rules : []
  const dependencyErrors = [
    ...new Set(
      (generated?.rules ?? []).flatMap((rule) =>
        ['domain', 'ip'].flatMap((key) => {
          const values = Array.isArray(rule[key]) ? (rule[key] as string[]) : []
          return values.flatMap((value) => {
            const ext = /^ext(?:-ip|-domain|-site)?:([^:]+):!?([^@]+)(?:@.*)?$/.exec(value)
            const standard = /^(geoip|geosite):!?([^@]+)(?:@.*)?$/.exec(value)
            if (!ext && !standard) return []
            const file = ext?.[1] ?? `${standard![1]}.dat`,
              tag = ext?.[2] ?? standard![2],
              info = geoStatus[file]
            if (geoStatus.load?.error) return [geoStatus.load.error]
            if (!info) return [geoStatus.ready ? `${file}: база не установлена на роутере` : `Проверяем базу ${file}…`]
            if (info.loading) return [`Проверяем базу ${file}…`]
            if (info.error) return [`${file}: ${info.error}`]
            return info.categories?.some((code) => code.toLowerCase() === tag.toLowerCase()) ? [] : [`${file}: нет категории ${tag}`]
          })
        })
      )
    ),
  ]
  const testKey = JSON.stringify([previewContent, query, port, network, inbound]),
    shown = testResult?.key === testKey ? testResult.data : null
  const change = (next: Generator) => {
    setState(next)
    setEdited(true)
    setPreset('')
  }
  useEffect(() => {
    mounted.current = true
    setGeoStatus({})
    void apiCall<GeoReply>('GET', 'geo')
      .then((reply) => {
        if (!mounted.current) return
        if (!reply.success) throw Error(reply.error || 'Не удалось прочитать базы')
        const files = [...(reply.site_files ?? []), ...(reply.ip_files ?? [])]
        const required = [
          ...new Set([
            ...files,
            'geosite_v2fly.dat',
            'geoip_v2fly.dat',
            'geosite_zkeen.dat',
            'geoip_zkeenip.dat',
            'geosite_antifilter.dat',
          ]),
        ]
        setGeoStatus(
          Object.fromEntries([
            ['ready', {}],
            ...required.map((name) => [name, files.includes(name) ? { loading: true } : { error: 'База не установлена на роутере' }]),
          ])
        )
        return Promise.allSettled(
          required
            .filter((name) => files.includes(name))
            .map(async (name) => {
              try {
                const data = await apiCall<GeoReply>(
                  'GET',
                  `geo/${name.startsWith('geoip') ? 'ip' : 'site'}?file=${encodeURIComponent(name)}&all=true`
                )
                if (!data.success) throw Error(data.error || 'Ошибка чтения базы')
                if (mounted.current) setGeoStatus((prev) => ({ ...prev, [name]: { categories: data.categories ?? [] } }))
              } catch (error) {
                if (mounted.current)
                  setGeoStatus((prev) => ({ ...prev, [name]: { error: error instanceof Error ? error.message : 'Ошибка чтения базы' } }))
              }
            })
        )
      })
      .catch((error) => {
        if (mounted.current) setGeoStatus({ load: { error: String(error) } })
      })
    return () => {
      mounted.current = false
    }
  }, [geoReload])
  async function copy() {
    if (!generated) return
    try {
      await navigator.clipboard.writeText(JSON.stringify({ routing: generated.routing }, null, 2))
      showToast('Конфигурация скопирована')
    } catch {
      showToast('Не удалось скопировать конфигурацию', 'error')
    }
  }
  function download() {
    if (!generated) return
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ routing: generated.routing }, null, 2) + '\n'], { type: 'application/json' })
    )
    const a = document.createElement('a')
    a.href = url
    a.download = '05_routing.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  function move(delta: number) {
    const index = state.order.indexOf(orderSelection),
      target = index + delta
    if (target < 0 || target >= state.order.length) return
    const order = [...state.order]
    ;[order[index], order[target]] = [order[target], order[index]]
    change({ ...state, order })
  }
  async function test() {
    if (!generated || busy.current || !query.trim() || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return
    busy.current = true
    setRunning(true)
    setTestResult(null)
    try {
      const data = await apiCall<RouteTestRunResponse>('POST', 'route-test', {
        targets: [query.trim()],
        port: Number(port),
        network,
        inboundTag: inbound || null,
        preview: { file, content: previewContent },
      })
      if (!data.success) throw Error(data.error || 'Ошибка проверки')
      setTestResult({ key: testKey, data })
      setExpanded(true)
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Ошибка проверки', 'error')
    } finally {
      busy.current = false
      setRunning(false)
    }
  }
  const stats = previewRules.reduce<Record<Category, number>>(
    (counts, r) => {
      const c = (['block', 'vpn', 'direct'] as Category[]).find((c) => {
        const t = initial.targets.find((t) => t.value === state.bindings[c])
        return t && r[t.kind] === t.tag
      })
      if (c) counts[c]++
      return counts
    },
    { block: 0, vpn: 0, direct: 0 }
  )
  return (
    <Dialog open onOpenChange={(open) => !open && !applying && onClose()}>
      <DialogContent
        showCloseButton={!applying}
        className="flex h-[94dvh] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 p-0 sm:max-w-none"
      >
        <DialogHeader className="border-b px-5 py-3 pr-14">
          <DialogTitle>Конструктор маршрутов Xray</DialogTitle>
          <DialogDescription>Конфигуратор правил маршрутизации для XKeen · {file.split('/').pop()}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:overflow-hidden">
          <div className="bg-muted/20 flex min-h-0 min-w-0 flex-col gap-4 p-4 lg:overflow-y-auto">
            <fieldset disabled={applying} className="contents">
              <Section title="Быстрые настройки" icon={IconBolt}>
                <RadioGroup
                  value={preset}
                  onValueChange={(value) => {
                    setState(applyPreset(state, value as Preset))
                    setPreset(value)
                    setEdited(true)
                  }}
                  className="flex flex-col gap-2"
                >
                  {PRESETS.map((p) => {
                    const Icon = p.icon
                    return (
                      <Field
                        key={p.value}
                        orientation="horizontal"
                        className={cn('rounded-lg border p-3', preset === p.value && 'bg-primary/10 border-primary')}
                      >
                        <RadioGroupItem id={`preset-${p.value}`} value={p.value} />
                        <FieldLabel htmlFor={`preset-${p.value}`} className="flex-1 cursor-pointer">
                          <Icon className="size-4" />
                          {p.label}
                        </FieldLabel>
                      </Field>
                    )
                  })}
                </RadioGroup>
              </Section>
              <Section title="Общие настройки" icon={IconSettings}>
                <Choice
                  label="Стратегия обработки доменов:"
                  value={state.strategy}
                  items={STRATEGIES}
                  onChange={(strategy) => change({ ...state, strategy })}
                />
                <FieldDescription>Определяет стратегию работы с доменами для всей конфигурации</FieldDescription>
                <Field>
                  <FieldLabel htmlFor="generator-category-order">Порядок применения категорий:</FieldLabel>
                  <div className="flex items-start gap-2">
                    <select
                      id="generator-category-order"
                      size={3}
                      value={orderSelection}
                      onChange={(e) => setOrderSelection(e.target.value as Category)}
                      className="bg-input-background w-full rounded-lg border p-2 text-sm"
                    >
                      {state.order.map((c) => (
                        <option key={c} value={c} className="p-2">
                          {TITLES[c]}
                        </option>
                      ))}
                    </select>
                    <div className="flex flex-col gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="Переместить категорию вверх"
                        disabled={state.order.indexOf(orderSelection) === 0}
                        onClick={() => move(-1)}
                      >
                        <IconArrowUp />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="Переместить категорию вниз"
                        disabled={state.order.indexOf(orderSelection) === 2}
                        onClick={() => move(1)}
                      >
                        <IconArrowDown />
                      </Button>
                    </div>
                  </div>
                  <FieldDescription>
                    Выберите категорию и используйте стрелки для изменения порядка. Правила применяются сверху вниз.
                  </FieldDescription>
                </Field>
              </Section>
              {(['block', 'vpn', 'direct'] as Category[]).map((category) => (
                <CategoryControls
                  key={category}
                  category={category}
                  state={state}
                  targets={initial.targets}
                  base={bases[category]}
                  geoStatus={geoStatus}
                  onBase={(base) => setBases((prev) => ({ ...prev, [category]: base }))}
                  onChange={change}
                />
              ))}
              {state.retained.length > 0 && (
                <Alert>
                  <AlertTitle>Дополнительные правила из текущего конфига: {state.retained.length}</AlertTitle>
                  <AlertDescription>
                    Исходные правила со сложными условиями сохранены в прежнем порядке. Новые правила категорий добавляются после них;
                    проверьте приоритет справа в полном конфиге.
                  </AlertDescription>
                </Alert>
              )}
              {poolActive && (
                <p className="text-muted-foreground text-sm">
                  Пул включён. При применении маршруты и 07_pool.json обновляются вместе; выбранный сервер и автопереключение сохраняются.
                </p>
              )}
            </fieldset>
          </div>
          <section
            className="flex min-h-[70dvh] min-w-0 flex-col gap-4 overflow-y-auto border-t p-4 lg:min-h-0 lg:border-t-0 lg:border-l"
            aria-label="Предпросмотр конфигурации"
          >
            <h3 className="flex items-center gap-2 text-lg font-semibold">
              <IconFileCode className="size-5" />
              Предпросмотр конфигурации
            </h3>
            <Tabs
              value={tab}
              onValueChange={setTab}
              className={cn('flex flex-col', tab === 'json' ? 'min-h-80 flex-1 lg:min-h-0' : 'shrink-0')}
            >
              <div className="flex flex-wrap items-center gap-2">
                <TabsList>
                  <TabsTrigger value="map">
                    <IconMap />
                    Карта
                  </TabsTrigger>
                  <TabsTrigger value="json">
                    <IconCode data-icon="inline-start" />
                    JSON
                  </TabsTrigger>
                  <TabsTrigger value="table">
                    <IconTable data-icon="inline-start" />
                    Таблица
                  </TabsTrigger>
                </TabsList>
                <Button variant="outline" onClick={() => void copy()} disabled={!generated}>
                  <IconCopy data-icon="inline-start" />
                  Копировать
                </Button>
                <Button variant="outline" onClick={download} disabled={!generated}>
                  <IconDownload data-icon="inline-start" />
                  Скачать
                </Button>
                <Button
                  variant="outline"
                  disabled={applying}
                  onClick={() => {
                    change({ ...emptyGenerator(state.bindings, state.scope), apiRules: state.apiRules, retained: state.retained })
                    setBases({ block: '', vpn: '', direct: '' })
                  }}
                >
                  Сбросить
                </Button>
              </div>
              <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
                <span>{!edited || showOriginal ? 'Текущий конфиг' : 'Будущий конфиг · черновик'}</span>
                <Button variant="ghost" size="sm" onClick={() => setShowOriginal(!showOriginal)}>
                  {showOriginal ? 'Будущий конфиг' : 'Сравнить с текущим'}
                </Button>
              </div>
              {dependencyErrors.length > 0 && (
                <Alert>
                  <AlertTitle>Проверка баз Xray</AlertTitle>
                  <AlertDescription>{dependencyErrors.join('; ')}. Применение доступно после успешной проверки.</AlertDescription>
                  <Button variant="outline" size="sm" onClick={() => setGeoReload((value) => value + 1)}>
                    Проверить базы заново
                  </Button>
                </Alert>
              )}
              {built.error && (
                <Alert variant="destructive">
                  <AlertDescription>{built.error}</AlertDescription>
                </Alert>
              )}
              {shadowing && (
                <Alert variant="destructive">
                  <AlertDescription>Маршруты перекрываются файлом {shadowing.file}. Откройте конструктор в нём.</AlertDescription>
                </Alert>
              )}
              <TabsContent value="json" className="min-h-80 flex-1 overflow-hidden rounded-lg border lg:min-h-0">
                <ProviderEditor
                  content={previewContent}
                  language="json"
                  readOnly
                  lineWrap
                  onChange={() => {}}
                  onSave={() => {}}
                  onValidationChange={() => {}}
                />
              </TabsContent>
              <TabsContent value="map" className="min-h-0">
                <RoutingMap
                  rules={previewRules}
                  targets={initial.targets}
                  result={shown}
                  poolActive={poolActive}
                  pool={pool}
                  inboundTags={initial.state.scope}
                  domainStrategy={previewRouting?.domainStrategy}
                />
              </TabsContent>
              <TabsContent value="table" className="min-h-0 flex-1 overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {['№', 'Тип', 'Домены', 'IP адреса', 'Порты', 'Сеть', 'Протокол', 'Действие'].map((text) => (
                        <TableHead key={text}>{text}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewRules.map((rule, index) => (
                      <TableRow key={index}>
                        <TableCell>{index + 1}</TableCell>
                        {['type', 'domain', 'ip', 'port', 'network', 'protocol'].map((key) => (
                          <TableCell key={key} className="max-w-72 break-words whitespace-normal">
                            {Array.isArray(rule[key]) ? rule[key].join(', ') : String(rule[key] ?? '-')}
                          </TableCell>
                        ))}
                        <TableCell>
                          {(['block', 'vpn', 'direct'] as Category[]).find((c) => {
                            const t = initial.targets.find((t) => t.value === state.bindings[c])
                            return t && rule[t.kind] === t.tag
                          })
                            ? TITLES[
                                (['block', 'vpn', 'direct'] as Category[]).find((c) => {
                                  const t = initial.targets.find((t) => t.value === state.bindings[c])
                                  return t && rule[t.kind] === t.tag
                                })!
                              ]
                            : String(rule.outboundTag ?? rule.balancerTag ?? '-')}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>
            </Tabs>
            <div className="flex flex-wrap gap-4 rounded-lg border p-3 text-sm">
              <span>Стратегия: {previewRouting?.domainStrategy || 'Выкл'}</span>
              <span>Всего: {previewRules.length}</span>
              {stats &&
                (['block', 'vpn', 'direct'] as Category[]).map((c) => (
                  <span key={c}>
                    {TITLES[c]}: {stats[c]}
                  </span>
                ))}
            </div>
            <Accordion type="single" collapsible>
              <AccordionItem value="test">
                <AccordionTrigger>Проверить, куда пойдёт трафик</AccordionTrigger>
                <AccordionContent>
                  <FieldGroup className="grid gap-3 sm:grid-cols-[1fr_5rem_6rem_auto]">
                    <Field>
                      <FieldLabel htmlFor="generator-query">Домен или IP</FieldLabel>
                      <Input id="generator-query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="example.com" />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="generator-port">Порт</FieldLabel>
                      <Input id="generator-port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
                    </Field>
                    <Choice
                      label="Сеть"
                      value={network}
                      items={[
                        { value: 'tcp', label: 'TCP' },
                        { value: 'udp', label: 'UDP' },
                      ]}
                      onChange={setNetwork}
                    />
                    <Button disabled={!generated || !query.trim() || running} className="self-end" onClick={() => void test()}>
                      {running ? 'Проверяем…' : 'Проверить'}
                    </Button>
                  </FieldGroup>
                  {initial.state.scope.length > 0 && (
                    <Choice
                      label="Вход на роутере"
                      value={inbound}
                      items={[{ value: '', label: 'Не задан' }, ...initial.state.scope.map((value) => ({ value, label: value }))]}
                      onChange={setInbound}
                    />
                  )}
                  {shown && (
                    <div className="mt-3 flex flex-col gap-2">
                      {shown.warnings?.map((warning, i) => (
                        <Alert key={i}>
                          <AlertDescription>{warning}</AlertDescription>
                        </Alert>
                      ))}
                      <ul className="rounded-lg border">
                        {shown.results?.map((result) => (
                          <ResultRow key={result.target} result={result} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
                        ))}
                      </ul>
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
            <p className="text-muted-foreground text-xs">
              Слева — настройки, справа — результат. Рабочие файлы не меняются до сохранения или применения. Срабатывает первое подходящее
              правило сверху вниз.
            </p>
          </section>
        </div>
        <DialogFooter className="flex-wrap border-t p-3">
          <Button variant="outline" disabled={applying} onClick={onClose}>
            Закрыть
          </Button>
          <Button
            variant="outline"
            disabled={!generated || !!shadowing || applying || dependencyErrors.length > 0}
            onClick={() => {
              if (generated) {
                onTransfer(generated.content)
                onClose()
              }
            }}
          >
            Передать в редактор
          </Button>
          {onApply && (
            <Button
              disabled={!generated || !!shadowing || applying || dependencyErrors.length > 0}
              onClick={async () => {
                if (!generated || !onApply) return
                setApplying(true)
                try {
                  if (await onApply(generated.content)) onClose()
                } catch (e) {
                  showToast(e instanceof Error ? e.message : 'Ошибка применения', 'error')
                } finally {
                  setApplying(false)
                }
              }}
            >
              {applying ? 'Применяем…' : 'Применить'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
