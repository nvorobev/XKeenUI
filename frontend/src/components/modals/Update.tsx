import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import {
  IconAlertCircle,
  IconCancel,
  IconCircleCheck,
  IconDownload,
  IconLogs,
  IconPlaylistX,
  IconRefresh,
  IconWorldShare,
} from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { apiCall, capitalize } from '../../lib/api'
import { useAppContext, useModalContext, useSettings } from '../../lib/store'
import type { Release } from '../../lib/types'
import { cn, repoSlug } from '../../lib/utils'
import type { UpdateEvent, WsMessage } from '../../lib/websocket'
import { useUpdateWebSocket } from '../../lib/websocket'
import { Panel } from '../shell/Panel'

const GITHUB_API = 'https://api.github.com/repos'
const JSDELIVR_API = 'https://data.jsdelivr.com/v1/package/gh'
const FETCH_TIMEOUT_MS = 5000
const CORE_REPOS = {
  xray: 'XTLS/Xray-core',
  mihomo: 'MetaCubeX/mihomo',
  self: 'nvorobev/XKeenUI',
} as const

const LEVEL_CLASSES: Record<string, string> = {
  info: 'text-foreground/80',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-rose-600 dark:text-rose-400',
}

const STAGE_LABELS: Record<string, string> = {
  prepare: 'Подготовка',
  download: 'Загрузка',
  install: 'Установка',
  restart: 'Перезапуск',
}

const mdClass = `
  text-xs text-muted-foreground leading-relaxed
  [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-foreground [&_h1]:mb-2 [&_h1]:mt-3 [&_h1:first-child]:mt-0
  [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2:first-child]:mt-0
  [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:mb-1 [&_h3]:mt-2 [&_h3:first-child]:mt-0
  [&_p]:mb-2 [&_p:last-child]:mb-0 [&_p]:break-words
  [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ul:last-child]:mb-0 [&_li]:mb-0.5 [&_li]:break-words
  [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol:last-child]:mb-0
  [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[10px] [&_code]:font-mono [&_code]:wrap-anywhere
  [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:rounded [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:max-w-full
  [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:break-normal
  [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:wrap-anywhere
  [&_strong]:text-foreground [&_strong]:font-semibold
  [&_hr]:border-ring/20 [&_hr]:my-2
  [&_blockquote]:border-l-2 [&_blockquote]:border-ring/40 [&_blockquote]:pl-3 [&_blockquote]:italic
`.trim()

const fetchWithTimeout = (url: string, init?: RequestInit) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, '')
}

/** Индикатор выбора версии в строке аккордеона (сама строка — кнопка). */
function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
        checked ? 'border-primary bg-primary' : 'border-muted-foreground/50'
      )}
    >
      {checked && <span className="bg-primary-foreground size-1.5 rounded-full" />}
    </span>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

interface ProcessProps {
  core: string
  coreLabel: string
  version: string
  assets: string[]
  backupCore: boolean
  onInstalled: () => void
  onStartFailed: () => void
  onClose: () => void
}

interface LogLine {
  ts: string
  level: string
  message: string
}

/** Записи журнала: обычные строки лога и «живые» строки прогресса (по одной на файл). */
type Entry =
  | { kind: 'stage'; id: number; stage: string }
  | { kind: 'log'; id: number; line: LogLine }
  | { kind: 'progress'; id: number; downloaded: number; total: number; speed: number }

interface StageGroup {
  id: number
  stage: string
  items: Exclude<Entry, { kind: 'stage' }>[]
}

function UpdateProcess({ core, coreLabel, version, assets, backupCore, onInstalled, onStartFailed, onClose }: ProcessProps) {
  const { dispatch, showToast } = useAppContext()
  const githubProxies = useSettings((s) => s.githubProxies)
  /** Записи журнала: обычные строки лога и «живые» строки прогресса (по одной на файл). */
  const [entries, setEntries] = useState<Entry[]>([])
  const [stage, setStage] = useState('')
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [running, setRunning] = useState(true)
  const [started, setStarted] = useState(false)
  const [result, setResult] = useState<{ success: boolean; error: string | null } | null>(null)

  const logRef = useRef<HTMLDivElement>(null)
  const doneHandledRef = useRef(false)
  const startedRef = useRef(false)
  const lastSeqRef = useRef(0)
  const nextEntryIdRef = useRef(1)
  const activeProgressIdRef = useRef<number | null>(null)
  const propsRef = useRef({ core, coreLabel, version, onInstalled, showToast })
  useEffect(() => {
    propsRef.current = { core, coreLabel, version, onInstalled, showToast }
  })

  const restoreStatus = useCallback(() => {
    apiCall<any>('GET', 'control')
      .then((data) => {
        if (data.success) {
          dispatch({ type: 'SET_SERVICE_STATUS', status: data.running ? 'running' : 'stopped' })
        }
      })
      .catch(() => dispatch({ type: 'SET_SERVICE_STATUS', status: 'stopped' }))
  }, [dispatch])

  const applyEvent = useCallback(
    (ev: UpdateEvent) => {
      // Дедупликация: событие может прийти и из истории, и из broadcast-потока.
      if (typeof ev.seq === 'number') {
        if (ev.seq <= lastSeqRef.current) return
        lastSeqRef.current = ev.seq
      }
      switch (ev.type) {
        case 'log': {
          const line = { ts: ev.ts ?? '', level: ev.level ?? 'info', message: ev.message ?? '' }
          // Любая строка лога — это граница попытки: активная строка прогресса замораживается.
          // Новая закачка получит свою строку прогресса по первому реально пришедшему чанку.
          activeProgressIdRef.current = null
          setEntries((prev) => [...prev.slice(-199), { kind: 'log' as const, id: nextEntryIdRef.current++, line }])
          break
        }
        case 'stage':
          setStage(ev.stage ?? '')
          if (ev.stage !== 'download') activeProgressIdRef.current = null
          if (ev.stage) {
            const stageName = ev.stage
            setEntries((prev) => [...prev.slice(-199), { kind: 'stage' as const, id: nextEntryIdRef.current++, stage: stageName }])
          }
          break
        case 'progress': {
          const values = { downloaded: ev.downloaded ?? 0, total: ev.total ?? 0, speed: ev.speed ?? 0 }
          activeProgressIdRef.current ??= nextEntryIdRef.current++
          const progressId = activeProgressIdRef.current
          setEntries((prev) =>
            prev.some((e) => e.kind === 'progress' && e.id === progressId)
              ? prev.map((e) => (e.kind === 'progress' && e.id === progressId ? { ...e, ...values } : e))
              : [...prev.slice(-199), { kind: 'progress' as const, id: progressId, ...values }]
          )
          break
        }
        case 'done': {
          if (doneHandledRef.current) break
          doneHandledRef.current = true
          activeProgressIdRef.current = null
          setRunning(false)
          setResult({ success: !!ev.success, error: ev.error ?? null })
          const { core, coreLabel, version, onInstalled, showToast } = propsRef.current
          if (ev.success) {
            if (core === 'self') {
              showToast(`Установлен XKeen UI ${version} — перезапуск интерфейса`)
              setTimeout(() => window.location.reload(), 1000)
            } else {
              showToast(`Установлен ${coreLabel} ${version}`)
              onInstalled()
              restoreStatus()
            }
          } else {
            showToast(ev.error || 'Обновление отменено', ev.error?.includes('Отменено') ? 'warning' : 'error')
            restoreStatus()
          }
          break
        }
      }
    },
    [restoreStatus]
  )

  const handleWsMessage = useCallback(
    (data: WsMessage) => {
      if (data.type !== 'update') return
      if (data.history) {
        const newestSeq = data.history.at(-1)?.seq ?? 0
        if (newestSeq < lastSeqRef.current) {
          lastSeqRef.current = 0
          activeProgressIdRef.current = null
        }
        data.history.forEach(applyEvent)
      } else if (data.event) {
        applyEvent(data.event)
      }
    },
    [applyEvent]
  )

  useUpdateWebSocket(handleWsMessage, started)

  // Запуск обновления — один раз при монтировании окна процесса.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const { core, version, showToast } = propsRef.current
    apiCall<{ success: boolean; error?: string }>('POST', 'update', {
      core,
      version,
      backup_core: backupCore,
      assets,
    })
      .then((data) => {
        if (data.success) {
          setStarted(true)
          return
        }
        showToast(data.error || 'Не удалось запустить обновление', 'error')
        restoreStatus()
        onStartFailed()
      })
      .catch(() => {
        showToast('Не удалось запустить обновление', 'error')
        restoreStatus()
        onStartFailed()
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Автоскролл журнала процесса.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  // Страховка для self-обновления: если событие done потерялось при перезапуске бэкенда — перезагружаемся.
  useEffect(() => {
    if (core !== 'self' || !running || stage !== 'restart') return
    const timer = setTimeout(() => window.location.reload(), 20000)
    return () => clearTimeout(timer)
  }, [core, running, stage])

  const control = (action: 'cancel' | 'proxy') => {
    apiCall('POST', 'update/control', { action }).catch(() => {})
  }

  const handleClose = () => {
    if (running) return
    if (core === 'self' && result?.success) {
      window.location.reload()
      return
    }
    onClose()
  }

  // Строка прогресса живёт как строка лога и остаётся видимой после завершения загрузки.
  // Позиция строки прогресса — просто очередная запись журнала.
  const renderLogLine = ({ id, line }: Extract<Entry, { kind: 'log' }>) => (
    <div key={`l${id}`} className="flex gap-2 wrap-anywhere">
      {line.ts && <span className="text-muted-foreground/50 shrink-0">{line.ts}</span>}
      <span
        className={
          line.message.startsWith('✓')
            ? 'font-medium text-emerald-600 dark:text-emerald-400'
            : (LEVEL_CLASSES[line.level] ?? LEVEL_CLASSES.info)
        }
      >
        {line.message}
      </span>
    </div>
  )

  const renderProgressLine = (e: Extract<Entry, { kind: 'progress' }>) => {
    const pct = e.total > 0 ? Math.min(100, (e.downloaded / e.total) * 100) : null
    return (
      <div key={`p${e.id}`} className="flex items-center gap-2 wrap-anywhere">
        <Progress value={pct} className="min-w-16 flex-1 [&_[data-slot=progress-track]]:h-1.5" />
        <span className="text-muted-foreground shrink-0">
          {pct !== null && `${Math.round(pct)}% · `}
          {formatBytes(e.downloaded)}
          {running && e.id === entries.at(-1)?.id && e.speed > 0 && ` · ${formatBytes(e.speed)}/с`}
        </span>
      </div>
    )
  }
  const groups = entries.reduce<StageGroup[]>((accumulator, entry) => {
    if (entry.kind === 'stage') {
      accumulator.push({ id: entry.id, stage: entry.stage, items: [] })
      return accumulator
    }
    if (accumulator.length === 0) accumulator.push({ id: 0, stage: '', items: [] })
    accumulator[accumulator.length - 1].items.push(entry)
    return accumulator
  }, [])

  const renderGroup = (group: StageGroup, index: number) => {
    const isLast = index === groups.length - 1
    const status = isLast && running ? 'running' : isLast && result && !result.success ? 'error' : undefined
    return (
      <TraceCollapsible
        key={group.id}
        open={expanded[group.id] ?? isLast}
        onOpenChange={(value) => setExpanded((previous) => ({ ...previous, [group.id]: value }))}
      >
        <TraceCollapsibleTrigger>
          <TraceLine status={status}>
            <TraceIcon>{status === 'running' ? <Spinner /> : status === 'error' ? <IconAlertCircle /> : <IconCircleCheck />}</TraceIcon>
            <TraceTitle>{STAGE_LABELS[group.stage] ?? 'Запуск'}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div className="text-[13px]">
            {group.items.map((item) => (item.kind === 'log' ? renderLogLine(item) : renderProgressLine(item)))}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    )
  }

  const selfRestarting = core === 'self' && result?.success
  // Управление доступно, пока идёт загрузка; после неё процесс доводится до конца.
  const canControl = running && (stage === '' || stage === 'prepare' || stage === 'download')

  const statusText = running
    ? `${STAGE_LABELS[stage] ?? 'Запуск'}…`
    : result?.success
      ? selfRestarting
        ? 'Установлено, интерфейс перезапускается'
        : 'Установка завершена'
      : 'Обновление не выполнено'

  return (
    <Panel title={`Установка ${coreLabel} ${version}`} id="update-process">
      <div className="flex items-center gap-2 text-sm">
        {running ? (
          <Spinner className="size-3.5" />
        ) : result?.success ? (
          <IconCircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <IconAlertCircle className="text-destructive size-4" />
        )}
        {statusText}
      </div>

      <div className="flex h-[min(60dvh,32rem)] min-h-64 flex-col">
        <Trace
          ref={logRef}
          className="bg-muted/30 min-h-0 flex-1 scrollbar-thin overflow-y-auto rounded-lg border p-3 [&:has([data-slot=empty])]:justify-center"
        >
          {groups.length === 0 ? (
            <Empty className="p-2">
              <EmptyMedia variant="icon">
                <IconLogs />
              </EmptyMedia>
              <EmptyTitle className="text-base">Журнал пуст</EmptyTitle>
              <EmptyDescription>Ожидание событий установки…</EmptyDescription>
            </Empty>
          ) : (
            groups.map(renderGroup)
          )}
        </Trace>
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
        {running ? (
          <>
            <Button variant="outline" onClick={() => control('proxy')} disabled={!canControl || githubProxies.length === 0}>
              <IconWorldShare data-icon="inline-start" />
              Через GitHub-прокси
            </Button>
            <Button variant="destructive" onClick={() => control('cancel')} disabled={!canControl}>
              <IconCancel data-icon="inline-start" />
              Отменить
            </Button>
          </>
        ) : (
          <Button onClick={handleClose}>
            {selfRestarting ? (
              <>
                <IconRefresh data-icon="inline-start" />
                Перезагрузить
              </>
            ) : (
              'Закрыть'
            )}
          </Button>
        )}
      </div>
    </Panel>
  )
}

export function UpdatesPage({ active, onInstalled }: { active: boolean; onInstalled: () => void }) {
  const { state, dispatch, showToast } = useAppContext()
  const { modals } = useModalContext()
  const backupCore = useSettings((s) => s.backupCore)
  const githubProxies = useSettings((s) => s.githubProxies)
  const xrayRepo = useSettings((s) => s.xrayRepo)
  const mihomoRepo = useSettings((s) => s.mihomoRepo)
  const updateModalCore = modals.updateModalCore || 'self'
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedVersion, setSelectedVersion] = useState('')
  const [openVersion, setOpenVersion] = useState('')
  const [source, setSource] = useState<'github' | 'jsdelivr' | ''>('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<{ core: string; version: string; assets: string[] } | null>(null)

  const releaseRequestRef = useRef(0)
  const installingRef = useRef(false)

  const coreLabel = updateModalCore === 'self' ? 'XKeen UI' : capitalize(updateModalCore)
  const repo =
    updateModalCore === 'self'
      ? CORE_REPOS.self
      : updateModalCore === 'xray'
        ? repoSlug(xrayRepo) || CORE_REPOS.xray
        : updateModalCore === 'mihomo'
          ? repoSlug(mihomoRepo) || CORE_REPOS.mihomo
          : ''
  const close = () => {
    installingRef.current = false
    setPending(null)
  }

  useEffect(() => {
    if (active && !pending) void fetchReleases()
    return () => {
      releaseRequestRef.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, updateModalCore, repo])

  async function fetchReleases() {
    const request = ++releaseRequestRef.current
    setLoading(true)
    setSelectedVersion('')
    setOpenVersion('')
    setReleases([])
    setSource('')
    try {
      if (!repo) throw new Error('UNKNOWN_CORE')

      const ghUrl = `${GITHUB_API}/${repo}/releases?per_page=10`
      const ghUrls = [ghUrl, ...githubProxies.map((p) => `${p.replace(/\/+$/, '')}/${ghUrl}`)]

      for (const url of ghUrls) {
        let res: Response
        try {
          res = await fetchWithTimeout(url, { headers: { Accept: 'application/vnd.github+json' } })
        } catch {
          continue
        }
        if (!res.ok) continue
        const rels = (await res.json()) as Array<{
          tag_name?: string
          name?: string
          published_at?: string
          prerelease?: boolean
          body?: string | null
          assets?: Array<{ name: string; browser_download_url: string }>
        }>
        const parsed = (rels ?? [])
          .map((r) => ({
            version: (r.tag_name ?? '').replace(/^v/i, ''),
            name: r.name ?? '',
            published_at: (r.published_at ?? '').split('T')[0] ?? '',
            is_prerelease: !!r.prerelease,
            body: r.body ?? '',
            assets: (r.assets ?? []).map((a) => a.name),
          }))
          .filter((r) => r.version)

        if (parsed.length) {
          if (request !== releaseRequestRef.current) return
          setReleases(parsed)
          setSelectedVersion(parsed[0].version)
          setOpenVersion(parsed[0].version)
          setSource('github')
          setLoading(false)
          return
        }
      }

      const jsdRes = await fetchWithTimeout(`${JSDELIVR_API}/${repo}`).catch(() => null)
      if (jsdRes?.ok) {
        const jsd = (await jsdRes.json()) as { versions?: string[] }
        const versions = (jsd.versions ?? []).slice(0, 10)
        if (versions.length) {
          const parsed = versions.map((v) => ({
            version: v,
            name: `Release ${v}`,
            published_at: '',
            is_prerelease: false,
            body: '',
            assets: [],
          }))
          if (request !== releaseRequestRef.current) return
          setReleases(parsed)
          setSelectedVersion(parsed[0].version)
          setOpenVersion(parsed[0].version)
          setSource('jsdelivr')
          setLoading(false)
          return
        }
      }

      throw new Error('NO_RELEASES')
    } catch {
      if (request !== releaseRequestRef.current) return
      showToast('Не удалось получить список релизов', 'error')
    }
    if (request === releaseRequestRef.current) setLoading(false)
  }

  function startInstall() {
    if (!selectedVersion || installingRef.current || state.serviceStatus === 'pending') return
    installingRef.current = true
    const release = releases.find((r) => r.version === selectedVersion)
    if (updateModalCore !== 'self') dispatch({ type: 'REMOVE_TOAST', id: 'update-core' })
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Обновление...' })
    setPending({ core: updateModalCore, version: selectedVersion, assets: release?.assets ?? [] })
  }

  const installedVersion = normalizeVersion(updateModalCore === 'self' ? state.version : (state.coreVersions[updateModalCore] ?? ''))
  const selectedIsInstalled = !!selectedVersion && normalizeVersion(selectedVersion) === installedVersion

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-wider uppercase">Обновление</h1>
        <p className="text-muted-foreground text-sm">Установка версий панели и прокси-ядер, ход загрузки и журнал обновления.</p>
      </header>
      <Tabs value={updateModalCore} onValueChange={(core) => dispatch({ type: 'SET_UPDATE_MODAL_CORE', core })}>
        <TabsList>
          <TabsTrigger value="self" disabled={!!pending}>
            XKeen UI
          </TabsTrigger>
          <TabsTrigger value="xray" disabled={!!pending}>
            Xray
          </TabsTrigger>
          <TabsTrigger value="mihomo" disabled={!!pending}>
            Mihomo
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {!pending && (
        <Panel title={`Версии ${coreLabel}`} id="update-versions">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
            <span>
              Установлена: <span className="text-foreground font-medium">{installedVersion || 'нет'}</span>
            </span>
            {repo && (
              <Badge variant="outline" className="font-normal">
                {repo}
              </Badge>
            )}
            {!loading && source && (
              <Badge variant={source === 'github' ? 'emerald' : 'amber'}>{source === 'github' ? 'GitHub' : 'jsDelivr'}</Badge>
            )}
          </div>
          <div>
            {loading ? (
              <ul aria-busy="true" aria-label="Загрузка релизов" className="divide-y rounded-lg border">
                {Array.from({ length: 5 }, (_, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-3.5">
                    <Skeleton className="size-4 shrink-0 rounded-full" />
                    <div className="flex flex-1 flex-col gap-2">
                      <Skeleton className="h-4 w-40 max-w-full" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : releases.length === 0 ? (
              <Empty className="h-full min-h-64 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <IconPlaylistX />
                  </EmptyMedia>
                  <EmptyTitle className="text-base">Не удалось получить список версий</EmptyTitle>
                  <EmptyDescription>Проверьте доступ к GitHub или добавьте GitHub-прокси в настройках панели.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" size="sm" onClick={fetchReleases}>
                    <IconRefresh data-icon="inline-start" />
                    Повторить
                  </Button>
                </EmptyContent>
              </Empty>
            ) : source === 'github' ? (
              <Accordion
                type="single"
                collapsible
                value={openVersion}
                onValueChange={setOpenVersion}
                className="divide-y overflow-hidden rounded-lg border"
              >
                {releases.map((release, index) => {
                  const checked = selectedVersion === release.version
                  const isInstalled = normalizeVersion(release.version) === installedVersion
                  return (
                    <AccordionItem
                      key={release.version}
                      value={release.version}
                      className={cn('border-b-0 transition-colors', checked ? 'bg-primary/5' : 'hover:bg-muted/40')}
                    >
                      <AccordionTrigger
                        className="min-w-0 items-center gap-3 rounded-none px-4 py-3 hover:no-underline focus-visible:ring-inset"
                        onClick={() => setSelectedVersion(release.version)}
                      >
                        <RadioMark checked={checked} />
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{release.name || release.version}</span>
                            {index === 0 && !release.is_prerelease && <Badge variant="sky">Последняя</Badge>}
                            {release.is_prerelease && <Badge variant="amber">Pre-release</Badge>}
                            {isInstalled && <Badge variant="emerald">Установлена</Badge>}
                          </span>
                          <span className="text-muted-foreground text-xs font-normal">
                            {release.published_at || release.version}
                            {release.body ? ' · список изменений' : ''}
                          </span>
                        </span>
                      </AccordionTrigger>
                      {release.body && (
                        <AccordionContent className="px-4 pb-4">
                          <div className="bg-background/60 max-h-72 w-full scrollbar-thin overflow-x-hidden overflow-y-auto rounded-md border p-3">
                            <div className={cn(mdClass, 'min-w-0')}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null }}>
                                {release.body}
                              </ReactMarkdown>
                            </div>
                          </div>
                        </AccordionContent>
                      )}
                    </AccordionItem>
                  )
                })}
              </Accordion>
            ) : (
              <RadioGroup
                value={selectedVersion}
                onValueChange={setSelectedVersion}
                className="gap-0 divide-y overflow-hidden rounded-lg border"
              >
                {releases.map((release, index) => {
                  const checked = selectedVersion === release.version
                  const isInstalled = normalizeVersion(release.version) === installedVersion
                  return (
                    <label
                      key={release.version}
                      htmlFor={`release-${release.version}`}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors',
                        checked ? 'bg-primary/5' : 'hover:bg-muted/40'
                      )}
                    >
                      <RadioGroupItem value={release.version} id={`release-${release.version}`} className="shrink-0" />
                      <span className="truncate text-sm font-medium">{release.name || release.version}</span>
                      {index === 0 && <Badge variant="sky">Последняя</Badge>}
                      {isInstalled && <Badge variant="emerald">Установлена</Badge>}
                    </label>
                  )
                })}
              </RadioGroup>
            )}
          </div>

          <div className="flex justify-end border-t pt-4">
            <Button onClick={startInstall} disabled={!selectedVersion || loading || state.serviceStatus === 'pending'}>
              <IconDownload data-icon="inline-start" />
              {selectedVersion ? `${selectedIsInstalled ? 'Переустановить' : 'Установить'} ${selectedVersion}` : 'Установить'}
            </Button>
          </div>
        </Panel>
      )}

      {pending && (
        <UpdateProcess
          core={pending.core}
          coreLabel={pending.core === 'self' ? 'XKeen UI' : capitalize(pending.core)}
          version={pending.version}
          assets={pending.assets}
          backupCore={backupCore}
          onInstalled={onInstalled}
          onStartFailed={() => {
            installingRef.current = false
            setPending(null)
          }}
          onClose={() => {
            close()
          }}
        />
      )}
    </div>
  )
}
