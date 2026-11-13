import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { IconAlertTriangle, IconArrowRight, IconChevronDown, IconFileUpload, IconMinus, IconPlus } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCall, buildClashHeaders, capitalize, clashFetch } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import { cn } from '../../lib/utils'

type Network = 'tcp' | 'udp'
type Core = 'mihomo' | 'xray'
type Outcome = 'matched' | 'default' | 'error'

interface RouteTestRule {
  index: number
  text: string
  detail: string | null
}

interface RouteTestBalancer {
  tag: string
  selector: string[]
}

interface RouteTestSkipped {
  index: number
  text: string
  reason: string
}

interface RouteTestResult {
  target: string
  kind: string
  outcome: Outcome
  outbound: string | null
  rule: RouteTestRule | null
  balancer: RouteTestBalancer | null
  resolvedIps: string[]
  dnsSource: 'mihomo' | 'doh' | null
  skipped: RouteTestSkipped[]
  error: string | null
}

interface RouteTestInitResponse {
  success: boolean
  error?: string
  core?: Core
  inboundTags?: string[]
}

export interface RouteTestRunResponse {
  success: boolean
  error?: string
  core?: Core
  results?: RouteTestResult[]
  warnings?: string[]
}

interface ProxyLite {
  type?: string
  now?: string
}

const MAX_TARGETS = 500
const NO_INBOUND = '__none__'
const DNS_SOURCE_LABELS: Record<string, string> = { mihomo: 'mihomo', doh: 'DoH' }

const IPV4_REGEX = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6_REGEX =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/

function isValidIp(value: string): boolean {
  return IPV4_REGEX.test(value) || IPV6_REGEX.test(value)
}

function pluralizeTargets(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 19) return 'целей'
  if (mod10 === 1) return 'цель'
  if (mod10 >= 2 && mod10 <= 4) return 'цели'
  return 'целей'
}

function resolveProxyChain(proxies: Record<string, ProxyLite | undefined>, name: string): string[] {
  const chain = [name]
  const visited = new Set([name])
  let current = name
  for (;;) {
    const info = proxies[current]
    if (!info?.now || visited.has(info.now)) break
    chain.push(info.now)
    visited.add(info.now)
    current = info.now
  }
  return chain
}

export function ResultRow({
  result,
  chain,
  expanded,
  onToggle,
}: {
  result: RouteTestResult
  chain?: string[]
  expanded: boolean
  onToggle: () => void
}) {
  const hasDetails = result.skipped.length > 0 || !!result.error

  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 basis-48 text-sm font-medium wrap-anywhere">{result.target}</span>
        <Badge
          variant={result.outcome === 'matched' ? 'emerald' : result.outcome === 'default' ? 'sky' : 'destructive'}
          className="max-w-full shrink-0 truncate"
          title={result.outcome === 'error' ? undefined : (result.outbound ?? undefined)}
        >
          {result.outcome === 'error' ? 'Ошибка' : (result.outbound ?? '—')}
        </Badge>
      </div>

      {chain && chain.length > 1 && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
          {chain.map((name, i) => (
            <span key={`${name}-${i}`} className="flex min-w-0 items-center gap-1">
              {i > 0 && <IconArrowRight className="size-3 shrink-0" aria-hidden />}
              <span className="truncate">{name}</span>
            </span>
          ))}
        </div>
      )}

      {result.outcome !== 'error' && (
        <div
          className="text-muted-foreground truncate text-xs"
          title={result.rule ? `${result.rule.text}${result.rule.detail ? ` — ${result.rule.detail}` : ''}` : undefined}
        >
          {result.rule ? (
            <>
              <span className="text-foreground/80">Правило #{result.rule.index + 1}:</span> {result.rule.text}
              {result.rule.detail && <span className="opacity-75"> — {result.rule.detail}</span>}
            </>
          ) : (
            'Ни одно правило не подошло — маршрут по умолчанию'
          )}
        </div>
      )}

      {result.balancer && (
        <div className="text-muted-foreground text-xs">
          Балансировщик <span className="text-foreground font-medium">{result.balancer.tag}</span>
          {result.balancer.selector.length > 0 && <>: {result.balancer.selector.join(', ')}</>}
        </div>
      )}

      {result.resolvedIps.length > 0 && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
          <span className="break-all">{result.resolvedIps.join(', ')}</span>
          {result.dnsSource && (
            <Badge variant="outline" className="h-4.5 px-1.5 text-[10px]">
              {DNS_SOURCE_LABELS[result.dnsSource] ?? result.dnsSource}
            </Badge>
          )}
        </div>
      )}

      {hasDetails && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onToggle}
            aria-expanded={expanded}
            className="text-muted-foreground hover:text-foreground -ml-2"
          >
            <IconChevronDown data-icon="inline-start" className={cn('transition-transform', expanded && 'rotate-180')} />
            {result.error ? 'Подробнее об ошибке' : `Пропущено правил: ${result.skipped.length}`}
          </Button>
          {expanded && (
            <div className="mt-1 space-y-1 border-l-2 pl-3 text-xs">
              {result.error && <div className="text-destructive">{result.error}</div>}
              {result.skipped.map((s) => (
                <div key={s.index} className="text-muted-foreground">
                  <span className="text-foreground">#{s.index + 1}</span> {s.text} — {s.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

export function RouteTesterModal() {
  const { state, showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const { clashApiPort, clashApiSecret, clashApiUnix } = state

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showRouteTestModal', show: false })

  const [loadingInit, setLoadingInit] = useState(true)
  const [core, setCore] = useState<Core | null>(null)
  const [inboundTags, setInboundTags] = useState<string[]>([])

  const [input, setInput] = useState('')
  const [port, setPort] = useState('443')
  const [network, setNetwork] = useState<Network>('tcp')
  const [sourceIp, setSourceIp] = useState('')
  const [inboundTag, setInboundTag] = useState(NO_INBOUND)

  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<RouteTestResult[] | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [chains, setChains] = useState<Record<string, string[]>>({})
  const [filter, setFilter] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const runIdRef = useRef(0)

  useEffect(() => {
    if (!modals.showRouteTestModal) return
    let cancelled = false
    apiCall<RouteTestInitResponse>('GET', 'route-test')
      .then((data) => {
        if (cancelled) return
        if (data.success) {
          setCore(data.core ?? null)
          const tags = data.inboundTags ?? []
          setInboundTags(tags)
          setInboundTag((prev) => (prev !== NO_INBOUND ? prev : (tags.find((tag) => tag !== 'api') ?? NO_INBOUND)))
        } else {
          showToast(data.error || 'Не удалось получить данные ядра', 'error')
        }
      })
      .catch(() => {
        if (!cancelled) showToast('Не удалось получить данные ядра', 'error')
      })
      .finally(() => {
        if (!cancelled) setLoadingInit(false)
      })
    return () => {
      cancelled = true
      // The next opening starts with the loading state again.
      setLoadingInit(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modals.showRouteTestModal])

  // Abort the in-flight run (and thus stop it from writing stale state) when the modal closes or unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [modals.showRouteTestModal])

  const targets = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const raw of input.split('\n')) {
      const line = raw.trim()
      if (!line || seen.has(line)) continue
      seen.add(line)
      list.push(line)
    }
    return list
  }, [input])

  const overLimit = targets.length > MAX_TARGETS
  const portNum = Number(port)
  const portValid = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535

  function bumpPort(delta: number) {
    const base = Number.isFinite(portNum) ? Math.trunc(portNum) : 1
    setPort(String(Math.min(65535, Math.max(1, base + delta))))
  }
  const sourceIpTrimmed = sourceIp.trim()
  const sourceIpValid = !sourceIpTrimmed || isValidIp(sourceIpTrimmed)
  const canRun = targets.length > 0 && !overLimit && portValid && sourceIpValid && !running

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      setInput((prev) => {
        const base = prev.replace(/\n+$/, '')
        return base ? `${base}\n${text}` : text
      })
    }
    reader.onerror = () => showToast('Не удалось прочитать файл', 'error')
    reader.readAsText(file)
  }

  const run = useCallback(async () => {
    if (!canRun) return
    const runId = ++runIdRef.current
    setRunning(true)
    setResults(null)
    setWarnings([])
    setChains({})
    setFilter(null)
    setExpanded(new Set())
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('/api/route-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildClashHeaders(clashApiPort, clashApiSecret, clashApiUnix) },
        body: JSON.stringify({
          targets,
          port: portNum,
          network,
          sourceIp: sourceIpTrimmed || null,
          inboundTag: inboundTag === NO_INBOUND ? null : inboundTag,
        }),
        signal: controller.signal,
      })
      // axum extractor rejections (e.g. bad JSON, invalid query) return a plain-text body, not JSON —
      // read as text first so a failed parse still yields a readable message instead of a raw SyntaxError.
      const bodyText = await res.text()
      let data: RouteTestRunResponse | null = null
      try {
        data = bodyText ? (JSON.parse(bodyText) as RouteTestRunResponse) : null
      } catch {
        data = null
      }
      if (runIdRef.current !== runId) return
      if (!res.ok || !data || !data.success) {
        const statusLine = `${res.status} ${res.statusText}`.trim()
        const fallback = bodyText.trim() ? `${statusLine}: ${bodyText.trim().slice(0, 300)}` : statusLine
        showToast(data?.error || `Ошибка проверки маршрута — ${fallback}`, 'error')
        return
      }
      setResults(data.results ?? [])
      setWarnings(data.warnings ?? [])
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      if (runIdRef.current !== runId) return
      showToast(e instanceof Error ? e.message : 'Ошибка проверки маршрута', 'error')
    } finally {
      if (runIdRef.current === runId) {
        abortRef.current = null
        setRunning(false)
      }
    }
  }, [canRun, targets, portNum, network, sourceIpTrimmed, inboundTag, clashApiPort, clashApiSecret, clashApiUnix, showToast])

  function cancelRun() {
    abortRef.current?.abort()
  }

  // Resolve mihomo's live proxy-group chain (e.g. Discord -> Auto -> Финляндия) for the outbounds
  // that came back from the run. One bulk GET /clash/proxies, then walk `.now` locally — no
  // per-name lookups, which used to 404 for proxy-provider members and spam the log.
  useEffect(() => {
    if (!modals.showRouteTestModal || !results || core !== 'mihomo' || !(clashApiPort || clashApiUnix)) return
    const uniqueOutbounds = Array.from(new Set(results.filter((r) => r.outbound).map((r) => r.outbound as string)))
    if (uniqueOutbounds.length === 0) return
    let cancelled = false
    ;(async () => {
      let data: { proxies?: Record<string, ProxyLite> } | null
      try {
        data = await clashFetch<{ proxies?: Record<string, ProxyLite> }>(clashApiPort ?? '', 'proxies', {
          secret: clashApiSecret,
          unix: clashApiUnix ?? null,
          retry: false,
        })
      } catch {
        data = null
      }
      if (cancelled) return
      const proxies = data?.proxies ?? {}
      const next: Record<string, string[]> = {}
      for (const name of uniqueOutbounds) {
        const chain = resolveProxyChain(proxies, name)
        if (chain.length > 1) next[name] = chain
      }
      setChains(next)
    })()
    return () => {
      cancelled = true
    }
  }, [results, core, clashApiPort, clashApiSecret, clashApiUnix, modals.showRouteTestModal])

  const chipEntries = useMemo(() => {
    if (!results) return []
    const counts = new Map<string, number>()
    let errorCount = 0
    for (const r of results) {
      if (r.outcome === 'error') {
        errorCount += 1
        continue
      }
      const key = r.outbound ?? '—'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const entries = Array.from(counts.entries())
      .map(([key, count]) => ({ key, label: key, count }))
      .sort((a, b) => b.count - a.count)
    if (errorCount > 0) entries.push({ key: '__error__', label: 'Ошибки', count: errorCount })
    return entries
  }, [results])

  const filteredResults = useMemo(() => {
    if (!results) return []
    if (!filter) return results
    if (filter === '__error__') return results.filter((r) => r.outcome === 'error')
    return results.filter((r) => r.outcome !== 'error' && (r.outbound ?? '—') === filter)
  }, [results, filter])

  function toggleExpanded(target: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })
  }

  return (
    <Dialog open={modals.showRouteTestModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4 pr-14">
          <DialogTitle className="text-[15px] font-bold tracking-wider uppercase">Проверка маршрута</DialogTitle>
          <DialogDescription>
            {loadingInit
              ? 'Загрузка данных ядра…'
              : core
                ? `Покажет, через какое подключение пойдёт трафик. Ядро: ${capitalize(core)}`
                : 'Не удалось определить активное ядро'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          <FieldGroup className="gap-4">
            <Field data-invalid={overLimit || undefined}>
              <FieldLabel htmlFor="route-test-targets">Адреса</FieldLabel>
              <Textarea
                id="route-test-targets"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    if (canRun) run()
                  }
                }}
                placeholder={'youtube.com\n1.1.1.1\nwww.google.com'}
                aria-invalid={overLimit || undefined}
                spellCheck={false}
                className="max-h-72 min-h-24 resize-y"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                {overLimit ? (
                  <FieldError>
                    Не более {MAX_TARGETS} адресов за раз — сейчас {targets.length}
                  </FieldError>
                ) : (
                  <FieldDescription>
                    Домены или IP, по одному на строку · {targets.length} {pluralizeTargets(targets.length)}
                  </FieldDescription>
                )}
                <input ref={fileInputRef} type="file" accept=".txt,.list,.csv,text/plain" className="hidden" onChange={handleFilePick} />
                <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <IconFileUpload data-icon="inline-start" /> Загрузить файл
                </Button>
              </div>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!portValid || undefined}>
                <FieldLabel htmlFor="route-test-port">Порт</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="route-test-port"
                    type="number"
                    min={1}
                    max={65535}
                    inputMode="numeric"
                    aria-invalid={!portValid || undefined}
                    className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                  <InputGroupAddon align="inline-end" className="gap-0.5">
                    <InputGroupButton size="icon-xs" aria-label="Уменьшить порт" onClick={() => bumpPort(-1)}>
                      <IconMinus />
                    </InputGroupButton>
                    <InputGroupButton size="icon-xs" aria-label="Увеличить порт" onClick={() => bumpPort(1)}>
                      <IconPlus />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {!portValid && <FieldError>Порт от 1 до 65535</FieldError>}
              </Field>

              <Field>
                <FieldLabel id="route-test-network-label">Сеть</FieldLabel>
                <ButtonGroup aria-labelledby="route-test-network-label" className="w-full">
                  <Button
                    type="button"
                    className="flex-1"
                    aria-pressed={network === 'tcp'}
                    variant={network === 'tcp' ? 'default' : 'outline'}
                    onClick={() => setNetwork('tcp')}
                  >
                    TCP
                  </Button>
                  <Button
                    type="button"
                    className="flex-1"
                    aria-pressed={network === 'udp'}
                    variant={network === 'udp' ? 'default' : 'outline'}
                    onClick={() => setNetwork('udp')}
                  >
                    UDP
                  </Button>
                </ButtonGroup>
              </Field>

              <Field data-invalid={!sourceIpValid || undefined}>
                <FieldLabel htmlFor="route-test-source-ip">IP источника</FieldLabel>
                <Input
                  id="route-test-source-ip"
                  value={sourceIp}
                  onChange={(e) => setSourceIp(e.target.value)}
                  placeholder="192.168.1.2"
                  aria-invalid={!sourceIpValid || undefined}
                />
                {sourceIpValid ? (
                  <FieldDescription>Необязательно. Устройство в локальной сети</FieldDescription>
                ) : (
                  <FieldError>Неверный IP-адрес</FieldError>
                )}
              </Field>

              {core === 'xray' && (
                <Field>
                  <FieldLabel htmlFor="route-test-inbound">Inbound</FieldLabel>
                  <Select
                    value={inboundTag}
                    items={{ [NO_INBOUND]: 'Не задан', ...Object.fromEntries(inboundTags.map((tag) => [tag, tag])) }}
                    onValueChange={setInboundTag}
                  >
                    <SelectTrigger id="route-test-inbound" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={NO_INBOUND}>Не задан</SelectItem>
                        {inboundTags.map((tag) => (
                          <SelectItem key={tag} value={tag}>
                            {tag}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
          </FieldGroup>

          {warnings.length > 0 && (
            <Alert variant="destructive">
              <IconAlertTriangle />
              <AlertTitle>Предупреждения</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-0.5 pl-4">
                  {warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {results && (
            <section aria-labelledby="route-test-results" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="route-test-results" className="text-sm font-bold tracking-wider uppercase">
                  Результат
                </h3>
                {filter && (
                  <Button variant="ghost" size="xs" onClick={() => setFilter(null)}>
                    Показать все
                  </Button>
                )}
              </div>

              {results.length > 0 && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Фильтр по подключению">
                  {chipEntries.map((entry) => (
                    <Button
                      key={entry.key}
                      type="button"
                      size="xs"
                      variant={filter === entry.key ? 'default' : 'outline'}
                      aria-pressed={filter === entry.key}
                      onClick={() => setFilter((prev) => (prev === entry.key ? null : entry.key))}
                      className="max-w-full"
                    >
                      <span className="truncate">{entry.label}</span>
                      <span className="tabular-nums opacity-70">{entry.count}</span>
                    </Button>
                  ))}
                </div>
              )}

              {results.length === 0 ? (
                <Empty className="border py-8">
                  <EmptyHeader>
                    <EmptyTitle className="text-base">Нет результатов</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {filteredResults.map((r) => (
                    <ResultRow
                      key={r.target}
                      result={r}
                      chain={r.outbound ? chains[r.outbound] : undefined}
                      expanded={expanded.has(r.target)}
                      onToggle={() => toggleExpanded(r.target)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        <DialogFooter className="border-t px-5 py-3 sm:items-center">
          <p className="text-muted-foreground text-xs sm:mr-auto">Настройки DNS и sniffing могут влиять на точность</p>
          {running && (
            <Button type="button" variant="outline" onClick={cancelRun}>
              Остановить
            </Button>
          )}
          <Button onClick={run} disabled={!canRun}>
            {running && <Spinner data-icon="inline-start" />}
            {running ? 'Проверка…' : 'Проверить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
