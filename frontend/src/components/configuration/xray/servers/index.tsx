import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IconPlus, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCall } from '../../../../lib/api'
import { appendPingEntries, fetchPingHistory, useAppActions, usePingHistoryStore } from '../../../../lib/store'
import { registerUnsavedWork } from '../../../../lib/visibilityReload'
import { Panel } from '../../../shell/Panel'
import { ActiveStrip } from './ActiveStrip'
import { CurrentOutbound } from './CurrentServer'
import { FailoverSettings } from './FailoverSettings'
import {
  defaults,
  draftFromSnapshot,
  draftStatus,
  errorText,
  latestSample,
  MAX_SERVERS,
  needsRestart,
  newServerId,
  rangeError,
  withHistory,
  type Candidates,
  type Outbound,
  type Reply,
  type Sample,
  type Server,
  type Settings,
  type Snapshot,
} from './model'
import { ServerEditor, type EditorTarget } from './ServerEditor'
import { ServerRow } from './ServerRow'

type Busy = 'save' | 'select' | 'disable' | 'activate' | 'library' | null
type Filter = 'all' | 'pool' | 'alive'
type Sort = 'latency' | 'name' | 'source'
type Row = { server: Server; key: string; inPool: boolean; origin: string; pendingRemoval: boolean; sample: Sample | undefined }

const tagOf = (s: Server) => (typeof s.outbound.tag === 'string' ? s.outbound.tag : '')

export function XrayServers({ onChanged, hasUnsavedConfigs }: { onChanged: () => Promise<unknown>; hasUnsavedConfigs: boolean }) {
  const { showToast } = useAppActions()
  const history = usePingHistoryStore((s) => s.history)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [candidates, setCandidates] = useState<Candidates | null>(null)
  const [draft, setDraft] = useState<Settings>(defaults)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [busy, setBusy] = useState<Busy>(null)
  const busyRef = useRef(false)
  const revisionRef = useRef(0)
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [confirmDisable, setConfirmDisable] = useState(false)
  const [confirmActivate, setConfirmActivate] = useState<Server | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('latency')

  // The active server the draft was made from: saving tells the backend whether a server was picked.
  const baseSelectedRef = useRef('')
  const applySnapshot = useCallback((next: Snapshot, force = false) => {
    setSnapshot(next)
    if (force || !dirtyRef.current) {
      const stored = draftFromSnapshot(next)
      baseSelectedRef.current = stored.selected_id
      const pending = !!next.settings && JSON.stringify(stored) !== JSON.stringify(next.settings)
      dirtyRef.current = pending
      setDirty(pending)
      setDraft(stored)
    }
  }, [])

  const loadCandidates = useCallback(async () => {
    try {
      const result = await apiCall<Candidates>('GET', 'xray/servers/candidates')
      setCandidates(result)
    } catch (reason) {
      setCandidates({ success: false, error: errorText(reason, 'Не удалось прочитать конфиги') })
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    let tick = 0
    async function poll() {
      if (!busyRef.current && !document.hidden) {
        const revision = revisionRef.current
        try {
          const next = await apiCall<Snapshot>('GET', 'xray/servers', undefined, { timeoutMs: 15000 })
          if (!next.success) throw new Error(next.error || 'Не удалось загрузить серверы')
          if (!disposed && !busyRef.current && revision === revisionRef.current) {
            applySnapshot(next)
            setPollError('')
          }
          // Background pool probes land in the shared ping history; refresh it now and then.
          if (tick++ % 3 === 0) await fetchPingHistory()
        } catch (reason) {
          if (!disposed) setPollError(errorText(reason, 'Нет связи с панелью'))
        } finally {
          if (!disposed) setLoading(false)
        }
      }
      if (!disposed) timer = setTimeout(poll, 5000)
    }
    // Start right away, but from a timer: state changes never run inside the effect body.
    timer = setTimeout(poll, 0)
    apiCall<Candidates>('GET', 'xray/servers/candidates')
      .then((result) => {
        if (!disposed) setCandidates(result)
      })
      .catch((reason: unknown) => {
        if (!disposed) setCandidates({ success: false, error: errorText(reason, 'Не удалось прочитать конфиги') })
      })
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [applySnapshot])

  // An unsaved pool draft must survive the mobile reload after time in the background.
  useEffect(() => (dirty ? registerUnsavedWork() : undefined), [dirty])

  function update(next: Settings) {
    setDraft(next)
    setDirty(true)
    dirtyRef.current = true
  }

  function discard() {
    if (snapshot) applySnapshot(snapshot, true)
  }

  async function action(kind: Exclude<Busy, null>, method: string, endpoint: string, body: unknown, success: string) {
    if (busyRef.current) return
    revisionRef.current += 1
    busyRef.current = true
    setBusy(kind)
    setError('')
    try {
      const result = await apiCall<Reply>(method, endpoint, body, { timeoutMs: 180000 })
      if (!result.success) throw new Error(result.error || 'Операция не выполнена')
      const next = await apiCall<Snapshot>('GET', 'xray/servers')
      if (!next.success) throw new Error(next.error || 'Не удалось прочитать результат операции')
      dirtyRef.current = false
      setDirty(false)
      applySnapshot(next, true)
      showToast(success)
      await onChanged()
      if (kind === 'disable' || kind === 'activate') await loadCandidates()
    } catch (reason) {
      setError(errorText(reason, 'Ошибка запроса'))
      // A dropped HTTP response does not cancel the backend transaction. Read actual state again.
      try {
        applySnapshot(await apiCall<Snapshot>('GET', 'xray/servers'))
      } catch {
        /* polling retries */
      }
    } finally {
      revisionRef.current += 1
      busyRef.current = false
      setBusy(null)
    }
  }

  const saved = snapshot?.settings ?? null
  const configured = !!saved
  const leftover = !configured && !!snapshot?.managed_present
  const blocked = busy !== null || hasUnsavedConfigs || loading
  const liveActiveId = saved?.selected_id ?? snapshot?.active_id ?? ''
  const liveActive = saved?.servers.find((s) => s.id === liveActiveId)
  const activeName = snapshot?.servers.find((s) => s.id === liveActiveId)?.name ?? liveActive?.name
  const invalidRange = rangeError(draft)
  const restartPredicted = needsRestart(draft, saved)

  // Config outbounds the backend can take over: the default exit or ones used by rules.
  const usable = useMemo(() => {
    const routed = candidates?.routed_tags ?? []
    return (candidates?.outbounds ?? []).map((outbound) => {
      const tag = String(outbound.tag)
      const rules = routed.filter((t) => t === tag).length
      const isDefault = candidates?.default_tag === tag
      return { outbound, tag, rules, isDefault, ok: isDefault || rules > 0 }
    })
  }, [candidates])
  const current = usable.find((c) => c.isDefault) ?? usable.find((c) => c.rules > 0)
  const target = draft.target_tag || current?.tag || ''

  // One list of every server: pool members (keyed by id) and config outbounds outside the pool (keyed by tag).
  const rows = useMemo<Row[]>(() => {
    const configTags = new Set(usable.map((c) => c.tag))
    const poolTags = new Set(draft.servers.map(tagOf))
    const origin = (s: Server) => (configTags.has(tagOf(s)) ? tagOf(s) : '')
    const poolSample = (s: Server) =>
      latestSample(
        history[s.id],
        snapshot?.probes.find((p) => p.id === s.id),
        snapshot?.last_check
      )
    const stored = snapshot?.servers ?? []
    const storedTags = new Set(stored.map(tagOf))
    return [
      ...draft.servers.map((server) => ({
        server,
        key: server.id,
        inPool: true,
        origin: origin(server),
        pendingRemoval: false,
        sample: poolSample(server),
      })),
      ...stored
        .filter((s) => !draft.servers.some((d) => d.id === s.id))
        .map((server) => ({
          server,
          key: server.id,
          inPool: false,
          origin: origin(server),
          pendingRemoval: !!saved?.servers.some((s) => s.id === server.id),
          sample: poolSample(server),
        })),
      ...usable
        .filter((c) => !poolTags.has(c.tag) && !storedTags.has(c.tag))
        .map((c) => ({
          server: { id: `config:${c.tag}`, name: c.tag, outbound: c.outbound },
          key: c.tag,
          inPool: false,
          origin: c.tag,
          pendingRemoval: false,
          sample: latestSample(history[c.tag]),
        })),
    ]
  }, [draft.servers, saved, usable, history, snapshot])

  const activeId = draft.selected_id || liveActiveId
  const visible = useMemo(() => {
    const list = rows.filter((r) =>
      filter === 'pool' ? r.inPool && !r.pendingRemoval : filter === 'alive' ? r.sample?.latency_ms != null : true
    )
    const latency = (r: Row) => (r.sample?.latency_ms != null ? (r.sample.average_ms ?? r.sample.latency_ms) : Number.MAX_SAFE_INTEGER)
    list.sort((a, b) => {
      const pin = Number(b.server.id === liveActiveId) - Number(a.server.id === liveActiveId)
      if (pin) return pin
      if (sort === 'name') return a.server.name.localeCompare(b.server.name)
      if (sort === 'source') return Number(b.inPool) - Number(a.inPool) || a.origin.localeCompare(b.origin)
      return latency(a) - latency(b)
    })
    return list
  }, [rows, filter, sort, liveActiveId])

  const counts = {
    all: rows.filter((r) => !r.pendingRemoval).length,
    pool: draft.servers.length,
    alive: rows.filter((r) => r.sample?.latency_ms != null).length,
  }

  const changes = useMemo(() => {
    if (!saved) return draft.servers.length
    const removed = saved.servers.filter((s) => !draft.servers.some((d) => d.id === s.id)).length
    const servers = draft.servers.filter((s) => draftStatus(s, saved)).length + removed
    return servers + (JSON.stringify({ ...draft, servers: [] }) !== JSON.stringify({ ...saved, servers: [] }) ? 1 : 0)
  }, [draft, saved])

  function serverFor(tag: string): Server | undefined {
    const stored = snapshot?.servers.find((s) => tagOf(s) === tag)
    if (stored) return stored
    const candidate = usable.find((c) => c.tag === tag)
    return candidate && { id: newServerId(), name: candidate.tag, outbound: candidate.outbound }
  }

  /** Before the first save the outbound carrying traffic is in the pool, and something is active. */
  function withTarget(next: Settings, tag: string): Settings {
    if (configured) return next
    const existing = next.servers.find((s) => s.outbound.tag === tag)
    const server = existing ?? serverFor(tag)
    if (!server) return next
    const servers = existing ? next.servers : [server, ...next.servers]
    const selected = servers.some((s) => s.id === next.selected_id) ? next.selected_id : server.id
    return { ...next, target_tag: tag, servers, selected_id: selected }
  }

  function toggle(row: Row, checked: boolean) {
    if (!checked) {
      update({ ...draft, servers: draft.servers.filter((s) => s.id !== row.server.id) })
      return
    }
    if (draft.servers.length >= MAX_SERVERS) {
      showToast(`В пуле может быть не больше ${MAX_SERVERS} серверов`, 'error')
      return
    }
    const added = row.server.id.startsWith('config:') ? { ...row.server, id: newServerId() } : row.server
    update(withTarget({ ...draft, servers: [...draft.servers, added] }, target))
  }

  function activate(row: Row) {
    if (configured && dirty) {
      showToast('Сначала примените или отмените изменения пула', 'error')
      return
    }
    if (row.inPool && dirty) {
      update(withTarget({ ...draft, selected_id: row.server.id }, target))
      return
    }
    if (!configured || !row.inPool) {
      if (dirty) {
        showToast('Сначала примените или отмените изменения пула', 'error')
        return
      }
      if (configured) setConfirmActivate(row.server)
      else void activateStandalone(row.server)
      return
    }
    void action('select', 'POST', 'xray/servers/select', { id: row.server.id }, `Сервер «${row.server.name}» активен. Xray перезапущен.`)
  }

  async function activateStandalone(server: Server) {
    if (server.id.startsWith('config:')) {
      server = { ...server, id: newServerId() }
      try {
        await saveServer(server)
      } catch (reason) {
        showToast(errorText(reason, 'Не удалось сохранить сервер'), 'error')
        return
      }
    }
    await action('activate', 'POST', 'xray/servers/activate', { id: server.id, target_tag: target }, `Сервер «${server.name}» активен`)
  }

  function changeTarget(tag: string) {
    const kept = draft.servers.filter((s) => s.id !== draft.selected_id || s.outbound.tag === tag)
    update(withTarget({ ...draft, target_tag: tag, servers: kept, selected_id: '' }, tag))
  }

  async function saveServer(server: Server) {
    if (busyRef.current) throw new Error('Дождитесь завершения текущей операции')
    busyRef.current = true
    revisionRef.current += 1
    setBusy('library')
    try {
      const result = await apiCall<Reply>('PUT', 'xray/servers/library', server, { timeoutMs: 15000 })
      if (!result.success) throw new Error(result.error || 'Не удалось сохранить сервер')
      setSnapshot(
        (current) =>
          current && {
            ...current,
            servers: [...(current.servers ?? []).filter((s) => s.id !== server.id), server],
          }
      )
      if (draft.servers.some((s) => s.id === server.id)) {
        update({ ...draft, servers: draft.servers.map((s) => (s.id === server.id ? server : s)) })
      }
      showToast('Сервер сохранён на роутере')
      setEditor(null)
    } finally {
      revisionRef.current += 1
      busyRef.current = false
      setBusy(null)
    }
  }

  async function deleteServer(server: Server) {
    if (busyRef.current) return
    busyRef.current = true
    revisionRef.current += 1
    setBusy('library')
    try {
      const result = await apiCall<Reply>('DELETE', 'xray/servers/library', { id: server.id }, { timeoutMs: 15000 })
      if (!result.success) throw new Error(result.error || 'Не удалось удалить сервер')
      setSnapshot((current) => current && { ...current, servers: current.servers.filter((s) => s.id !== server.id) })
      showToast('Сервер удалён')
    } catch (reason) {
      showToast(errorText(reason, 'Не удалось удалить сервер'), 'error')
    } finally {
      revisionRef.current += 1
      busyRef.current = false
      setBusy(null)
    }
  }

  function editServer(id: string) {
    const server = draft.servers.find((s) => s.id === id) ?? snapshot?.servers.find((s) => s.id === id)
    if (server) setEditor({ id: server.id, name: server.name, outbound: server.outbound })
  }

  const probeBody = (outbounds: Outbound[]) => ({
    outbounds,
    ...(invalidRange ? {} : { url: draft.probe_url, timeout_ms: draft.timeout_ms }),
  })

  async function checkRows(list: Row[]) {
    if (list.length === 0) return
    const keys = list.map((r) => r.key)
    setChecking((prev) => new Set([...prev, ...keys]))
    try {
      const outbounds = list.map((r) => ({ ...r.server.outbound, tag: r.key }))
      const result = await apiCall<{ success: boolean; error?: string; results?: { tag: string; latency_ms?: number; error?: string }[] }>(
        'POST',
        'healthcheck/all',
        probeBody(outbounds),
        { timeoutMs: 120000 }
      )
      if (!result.success || !result.results) throw new Error(result.error || 'Проверка не выполнена')
      appendPingEntries(result.results.map((r) => ({ tag: r.tag, delay: r.latency_ms ?? 0, error: r.error })))
      const alive = result.results.filter((r) => (r.latency_ms ?? 0) > 0).length
      if (list.length > 1) showToast(`Проверка завершена: доступно ${alive} из ${result.results.length}`)
    } catch (reason) {
      showToast(errorText(reason, 'Проверка не выполнена'), 'error')
    } finally {
      setChecking((prev) => new Set([...prev].filter((k) => !keys.includes(k))))
    }
  }

  const inPool = draft.servers.length
  const unsavedPoolChanges = JSON.stringify(draft) !== JSON.stringify(draftFromSnapshot(snapshot))
  const canSave = dirty && !blocked && inPool > 0 && !!draft.target_tag && !invalidRange
  const checkingAll = checking.size > 0 && checking.size >= rows.length
  const pendingActiveId = draft.selected_id !== liveActiveId ? draft.selected_id : ''
  const saveLabel = configured
    ? 'Пул сохранён и применён'
    : `Пул включён. Активный: ${draft.servers.find((s) => s.id === draft.selected_id)?.name ?? ''}`

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-bold tracking-wider uppercase">Серверы</h1>
          <p className="text-muted-foreground text-sm">Состояние всех серверов, пул автопереключения и активный сервер.</p>
        </div>
        <div className="grid w-full gap-2 min-[400px]:flex min-[400px]:w-auto min-[400px]:flex-wrap">
          <Button
            variant="outline"
            disabled={loading || checking.size > 0 || rows.length === 0}
            onClick={() => void checkRows(rows.filter((r) => !r.pendingRemoval))}
          >
            {checkingAll ? <Spinner data-icon="inline-start" /> : <IconRefresh data-icon="inline-start" />}
            {checkingAll ? `Проверяем ${rows.length}…` : 'Проверить все'}
          </Button>
          <Button
            disabled={busy !== null || loading || (snapshot?.servers.length ?? 0) >= MAX_SERVERS}
            onClick={() => setEditor({ id: newServerId(), name: '', outbound: null })}
          >
            <IconPlus data-icon="inline-start" />
            Добавить по ссылке
          </Button>
        </div>
      </div>

      {hasUnsavedConfigs && (
        <Alert>
          <AlertTitle>Есть несохранённые конфиги</AlertTitle>
          <AlertDescription>Сначала сохраните или отмените изменения в разделе «Конфигурация».</AlertDescription>
        </Alert>
      )}
      {(error || pollError || snapshot?.error) && (
        <Alert variant="destructive">
          <AlertTitle>{error ? 'Операция не выполнена' : 'Проблема с пулом серверов'}</AlertTitle>
          <AlertDescription>
            {error || snapshot?.error || pollError}
            {!error && !snapshot?.error && pollError && ' Повторяем каждые 5 с.'}
          </AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="flex flex-col gap-3" aria-busy>
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-80 w-full rounded-lg" />
        </div>
      ) : leftover ? (
        <Alert variant="destructive">
          <AlertTitle>Найдены остатки прошлой настройки</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            В конфигах Xray остался управляемый файл пула, но список серверов не загружен. Верните исходные настройки, затем настройте пул
            заново.
            <Button variant="destructive" size="sm" disabled={blocked} onClick={() => setConfirmDisable(true)}>
              Восстановить исходные настройки
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {configured && liveActive ? (
            <ActiveStrip
              server={{ ...liveActive, name: activeName ?? liveActive.name }}
              snapshot={withHistory(snapshot!, history)}
              disabled={blocked}
              onEdit={() => editServer(liveActive.id)}
            />
          ) : (
            <>
              <CurrentOutbound
                outbound={current?.outbound}
                name={activeName}
                activeSince={snapshot?.active_since}
                isDefault={!!current?.isDefault}
                rules={current?.rules ?? 0}
              />
              {usable.length > 0 && (
                <Alert>
                  <AlertTitle>Как включить пул</AlertTitle>
                  <AlertDescription>
                    <ol className="mt-1 flex list-decimal flex-col gap-1 pl-4">
                      <li>Отметьте серверы для пула — текущий outbound сразу станет активным.</li>
                      <li>При желании нажмите «Сделать активным» у другого сервера пула.</li>
                      <li>Нажмите «Включить пул» внизу.</li>
                    </ol>
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}

          <Panel
            title="Все серверы"
            id="servers-all"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
                  <TabsList>
                    <TabsTrigger value="all">Все {counts.all}</TabsTrigger>
                    <TabsTrigger value="pool">В пуле {counts.pool}</TabsTrigger>
                    <TabsTrigger value="alive">Доступны {counts.alive}</TabsTrigger>
                  </TabsList>
                </Tabs>
                <Select
                  value={sort}
                  onValueChange={(value) => setSort(value as Sort)}
                  items={{ latency: 'По задержке', name: 'По имени', source: 'По источнику' }}
                >
                  <SelectTrigger size="sm" aria-label="Сортировка">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="latency">По задержке</SelectItem>
                      <SelectItem value="name">По имени</SelectItem>
                      <SelectItem value="source">По источнику</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            }
          >
            <p className="text-muted-foreground -mt-2 text-sm">
              Галочка «в пуле» — панель проверяет сервер и может переключиться на него при сбое. «Активный» — через него сейчас идёт трафик.
            </p>
            {candidates && !candidates.success && <p className="text-destructive text-sm">{candidates.error}</p>}
            <div className="-mx-5 -mb-5">
              <div className="text-muted-foreground hidden grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,13rem)_7.5rem_11.5rem_2rem] gap-x-3 border-t px-5 py-2 text-[11px] font-medium tracking-wider uppercase lg:grid">
                <span title="Проверять и использовать для автопереключения">Пул</span>
                <span>Сервер</span>
                <span>Адрес</span>
                <span className="text-right">Задержка</span>
                <span />
                <span />
              </div>
              {visible.length === 0 ? (
                <p className="text-muted-foreground border-t px-5 py-8 text-center text-sm">
                  {filter === 'alive'
                    ? 'Нет доступных серверов. Нажмите «Проверить все».'
                    : 'Серверов пока нет. Добавьте сервер по ссылке или outbound в разделе «Конфигурация».'}
                </p>
              ) : (
                <ul className="divide-y border-t">
                  {visible.map((row) => {
                    const isLiveActive = row.server.id === liveActiveId
                    const lockHint = row.inPool && (row.server.id === activeId || isLiveActive) ? 'Активный сервер всегда в пуле' : ''
                    return (
                      <ServerRow
                        key={row.key}
                        server={row.server}
                        inPool={row.inPool && !row.pendingRemoval}
                        sample={row.sample}
                        active={isLiveActive}
                        pendingActive={configured && row.server.id === pendingActiveId}
                        status={draftStatus(row.server, saved)}
                        origin={row.origin}
                        pendingRemoval={row.pendingRemoval}
                        checking={checking.has(row.key)}
                        disabled={blocked}
                        lockHint={row.pendingRemoval ? '' : lockHint}
                        onToggle={(value) => toggle(row, value)}
                        onActivate={() => activate(row)}
                        onEdit={() => editServer(row.server.id)}
                        onCheck={() => void checkRows([row])}
                        onDelete={() => void deleteServer(row.server)}
                      />
                    )
                  })}
                </ul>
              )}
            </div>
          </Panel>

          {(inPool > 0 || configured) && (
            <Panel title="Автопереключение" id="servers-failover">
              <FailoverSettings draft={draft} disabled={blocked} error={invalidRange} onChange={update} />
              {!configured && usable.filter((c) => c.ok).length > 1 && (
                <Field className="sm:max-w-sm">
                  <FieldLabel htmlFor="xray-target">Какой трафик переключать</FieldLabel>
                  <Select
                    value={target}
                    disabled={blocked}
                    onValueChange={(tag) => {
                      if (tag) changeTarget(String(tag))
                    }}
                    items={Object.fromEntries(usable.map((c) => [c.tag, c.tag]))}
                  >
                    <SelectTrigger id="xray-target" className="w-full">
                      <SelectValue placeholder="Выберите outbound" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {usable.map((c) => (
                          <SelectItem key={c.tag} value={c.tag} disabled={!c.ok}>
                            {c.tag}
                            <span className="text-muted-foreground text-xs">
                              {c.isDefault ? 'по умолчанию' : c.rules > 0 ? `правил: ${c.rules}` : 'не используется'}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {configured && (
                <div className="flex justify-end border-t pt-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    disabled={blocked || dirty}
                    onClick={() => setConfirmDisable(true)}
                  >
                    Отключить управление серверами…
                  </Button>
                </div>
              )}
            </Panel>
          )}
        </>
      )}

      {(dirty || busy) && (
        <div
          className="bg-card/95 sticky bottom-0 z-20 flex flex-col gap-3 rounded-lg border px-4 py-3 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between"
          role="status"
        >
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2 text-sm font-medium">
              {busy ? <Spinner /> : <span aria-hidden className="size-2 rounded-full bg-amber-500" />}
              {busy
                ? busy === 'select'
                  ? 'Переключаем сервер и перезапускаем Xray'
                  : 'Выполняется операция — не перезапускайте роутер'
                : `Изменений: ${changes}`}
            </span>
            {!busy && (
              <span className="text-muted-foreground text-xs">
                {restartPredicted
                  ? 'Xray будет перезапущен, открытые соединения прервутся. При ошибке вернётся прежняя конфигурация.'
                  : 'Применится без перезапуска Xray.'}
              </span>
            )}
          </div>
          {dirty && (
            <div className="grid grid-cols-2 gap-2 sm:flex">
              {unsavedPoolChanges && (
                <Button variant="ghost" disabled={busy !== null} onClick={discard}>
                  Отменить
                </Button>
              )}
              <Button
                disabled={!canSave}
                onClick={() =>
                  void action('save', 'PUT', 'xray/servers', { ...draft, base_selected_id: baseSelectedRef.current }, saveLabel)
                }
              >
                {busy === 'save' && <Spinner data-icon="inline-start" />}
                {configured ? 'Сохранить и применить' : 'Включить пул'}
              </Button>
            </div>
          )}
        </div>
      )}

      {editor && (
        <ServerEditor
          target={editor}
          servers={[...draft.servers, ...(snapshot?.servers ?? []).filter((s) => !draft.servers.some((d) => d.id === s.id))]}
          isActive={editor.id === liveActiveId}
          onSave={saveServer}
          onClose={() => setEditor(null)}
        />
      )}

      <AlertDialog
        open={!!confirmActivate}
        onOpenChange={(open) => {
          if (!open) setConfirmActivate(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Использовать сервер без пула?</AlertDialogTitle>
            <AlertDialogDescription>
              Сервер «{confirmActivate?.name}» заменит текущее подключение. Пул и автопереключение отключатся, список серверов сохранится.
              Xray перезапустится.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              disabled={blocked}
              onClick={() => {
                const server = confirmActivate
                setConfirmActivate(null)
                if (server) void activateStandalone(server)
              }}
            >
              Сделать активным
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDisable} onOpenChange={setConfirmDisable}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отключить управление серверами?</AlertDialogTitle>
            <AlertDialogDescription>
              Мониторинг и автоматическое переключение этой группы будут отключены. Текущее подключение и библиотека серверов сохранятся.
              Для старого формата пула будут восстановлены исходные routing и api.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={blocked}
              onClick={() => {
                setConfirmDisable(false)
                void action('disable', 'DELETE', 'xray/servers', undefined, 'Исходные настройки Xray восстановлены')
              }}
            >
              Отключить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
