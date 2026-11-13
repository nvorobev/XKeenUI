import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ClearIcon } from '@/components/ui/clear-icon'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { IconDatabase, IconDeviceFloppy, IconEye, IconFilter, IconLetterCase, IconRefresh, IconStack2 } from '@tabler/icons-react'
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react'
import { isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml'
import { apiCall, clashFetch } from '../../lib/api'
import { fetchClashProxies, fetchClashRuleProviders, useAppActions, useProxiesStore } from '../../lib/store'
import type { ProxyProvider, ProxySubscriptionInfo, RuleProvider } from '../../lib/types'
import { normalizeVehicleType } from '../../lib/utils'
import { ProviderEditor } from '../configuration/editor/ProviderEditor'
import { ReadOnlyYamlView } from '../configuration/editor/ReadOnlyYamlView'

export type ProvidersModalKind = 'rules' | 'proxies'

type Provider = ProxyProvider | RuleProvider

interface Props {
  open: boolean
  kind: ProvidersModalKind
  clashApiPort: string
  clashApiSecret: string | null
  clashApiUnix?: string | null
  onOpenChange: (open: boolean) => void
}

interface ViewTarget {
  name: string
  vehicleType?: string
  format?: string
  behavior?: string
}

interface ViewContent extends ViewTarget {
  content: string
}

interface ApiResult {
  success: boolean
  error?: string
  content?: string
}

const ENDPOINTS = { proxies: 'proxy-providers', rules: 'rule-providers' } as const
const FORMAT_LABELS: Record<string, string> = { MrsRule: 'MRS', YamlRule: 'YAML', TextRule: 'TEXT' }
const COLUMN_COUNT = 6
const PAYLOAD_PATTERN = /^\s*payload\s*:/m
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]
const BADGE_TONES = {
  blue: 'sky',
  green: 'emerald',
  emerald: 'emerald',
  orange: 'amber',
  muted: 'secondary',
} as const
const VEHICLE_TONES: Record<string, keyof typeof BADGE_TONES> = { HTTP: 'green', FILE: 'orange' }

type BadgeTone = keyof typeof BADGE_TONES

const providerContentCache = new Map<string, string>()
const relativeTimeFormatter = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' })

const isProvidersLoaded = (kind: ProvidersModalKind) =>
  useProxiesStore.getState()[kind === 'proxies' ? 'proxyProvidersLoaded' : 'ruleProvidersLoaded']

const detectLanguage = (kind: ProvidersModalKind, content: string) =>
  kind === 'proxies' || PAYLOAD_PATTERN.test(content) ? 'yaml' : 'text'

const isUpdatable = (provider: Provider) => normalizeVehicleType(provider.vehicleType) !== 'INLINE'

const isMrsFormat = (value?: string) => ['mrs', 'mrsrule'].includes(value?.trim().toLowerCase() ?? '')

const isNeverUpdated = (value?: string | number) => typeof value === 'string' && value.startsWith('0001-01-01')

const describeError = (error: unknown) => (error instanceof Error ? error.message : 'неизвестная ошибка')

const countLines = (text: string) => text.split('\n').filter(Boolean).length

function formatVehicleType(value?: string) {
  const normalized = normalizeVehicleType(value)
  return normalized ? normalized[0] + normalized.slice(1).toLowerCase() : '—'
}

function parseDate(value?: string | number) {
  if (!value) return null
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDateTime(value?: string | number) {
  return (
    parseDate(value)?.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }) ?? '—'
  )
}

function formatRelativeTime(value?: string | number) {
  const date = parseDate(value)
  if (!date) return '—'
  const elapsedSeconds = (Date.now() - date.getTime()) / 1000
  if (elapsedSeconds < 45) return 'только что'
  const [unit, unitSeconds] = RELATIVE_UNITS.find(([, seconds]) => elapsedSeconds >= seconds) ?? RELATIVE_UNITS[RELATIVE_UNITS.length - 1]
  return relativeTimeFormatter.format(-Math.round(elapsedSeconds / unitSeconds), unit)
}

function formatBytes(bytes: number) {
  const exponent = bytes > 0 ? Math.min(Math.floor(Math.log2(bytes) / 10), BYTE_UNITS.length - 1) : 0
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(exponent === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${BYTE_UNITS[exponent]}`
}

function formatTraffic(info?: ProxySubscriptionInfo) {
  const used = (info?.Upload ?? 0) + (info?.Download ?? 0)
  const total = info?.Total ?? 0
  if (total > 0) return `${formatBytes(used)} / ${formatBytes(total)}`
  return used > 0 ? formatBytes(used) : '—'
}

function extractProxiesBlock(content: string) {
  const parsed = parseDocument(content)
  if (parsed.errors.length > 0 || !isMap(parsed.contents)) return null
  const pair = parsed.contents.items.find((entry) => isScalar(entry.key) && entry.key.value === 'proxies')
  if (!pair || !isScalar(pair.key) || !isNode(pair.value)) return null
  const keyStart = pair.key.range?.[0]
  const valueEnd = pair.value.range?.[1]
  if (keyStart === undefined || valueEnd === undefined) return null
  return {
    text: content.slice(keyStart, valueEnd).trimEnd(),
    count: isSeq(pair.value) || isMap(pair.value) ? pair.value.items.length : null,
  }
}

function buildQuery({ name, vehicleType, format, behavior }: ViewTarget) {
  const params = new URLSearchParams({ name })
  if (vehicleType) params.set('vehicleType', vehicleType)
  if (format) params.set('format', format)
  if (behavior) params.set('behavior', behavior)
  return params.toString()
}

function ProviderBadge({ tone = 'blue', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <Badge variant={BADGE_TONES[tone]}>{children}</Badge>
}

function ActionButton({ busy, icon, label, ...props }: ComponentProps<typeof Button> & { busy: boolean; icon: ReactNode; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={label} className="text-muted-foreground hover:text-foreground" {...props}>
            {busy ? <Spinner /> : icon}
          </Button>
        }
      />
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

function NameCell({ name, count, className }: { name: string; count: number; className: string }) {
  return (
    <TableCell className={className}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 truncate font-medium">{name}</div>
        <ProviderBadge>{count}</ProviderBadge>
      </div>
    </TableCell>
  )
}

function UpdatedCell({ provider }: { provider: Provider }) {
  if (!isUpdatable(provider)) return <TableCell />
  const { updatedAt } = provider
  return (
    <TableCell className="tabular-nums">
      {isNeverUpdated(updatedAt) ? (
        <span className="text-destructive">Не обновлялось</span>
      ) : (
        <span title={parseDate(updatedAt) ? formatDateTime(updatedAt) : undefined}>{formatRelativeTime(updatedAt)}</span>
      )}
    </TableCell>
  )
}

function ProxyProviderCells({ provider }: { provider: ProxyProvider }) {
  return (
    <>
      <NameCell name={provider.name} count={provider.proxies?.length ?? 0} className="max-w-72" />
      <TableCell>
        <ProviderBadge tone={VEHICLE_TONES[normalizeVehicleType(provider.vehicleType)]}>
          {formatVehicleType(provider.vehicleType)}
        </ProviderBadge>
      </TableCell>
      <TableCell className="min-w-42 font-medium tabular-nums">{formatTraffic(provider.subscriptionInfo)}</TableCell>
      <TableCell className="tabular-nums">{formatDateTime(provider.subscriptionInfo?.Expire)}</TableCell>
      <UpdatedCell provider={provider} />
    </>
  )
}

function RuleProviderCells({ provider, index }: { provider: RuleProvider; index: number }) {
  return (
    <>
      <TableCell className="text-muted-foreground tabular-nums">{index + 1}</TableCell>
      <NameCell name={provider.name} count={provider.ruleCount ?? 0} className="max-w-84" />
      <TableCell>{provider.format?.trim() && <ProviderBadge>{FORMAT_LABELS[provider.format] ?? provider.format}</ProviderBadge>}</TableCell>
      <TableCell>{provider.behavior && <ProviderBadge tone="emerald">{provider.behavior}</ProviderBadge>}</TableCell>
      <UpdatedCell provider={provider} />
    </>
  )
}

function LoadingTable() {
  return (
    <div className="flex flex-col gap-2 p-4">
      {Array.from({ length: 6 }, (_, row) => (
        <Skeleton key={row} className="h-10 rounded-md" />
      ))}
    </div>
  )
}

export function ProvidersModal({ open, kind, clashApiPort, clashApiSecret, clashApiUnix, onOpenChange }: Props) {
  const { showToast } = useAppActions()
  const proxyProviders = useProxiesStore((state) => state.proxyProviders)
  const ruleProviders = useProxiesStore((state) => state.ruleProviders)
  const [loading, setLoading] = useState(() => !isProvidersLoaded(kind))
  const [updatingNames, setUpdatingNames] = useState<string[]>([])
  const [viewingName, setViewingName] = useState('')
  const [viewContent, setViewContent] = useState<ViewContent | null>(null)
  const [viewOpen, setViewOpen] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [editError, setEditError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [onlyProxies, setOnlyProxies] = useState(true)
  const [filter, setFilter] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)

  const rows: Provider[] = kind === 'proxies' ? proxyProviders : ruleProviders
  const KindIcon = kind === 'proxies' ? IconDatabase : IconStack2
  const isUpdating = updatingNames.length > 0
  const updatableNames = rows.filter(isUpdatable).map((provider) => provider.name)

  const isViewEditable = !!viewContent && normalizeVehicleType(viewContent.vehicleType) === 'FILE' && !isMrsFormat(viewContent.format)
  const isViewDirty = isViewEditable && editContent !== viewContent?.content
  const editorLanguage = detectLanguage(kind, editContent)
  const saveDisabled = !isViewDirty || saving || !!editError
  const saveHint = saving
    ? 'Сохранение…'
    : editError
      ? `Исправьте ошибки YAML: ${editError}`
      : !isViewDirty
        ? 'Нет изменений'
        : 'Сохранить (Ctrl+S)'

  const proxiesBlock = useMemo(
    () => (kind === 'proxies' && viewContent ? extractProxiesBlock(viewContent.content) : null),
    [kind, viewContent]
  )
  const canFilterProxies = proxiesBlock !== null && !isViewEditable
  const visibleContent = onlyProxies && proxiesBlock ? proxiesBlock.text : (viewContent?.content ?? '')
  const viewBadgeCount = isViewEditable ? countLines(editContent) : (proxiesBlock?.count ?? countLines(visibleContent))

  const filteredRows = useMemo(() => {
    const query = filter.trim()
    if (!query) return rows
    const normalize = (text = '') => (caseSensitive ? text : text.toLowerCase())
    const needle = normalize(query)
    return rows.filter((provider) => {
      const { format, behavior } = provider as Partial<RuleProvider>
      return [provider.name, formatVehicleType(provider.vehicleType), provider.type, format, behavior].some((value) =>
        normalize(value).includes(needle)
      )
    })
  }, [rows, filter, caseSensitive])

  async function loadProviders(silent = false) {
    if (!clashApiPort && !clashApiUnix) return
    if (!silent) setLoading(true)
    try {
      if (kind === 'proxies') await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix)
      else await fetchClashRuleProviders(clashApiPort, clashApiSecret, clashApiUnix)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const timeoutId = setTimeout(() => void loadProviders(isProvidersLoaded(kind)), 0)
    return () => clearTimeout(timeoutId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, clashApiPort, clashApiSecret, clashApiUnix])

  const refreshProvider = (name: string) =>
    clashFetch(clashApiPort, `providers/${kind}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      secret: clashApiSecret,
      unix: clashApiUnix,
    })

  async function updateProviders(names: string[], successMessage: string) {
    setUpdatingNames(names)
    try {
      await Promise.all(names.map(refreshProvider))
      names.forEach((name) => providerContentCache.delete(`${kind}:${name}`))
      await loadProviders(true)
      showToast(successMessage)
    } catch (error) {
      showToast(`Ошибка обновления: ${describeError(error)}`, 'error')
    } finally {
      setUpdatingNames([])
    }
  }

  function openView(content: ViewContent) {
    setViewContent(content)
    setEditContent(content.content)
    setEditError(undefined)
    setSaving(false)
    setViewOpen(true)
  }

  async function viewProviderContent(provider: Provider) {
    const { format, behavior } = provider as Partial<RuleProvider>
    const target: ViewTarget = { name: provider.name, vehicleType: provider.vehicleType, format, behavior }
    const cacheKey = `${kind}:${provider.name}`
    const isCacheable = isMrsFormat(format)
    const cachedContent = isCacheable ? providerContentCache.get(cacheKey) : undefined
    if (cachedContent !== undefined) return openView({ ...target, content: cachedContent })

    setViewingName(provider.name)
    try {
      const response = await apiCall<ApiResult>('GET', `${ENDPOINTS[kind]}?${buildQuery(target)}`)
      if (!response.success || response.content === undefined) throw new Error(response.error ?? 'Нет данных')
      if (isCacheable) providerContentCache.set(cacheKey, response.content)
      openView({ ...target, content: response.content })
    } catch (error) {
      showToast(`Не удалось загрузить содержимое: ${describeError(error)}`, 'error')
    } finally {
      setViewingName('')
    }
  }

  async function saveViewContent() {
    if (!viewContent || saveDisabled) return
    setSaving(true)
    try {
      const response = await apiCall<ApiResult>('PUT', `${ENDPOINTS[kind]}?${buildQuery(viewContent)}`, { content: editContent })
      if (!response.success) throw new Error(response.error ?? 'Не удалось сохранить')
      setViewContent({ ...viewContent, content: editContent })
      providerContentCache.delete(`${kind}:${viewContent.name}`)
      showToast(`Провайдер ${viewContent.name} сохранён`)
    } catch (error) {
      showToast(`Не удалось сохранить: ${describeError(error)}`, 'error')
      return
    } finally {
      setSaving(false)
    }
    await refreshProvider(viewContent.name)
      .then(() => loadProviders(true))
      .catch(() => undefined)
  }

  const renderActions = (provider: Provider) => (
    <TableCell className="text-right">
      <div className="flex items-center justify-end gap-0.5">
        <ActionButton
          label="Содержимое"
          busy={viewingName === provider.name}
          icon={<IconEye className="size-4" />}
          onClick={() => void viewProviderContent(provider)}
          disabled={!!viewingName || isUpdating}
        />
        {isUpdatable(provider) && (
          <ActionButton
            label="Обновить"
            busy={updatingNames.includes(provider.name)}
            icon={<IconRefresh className="size-4" />}
            onClick={() => void updateProviders([provider.name], `Провайдер ${provider.name} обновлён`)}
            disabled={isUpdating}
          />
        )}
      </div>
    </TableCell>
  )

  const headers =
    kind === 'proxies' ? ['Название', 'Тип', 'Трафик', 'Истекает', 'Обновлено'] : ['#', 'Название', 'Формат', 'Поведение', 'Обновлено']

  const title = kind === 'proxies' ? 'Провайдеры прокси' : 'Провайдеры правил'

  return (
    <TooltipProvider delayDuration={500}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent initialFocus={false} className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-5xl flex-col gap-0 p-0 sm:max-w-5xl">
          <DialogHeader className="border-b px-5 py-4 pr-14">
            <DialogTitle className="text-[15px] font-bold tracking-wider uppercase">{title}</DialogTitle>
            <DialogDescription>
              {loading ? 'Загрузка…' : `Всего: ${rows.length}${filter.trim() ? ` · найдено: ${filteredRows.length}` : ''}`}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <InputGroup className="sm:max-w-sm">
                <InputGroupAddon>
                  <IconFilter />
                </InputGroupAddon>
                <InputGroupInput
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Фильтр по названию, типу, формату"
                  aria-label="Фильтр"
                />
                <InputGroupAddon align="inline-end" className="gap-0">
                  {filter && (
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="Очистить фильтр"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setFilter('')}
                    >
                      <ClearIcon size={13} />
                    </InputGroupButton>
                  )}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <InputGroupButton
                          size="icon-xs"
                          aria-label="Учитывать регистр"
                          aria-pressed={caseSensitive}
                          className={caseSensitive ? 'bg-accent text-foreground' : 'text-muted-foreground'}
                          onClick={() => setCaseSensitive((previous) => !previous)}
                        >
                          <IconLetterCase />
                        </InputGroupButton>
                      }
                    />
                    <TooltipContent side="bottom">Учитывать регистр</TooltipContent>
                  </Tooltip>
                </InputGroupAddon>
              </InputGroup>
              <Button
                variant="outline"
                className="sm:ml-auto"
                disabled={loading || isUpdating || updatableNames.length === 0}
                onClick={() =>
                  void updateProviders(updatableNames, kind === 'proxies' ? 'Провайдеры прокси обновлены' : 'Провайдеры правил обновлены')
                }
              >
                {updatingNames.length > 1 ? <Spinner data-icon="inline-start" /> : <IconRefresh data-icon="inline-start" />}
                Обновить все
              </Button>
            </div>

            <div className="overflow-x-auto rounded-lg border">
              {loading ? (
                <LoadingTable />
              ) : rows.length === 0 ? (
                <Empty className="py-10">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <KindIcon />
                    </EmptyMedia>
                    <EmptyTitle className="text-base">Провайдеров нет</EmptyTitle>
                    <EmptyDescription>В конфигурации не найдено ни одного провайдера или ядро не ответило</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="outline" size="sm" onClick={() => void loadProviders()}>
                      <IconRefresh data-icon="inline-start" />
                      Повторить
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <Table className="min-w-160 [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
                  <TableHeader>
                    <TableRow>
                      {headers.map((header) => (
                        <TableHead key={header} className={header === '#' ? 'w-10' : undefined}>
                          {header}
                        </TableHead>
                      ))}
                      <TableHead className="w-24 text-right">
                        <span className="sr-only">Действия</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={COLUMN_COUNT} className="text-muted-foreground py-8 text-center">
                          Нет совпадений
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredRows.map((provider, index) => (
                        <TableRow key={provider.name}>
                          {kind === 'proxies' ? (
                            <ProxyProviderCells provider={provider as ProxyProvider} />
                          ) : (
                            <RuleProviderCells provider={provider as RuleProvider} index={index} />
                          )}
                          {renderActions(provider)}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={viewOpen} onOpenChange={setViewOpen}>
        <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-5xl flex-col gap-0 p-0 sm:max-w-5xl">
          <DialogHeader className="border-b px-5 py-4 pr-14">
            <DialogTitle className="flex min-w-0 flex-wrap items-center gap-2 text-[15px] font-bold tracking-wider">
              <span className="min-w-0 truncate">{viewContent?.name}</span>
              <ProviderBadge>{viewBadgeCount}</ProviderBadge>
              {isViewEditable ? (
                <ProviderBadge tone="emerald">редактируемый</ProviderBadge>
              ) : (
                <ProviderBadge tone="muted">только чтение</ProviderBadge>
              )}
            </DialogTitle>
            <DialogDescription>{isViewEditable ? 'Локальный файл провайдера' : 'Содержимое провайдера'}</DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
            {kind === 'proxies' && (
              <Field orientation="horizontal" data-disabled={!canFilterProxies || undefined} className="w-auto">
                <Checkbox
                  id="providers-view-only-proxies"
                  checked={canFilterProxies && onlyProxies}
                  disabled={!canFilterProxies}
                  onCheckedChange={(value) => setOnlyProxies(value === true)}
                />
                <FieldLabel htmlFor="providers-view-only-proxies" className="font-normal">
                  Показывать только раздел proxies
                </FieldLabel>
              </Field>
            )}
            <div className="bg-input-background h-[60dvh] min-h-48 overflow-hidden rounded-lg border">
              {isViewEditable && viewContent ? (
                <ProviderEditor
                  key={viewContent.name}
                  content={viewContent.content}
                  language={editorLanguage}
                  onChange={setEditContent}
                  onSave={() => void saveViewContent()}
                  onValidationChange={setEditError}
                />
              ) : (
                <ReadOnlyYamlView content={visibleContent} language={detectLanguage(kind, visibleContent)} />
              )}
            </div>
          </div>

          <DialogFooter className="border-t px-5 py-3 sm:items-center">
            {isViewEditable && editError && <p className="text-destructive min-w-0 text-xs sm:mr-auto">{saveHint}</p>}
            <Button variant="outline" onClick={() => setViewOpen(false)}>
              Закрыть
            </Button>
            {isViewEditable && (
              <Button onClick={() => void saveViewContent()} disabled={saveDisabled} title={saveHint}>
                {saving ? <Spinner data-icon="inline-start" /> : <IconDeviceFloppy data-icon="inline-start" />}
                Сохранить
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
