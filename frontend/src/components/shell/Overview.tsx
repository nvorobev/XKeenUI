import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { IconActivityHeartbeat, IconGripVertical, IconRefresh } from '@tabler/icons-react'
import { Reorder, useDragControls, type PanInfo } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { create } from 'zustand'
import { apiCall } from '../../lib/api'
import { navigate } from '../../lib/navigation'
import { fetchPingHistory, useAppActions, useAppContext, usePingHistoryStore } from '../../lib/store'
import { cn } from '../../lib/utils'
import { delayColor, endpoint, extractMeta, transportLine } from '../configuration/xray/outboundMeta'
import { CurrentOutbound } from '../configuration/xray/servers/CurrentServer'
import {
  draftFromSnapshot,
  health,
  relativeTime,
  withHistory,
  type Candidates,
  type Probe,
  type Server,
  type Snapshot,
} from '../configuration/xray/servers/model'
import { StatusDot } from '../configuration/xray/servers/StatusBits'
import { InfoGrid, Panel } from './Panel'

type SystemStats = {
  success: boolean
  memoryUsed: number | null
  memoryTotal: number | null
  cpuUsage: number | null
  uptime: number | null
  hostname: string | null
  model: string | null
  firmware: string | null
  core: { name: string; pid: number | null; rssBytes?: number | null; uptimeSecs?: number | null } | null
}

export type RouterDevice = {
  mac: string
  name: string
  ip: string
  active: boolean
  registered: boolean
  in_xkeen: boolean
  rx_bytes: number
  tx_bytes: number
}

export type RouterOverview = {
  success: boolean
  error?: string
  policy: { name: string; description: string } | null
  wan: { interface: string; rx_bps: number; tx_bps: number } | null
  devices: RouterDevice[]
}

type TrafficSample = { t: number; xkeen: number; other: number }

const TRAFFIC_WINDOW_MS = 10 * 60 * 1000

type TrafficState = {
  samples: TrafficSample[]
  /** Download speed of each device, bits per second, from the last two polls. */
  speeds: Record<string, number>
  last: { t: number; bytes: Record<string, number> } | null
  push: (overview: RouterOverview, now?: number) => void
}

/** Device download speeds from the router's byte counters; kept while the panel is open. */
export const useTrafficStore = create<TrafficState>((set, get) => ({
  samples: [],
  speeds: {},
  last: null,
  push: (overview, now = Date.now()) => {
    const bytes = Object.fromEntries(overview.devices.map((device) => [device.mac, device.rx_bytes]))
    const last = get().last
    if (!last) {
      set({ last: { t: now, bytes } })
      return
    }
    const seconds = (now - last.t) / 1000
    if (seconds < 1) return
    // After a long pause (another page, a sleeping tab) the delta is no current speed.
    if (seconds > 60) {
      set({ last: { t: now, bytes } })
      return
    }
    const speeds: Record<string, number> = {}
    let xkeen = 0
    let other = 0
    for (const device of overview.devices) {
      const previous = last.bytes[device.mac]
      // A new device or a reset counter has no measurable delta yet.
      const delta = previous === undefined || device.rx_bytes < previous ? 0 : device.rx_bytes - previous
      const bps = (delta * 8) / seconds
      speeds[device.mac] = bps
      if (device.in_xkeen) xkeen += bps
      else other += bps
    }
    set((state) => ({
      last: { t: now, bytes },
      speeds,
      samples: [...state.samples.filter((sample) => now - sample.t <= TRAFFIC_WINDOW_MS), { t: now, xkeen, other }],
    }))
  },
}))

/** Polls `load` every `ms` while the page is visible. */
function usePolling(load: () => Promise<void>, ms: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    void load()
    const timer = setInterval(() => {
      if (!document.hidden) void load()
    }, ms)
    return () => clearInterval(timer)
  }, [load, ms, enabled])
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d} д ${h} ч`
  if (h > 0) return `${h} ч ${m} мин`
  return `${m} мин`
}

const mb = (bytes: number) => Math.round(bytes / 1048576)

/** Megabits per second with one decimal, Russian decimal comma. */
export function mbps(bps: number): string {
  const value = bps / 1_000_000
  return (value >= 100 ? Math.round(value).toString() : value.toFixed(1)).replace('.', ',')
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ`
  return `${Math.round(bytes / 1024 ** 2)} МБ`
}

function Meter({ label, percent, detail }: { label: string; percent: number | null; detail: string }) {
  const tone =
    percent == null
      ? ''
      : percent >= 90
        ? '[&_[data-slot=progress-indicator]]:bg-rose-500'
        : percent >= 70
          ? '[&_[data-slot=progress-indicator]]:bg-amber-500'
          : ''
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{detail}</span>
      </div>
      <Progress value={percent ?? 0} className={cn('h-1.5', tone)} aria-label={label} />
    </div>
  )
}

/* ─── Tiles ─────────────────────────────────────────────────────────────────── */

function Tile({
  label,
  value,
  detail,
  tone,
  onClick,
}: {
  label: string
  value: ReactNode
  detail: ReactNode
  tone?: 'ok' | 'bad'
  onClick?: () => void
}) {
  const body = (
    <>
      <span className="text-muted-foreground text-xs">{label}</span>
      <span
        className={cn(
          'truncate text-lg font-semibold tabular-nums',
          tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'bad' && 'text-rose-600 dark:text-rose-400'
        )}
      >
        {value}
      </span>
      <span className="text-muted-foreground truncate text-xs">{detail}</span>
    </>
  )
  const className = 'bg-card flex min-w-0 flex-col gap-0.5 rounded-lg border px-4 py-3 text-left'
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(className, 'hover:bg-accent/60 focus-visible:ring-ring/50 outline-none focus-visible:ring-3')}
    >
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}

function Tiles({
  isXray,
  snapshot,
  overview,
  guard,
}: {
  isXray: boolean
  snapshot: Snapshot | null
  overview: RouterOverview | null
  guard: 'on' | 'off' | 'inactive' | 'blocked' | null
}) {
  const settings = snapshot?.settings
  const activeId = settings?.selected_id ?? snapshot?.active_id
  const activeName = snapshot?.servers.find((server) => server.id === activeId)?.name
  const probe = snapshot?.probes.find((p) => p.id === activeId)
  const members = overview?.devices.filter((device) => device.in_xkeen).length ?? 0
  const online = overview?.devices.filter((device) => device.active).length ?? 0
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        label="Выход"
        value={isXray ? (activeName ?? '—') : 'Mihomo'}
        detail={
          isXray
            ? probe?.latency_ms != null
              ? `${probe.latency_ms} мс`
              : probe
                ? 'нет ответа'
                : 'без проверки'
            : 'группы в «Конфигурации»'
        }
        tone={isXray && probe && probe.latency_ms === null ? 'bad' : undefined}
        onClick={() => navigate(isXray ? 'servers' : 'config')}
      />
      <Tile
        label="Трафик"
        value={overview?.wan ? `↓ ${mbps(overview.wan.rx_bps)}` : '—'}
        detail={overview?.wan ? `↑ ${mbps(overview.wan.tx_bps)} Мбит/с · ${overview.wan.interface}` : 'нет данных роутера'}
      />
      <Tile
        label="Через XKeen"
        value={overview?.policy ? members : '—'}
        detail={overview?.policy ? `устройств, в сети ${online}` : 'нет политики XKeen'}
      />
      <Tile
        label="Защита трафика"
        value={guard == null ? '—' : { on: 'Вкл', off: 'Выкл', inactive: 'Не действует', blocked: 'Блокировка' }[guard]}
        detail={guard === 'blocked' ? 'VPN не подтверждён · интернет закрыт' : 'защита устройств политики XKeen'}
        tone={guard === 'on' ? 'ok' : guard === 'inactive' ? 'bad' : undefined}
        onClick={() => navigate('settings')}
      />
    </div>
  )
}

/* ─── Cards ─────────────────────────────────────────────────────────────────── */

type CardProps = { handle: ReactNode }

function ConnectionPanel({
  handle,
  snapshot,
  candidates,
  reload,
}: CardProps & {
  snapshot: Snapshot | null
  candidates: Candidates | null
  reload: () => Promise<void>
}) {
  const { showToast } = useAppActions()
  const [busy, setBusy] = useState<'check' | 'select' | 'mode' | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)

  async function run(kind: 'check' | 'select' | 'mode', method: string, endpoint: string, body: unknown, done: string) {
    setBusy(kind)
    try {
      const result = await apiCall<{ success: boolean; error?: string }>(method, endpoint, body, { timeoutMs: 180000 })
      showToast(result.success ? done : result.error || 'Действие не выполнено', result.success ? 'success' : 'error')
      await reload()
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Нет связи с панелью', 'error')
    } finally {
      setBusy(null)
    }
  }

  const settings = snapshot?.settings
  const probes = snapshot?.probes ?? []
  const name = (id: string) =>
    snapshot?.servers.find((server) => server.id === id)?.name ?? settings?.servers.find((s) => s.id === id)?.name ?? id
  // Failover moves to the fastest other server that answered (see `choose` in the backend).
  const reserve = settings
    ? probes
        .filter((p) => p.id !== settings.selected_id && p.latency_ms != null && settings.servers.some((s) => s.id === p.id))
        .sort((a, b) => (a.latency_ms ?? 0) - (b.latency_ms ?? 0))[0]
    : undefined

  const routed = candidates?.routed_tags ?? []
  const usable = (candidates?.outbounds ?? []).map((outbound) => {
    const tag = String(outbound.tag)
    return { outbound, isDefault: candidates?.default_tag === tag, rules: routed.filter((t) => t === tag).length }
  })
  const current = usable.find((c) => c.isDefault) ?? usable.find((c) => c.rules > 0)

  const modeSwitch = settings && (
    <ButtonGroup aria-label="Режим выбора сервера">
      {(
        [
          [true, 'Авто'],
          [false, 'Вручную'],
        ] as const
      ).map(([auto, label]) => (
        <Button
          key={label}
          size="sm"
          variant={settings.auto === auto ? 'default' : 'outline'}
          aria-pressed={settings.auto === auto}
          disabled={busy !== null}
          onClick={() =>
            settings.auto !== auto &&
            void run(
              'mode',
              'PUT',
              'xray/servers',
              { ...draftFromSnapshot(snapshot), auto, base_selected_id: settings.selected_id },
              auto ? 'Автопереключение включено' : 'Сервер выбирается вручную'
            )
          }
        >
          {label}
        </Button>
      ))}
    </ButtonGroup>
  )

  return (
    <Panel title="Подключение" id="overview-connection" handle={handle} actions={modeSwitch}>
      {!snapshot ? (
        <Skeleton className="h-32 w-full" />
      ) : settings ? (
        <>
          <ul className="-mx-5 divide-y border-y" aria-label="Серверы пула">
            {settings.servers.map((server) => (
              <PoolServerRow
                key={server.id}
                server={snapshot.servers.find((s) => s.id === server.id) ?? server}
                name={name(server.id)}
                probe={probes.find((p) => p.id === server.id)}
                checkedAt={snapshot.last_check}
                active={server.id === settings.selected_id}
                busy={busy !== null}
                selecting={busy === 'select' && selecting === server.id}
                onActivate={() => {
                  setSelecting(server.id)
                  void run(
                    'select',
                    'POST',
                    'xray/servers/select',
                    { id: server.id },
                    `Сервер «${name(server.id)}» активен. Xray перезапущен.`
                  )
                }}
              />
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            {settings.auto
              ? reserve
                ? `При сбое — ${name(reserve.id)} (${reserve.latency_ms} мс)`
                : 'При сбое переключаться не на что: другие серверы не отвечают'
              : 'Автопереключение выключено'}
            {snapshot.last_check && ` · проверено ${relativeTime(snapshot.last_check)}`}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={busy !== null}
            onClick={() => void run('check', 'POST', 'xray/servers/check', undefined, 'Проверка завершена')}
          >
            <IconActivityHeartbeat data-icon="inline-start" />
            {busy === 'check' ? 'Проверяем…' : 'Проверить все'}
          </Button>
        </>
      ) : (
        <>
          <CurrentOutbound
            name={snapshot.servers.find((s) => s.id === snapshot.active_id)?.name}
            activeSince={snapshot.active_since}
            bare
            outbound={current?.outbound}
            isDefault={!!current?.isDefault}
            rules={current?.rules ?? 0}
          />
          <div className="bg-accent flex flex-col gap-3 rounded-lg p-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm">Пул не настроен — добавьте запасные серверы, чтобы переключаться при сбое.</span>
            <Button size="sm" onClick={() => navigate('servers')}>
              Настроить пул
            </Button>
          </div>
        </>
      )}
    </Panel>
  )
}

/** A pool server in the same look as on the «Серверы» page, without the pool checkbox and menu. */
function PoolServerRow({
  server,
  name,
  probe,
  checkedAt,
  active,
  busy,
  selecting,
  onActivate,
}: {
  server: Server
  name: string
  probe: Probe | undefined
  checkedAt: string | null
  active: boolean
  busy: boolean
  selecting: boolean
  onActivate: () => void
}) {
  const meta = useMemo(() => extractMeta(server.outbound), [server.outbound])
  return (
    <li
      className={cn(
        'relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]',
        active && 'bg-primary/8 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-emerald-500'
      )}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot health={health(probe)} />
          <span className="truncate font-medium">{name}</span>
          <Badge variant="sky" className="shrink-0">
            {(meta.protocolLabel ?? meta.protocol).toUpperCase()}
          </Badge>
          {active && (
            <Badge variant="emerald" className="shrink-0">
              Активный
            </Badge>
          )}
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {endpoint(meta)} · {transportLine(meta)}
        </span>
      </span>
      <span className="flex flex-col items-end text-sm">
        {probe ? (
          probe.latency_ms !== null ? (
            <span className={cn('font-medium tabular-nums', delayColor(probe.latency_ms))}>{probe.latency_ms} мс</span>
          ) : (
            <span className="text-red-400">нет ответа</span>
          )
        ) : (
          <span className="text-muted-foreground">не проверен</span>
        )}
        {probe && checkedAt && <span className="text-muted-foreground text-xs">{relativeTime(checkedAt)}</span>}
      </span>
      <span className="col-span-2 flex justify-end sm:col-span-1">
        {!active && (
          <Button variant="outline" size="sm" disabled={busy} onClick={onActivate}>
            {selecting && <Spinner data-icon="inline-start" />}
            Сделать активным
          </Button>
        )}
      </span>
    </li>
  )
}

function MihomoConnectionPanel({ handle }: CardProps) {
  return (
    <Panel title="Подключение" id="overview-connection" handle={handle}>
      <p className="text-muted-foreground text-sm">Работает ядро Mihomo: группы прокси, соединения и DNS — в разделе «Конфигурация».</p>
      <Button variant="outline" className="w-fit" onClick={() => navigate('config')}>
        Открыть конфигурацию
      </Button>
    </Panel>
  )
}

function TrafficPanel({ handle, overview }: CardProps & { overview: RouterOverview | null }) {
  const samples = useTrafficStore((s) => s.samples)
  const width = 300
  const height = 90
  const now = samples.at(-1)?.t ?? 0
  // Until ten minutes are collected the chart spans what there is.
  const start = Math.max(now - TRAFFIC_WINDOW_MS, samples[0]?.t ?? now)
  const span = Math.max(now - start, 1)
  const top = Math.max(1_000_000, ...samples.map((s) => Math.max(s.xkeen, s.other))) * 1.1
  const line = (key: 'xkeen' | 'other') =>
    samples.map((s) => `${Math.round(((s.t - start) / span) * width)},${Math.round(height - (s[key] / top) * height)}`).join(' ')
  const total = (key: 'xkeen' | 'other') =>
    samples.reduce((sum, sample, i) => (i === 0 ? sum : sum + (sample[key] * (sample.t - samples[i - 1].t)) / 1000 / 8), 0)
  const latest = samples.at(-1)
  return (
    <Panel title="Трафик, 10 мин" id="overview-traffic" handle={handle}>
      {!overview ? (
        <Skeleton className="h-28 w-full" />
      ) : samples.length < 2 ? (
        <p className="text-muted-foreground text-sm">Собираем данные о скорости устройств…</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-24 w-full"
            preserveAspectRatio="none"
            role="img"
            aria-label="Скорость загрузки устройств из политики XKeen и остальных за 10 минут"
          >
            <polyline
              points={line('other')}
              fill="none"
              className="stroke-muted-foreground"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
            <polyline points={line('xkeen')} fill="none" className="stroke-primary" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="bg-primary h-0.5 w-4" />
              Устройства XKeen {latest && `${mbps(latest.xkeen)} Мбит/с`} · {formatBytes(total('xkeen'))}
            </span>
            <span className="text-muted-foreground flex items-center gap-1.5">
              <span aria-hidden className="border-muted-foreground h-0 w-4 border-t border-dashed" />
              Остальные {latest && `${mbps(latest.other)} Мбит/с`} · {formatBytes(total('other'))}
            </span>
          </div>
        </>
      )}
    </Panel>
  )
}

const DEVICES_SHOWN = 6

function DevicesPanel({
  handle,
  overview,
  onUpdate,
}: CardProps & { overview: RouterOverview | null; onUpdate: (next: RouterOverview) => void }) {
  const { showToast } = useAppActions()
  const speeds = useTrafficStore((s) => s.speeds)
  const [pending, setPending] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  async function toggle(device: RouterDevice, inXkeen: boolean) {
    setPending(device.mac)
    try {
      const result = await apiCall<RouterOverview>(
        'PUT',
        `overview/devices/${encodeURIComponent(device.mac)}`,
        { in_xkeen: inXkeen },
        { timeoutMs: 30000 }
      )
      if (!result.success) {
        showToast(result.error || 'Не удалось изменить политику устройства', 'error')
        return
      }
      onUpdate(result)
      showToast(inXkeen ? `«${device.name}» теперь ходит через XKeen` : `«${device.name}» теперь ходит напрямую`, 'success')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Нет связи с панелью', 'error')
    } finally {
      setPending(null)
    }
  }

  const relevant = overview?.devices.filter((device) => device.in_xkeen || device.active) ?? []
  const shown = expanded ? relevant : relevant.slice(0, DEVICES_SHOWN)
  return (
    <Panel
      title="Устройства"
      id="overview-devices"
      handle={handle}
      actions={<span className="text-muted-foreground text-xs">через XKeen</span>}
    >
      {!overview ? (
        <Skeleton className="h-40 w-full" />
      ) : !overview.success ? (
        <p className="text-muted-foreground text-sm">{overview.error || 'Роутер не отдал список устройств'}</p>
      ) : (
        <>
          {!overview.policy && (
            <p className="text-muted-foreground text-sm">
              В Keenetic нет политики доступа с описанием «XKeen»: XKeen перехватывает трафик всех устройств.
            </p>
          )}
          <ul className="-mx-5 divide-y border-y">
            {shown.map((device) => {
              const speed = speeds[device.mac] ?? 0
              return (
                <li key={device.mac} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                  <span
                    aria-label={device.active ? 'в сети' : 'не в сети'}
                    className={cn('size-2 shrink-0 rounded-full', device.active ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{device.name}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {device.ip && device.ip !== '0.0.0.0' ? device.ip : device.mac}
                    </span>
                  </span>
                  {speed >= 50_000 && <span className="text-muted-foreground text-xs tabular-nums">↓ {mbps(speed)}</span>}
                  {overview.policy && (
                    <Switch
                      checked={device.in_xkeen}
                      disabled={pending !== null || !device.registered}
                      onCheckedChange={(checked) => void toggle(device, checked)}
                      aria-label={`${device.name} через XKeen`}
                      title={device.registered ? undefined : 'Зарегистрируйте устройство в Keenetic, чтобы назначить политику'}
                    />
                  )}
                </li>
              )
            })}
          </ul>
          {relevant.length > DEVICES_SHOWN && (
            <Button variant="link" size="sm" className="w-fit px-0" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Свернуть' : `Показать все (${relevant.length})`}
            </Button>
          )}
        </>
      )}
    </Panel>
  )
}

function RouterPanel({ handle, stats, onOpenModal }: CardProps & { stats: SystemStats | null; onOpenModal: (modal: string) => void }) {
  const { state } = useAppContext()
  const coreName = state.currentCore === 'mihomo' ? 'Mihomo' : state.currentCore === 'xray' ? 'Xray' : '—'
  const cpu = stats?.cpuUsage ?? null
  const memPercent = stats?.memoryTotal ? Math.round(((stats.memoryUsed ?? 0) / stats.memoryTotal) * 100) : null
  return (
    <Panel title="Роутер и служба" id="overview-service" handle={handle}>
      <InfoGrid
        className="sm:grid-cols-2"
        items={[
          ['Ядро', `${coreName} ${state.coreVersions[state.currentCore] || ''}`.trim()],
          [
            'Обновление',
            state.isOutdatedCore ? (
              <Button key="update" variant="link" className="h-auto p-0" onClick={() => onOpenModal('showCoreManageModal')}>
                Доступна новая версия
              </Button>
            ) : (
              'Актуальна'
            ),
          ],
          ['Время жизни ядра', formatDuration(stats?.core?.uptimeSecs)],
          ['Время жизни роутера', formatDuration(stats?.uptime)],
        ]}
      />
      {stats ? (
        <div className="flex flex-col gap-3">
          <Meter label="Процессор" percent={cpu} detail={cpu == null ? '—' : `${cpu}%`} />
          <Meter
            label="Память роутера"
            percent={memPercent}
            detail={stats.memoryTotal ? `${mb(stats.memoryUsed ?? 0)} / ${mb(stats.memoryTotal)} МБ` : '—'}
          />
          {stats.core?.rssBytes != null && (
            <p className="text-muted-foreground text-xs">Ядро занимает {mb(stats.core.rssBytes)} МБ памяти</p>
          )}
        </div>
      ) : (
        <Skeleton className="h-16 w-full" />
      )}
    </Panel>
  )
}

/** Last warnings/errors of the core log: one short websocket read, then closed. */
function JournalPanel({ handle }: CardProps) {
  const [lines, setLines] = useState<string[] | null>(null)
  const load = useCallback(() => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${location.host}/ws/log?file=error.log`)
    const timer = setTimeout(() => socket.close(), 5000)
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type: string; lines?: string[] }
        const all = data.type === 'clear' ? [] : (data.lines ?? [])
        // Lines arrive pre-rendered as HTML for the log view; keep plain text only.
        const text = all.map((line) => new DOMParser().parseFromString(line, 'text/html').body.textContent?.trim() ?? '')
        setLines(text.filter((line) => /\b(warn(ing)?|error)\b/i.test(line)).slice(-5))
      } catch {
        setLines([])
      }
      socket.close()
    }
    socket.onerror = () => setLines((prev) => prev ?? [])
    return () => {
      clearTimeout(timer)
      socket.close()
    }
  }, [])
  useEffect(() => load(), [load])
  return (
    <Panel
      title="Журнал"
      id="overview-journal"
      handle={handle}
      actions={
        <Button variant="link" size="sm" className="px-0" onClick={() => navigate('logs')}>
          Открыть журнал →
        </Button>
      }
    >
      {lines === null ? (
        <Skeleton className="h-20 w-full" />
      ) : lines.length === 0 ? (
        <p className="text-muted-foreground text-sm">Ошибок и предупреждений нет.</p>
      ) : (
        <ul className="bg-input-background flex flex-col gap-1.5 rounded-md border p-3 font-mono text-xs">
          {lines.map((line, index) => (
            <li key={index} className="break-all">
              {line}
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" className="w-fit" onClick={() => load()}>
        <IconRefresh data-icon="inline-start" />
        Обновить
      </Button>
    </Panel>
  )
}

/* ─── Layout: two columns of cards, reordered by dragging the handle ───────── */

export type CardId = 'connection' | 'traffic' | 'devices' | 'router' | 'journal'
export type CardLayout = { left: CardId[]; right: CardId[] }

const CARD_IDS: CardId[] = ['connection', 'traffic', 'devices', 'router', 'journal']
export const DEFAULT_LAYOUT: CardLayout = { left: ['connection', 'devices'], right: ['traffic', 'router', 'journal'] }
const LAYOUT_KEY = 'xkeen-ui:overview-layout'

/** Saved order, with unknown ids dropped and new cards appended. */
export function normalizeLayout(value: unknown): CardLayout {
  const saved = value as Partial<CardLayout> | null
  if (!saved || !Array.isArray(saved.left) || !Array.isArray(saved.right)) return DEFAULT_LAYOUT
  const seen = new Set<CardId>()
  const keep = (ids: unknown[]) =>
    ids.filter((id): id is CardId => CARD_IDS.includes(id as CardId) && !seen.has(id as CardId) && !!seen.add(id as CardId))
  const left = keep(saved.left)
  const right = keep(saved.right)
  return { left, right: [...right, ...CARD_IDS.filter((id) => !seen.has(id))] }
}

function readLayout(): CardLayout {
  try {
    return normalizeLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null'))
  } catch {
    return DEFAULT_LAYOUT
  }
}

function saveLayout(layout: CardLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    /* the order then lasts until reload */
  }
}

/** Moves a card one step: up/down within its column, left/right to the other column. */
export function moveCard(layout: CardLayout, id: CardId, direction: 'up' | 'down' | 'left' | 'right'): CardLayout {
  const from = layout.left.includes(id) ? 'left' : 'right'
  const index = layout[from].indexOf(id)
  if (direction === 'up' || direction === 'down') {
    const target = index + (direction === 'up' ? -1 : 1)
    if (target < 0 || target >= layout[from].length) return layout
    const column = [...layout[from]]
    ;[column[index], column[target]] = [column[target], column[index]]
    return { ...layout, [from]: column }
  }
  const to = direction === 'left' ? 'left' : 'right'
  if (to === from) return layout
  const target = [...layout[to]]
  target.splice(Math.min(index, target.length), 0, id)
  return { ...layout, [from]: layout[from].filter((card) => card !== id), [to]: target } as CardLayout
}

function CardItem({
  id,
  onDrop,
  onMove,
  render,
}: {
  id: CardId
  onDrop: (id: CardId, point: { x: number; y: number }) => void
  onMove: (id: CardId, direction: 'up' | 'down' | 'left' | 'right') => void
  render: (id: CardId, handle: ReactNode) => ReactNode
}) {
  const controls = useDragControls()
  const keys: Record<string, 'up' | 'down' | 'left' | 'right'> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
  }
  const handle = (
    <button
      type="button"
      aria-label="Переместить карточку: перетащите или используйте стрелки"
      title="Перетащите, чтобы изменить порядок"
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -ml-1.5 cursor-grab touch-none rounded p-0.5 outline-none focus-visible:ring-3 active:cursor-grabbing"
      onPointerDown={(event) => controls.start(event)}
      onKeyDown={(event: KeyboardEvent) => {
        const direction = keys[event.key]
        if (!direction) return
        event.preventDefault()
        onMove(id, direction)
      }}
    >
      <IconGripVertical className="size-4" />
    </button>
  )
  return (
    <Reorder.Item
      as="div"
      value={id}
      dragListener={false}
      dragControls={controls}
      className="min-w-0"
      onDragEnd={(_: unknown, info: PanInfo) => onDrop(id, info.point)}
    >
      {render(id, handle)}
    </Reorder.Item>
  )
}

export function Overview({ isXray, onOpenModal }: { isXray: boolean; onOpenModal: (modal: string) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [candidates, setCandidates] = useState<Candidates | null>(null)
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [overview, setOverview] = useState<RouterOverview | null>(null)
  const [guard, setGuard] = useState<'on' | 'off' | 'inactive' | 'blocked' | null>(null)
  const [layout, setLayout] = useState<CardLayout>(readLayout)
  const columns = useRef<Record<'left' | 'right', HTMLDivElement | null>>({ left: null, right: null })
  const history = usePingHistoryStore((s) => s.history)
  const pushTraffic = useTrafficStore((s) => s.push)

  const loadPool = useCallback(async () => {
    try {
      const next = await apiCall<Snapshot>('GET', 'xray/servers', undefined, { timeoutMs: 15000 })
      if (next.success) setSnapshot(next)
      await fetchPingHistory()
    } catch {
      /* next poll retries */
    }
  }, [])
  const loadStats = useCallback(async () => {
    try {
      setStats(await apiCall<SystemStats>('GET', 'system', undefined, { timeoutMs: 10000 }))
    } catch {
      /* next poll retries */
    }
  }, [])
  const loadOverview = useCallback(async () => {
    try {
      const next = await apiCall<RouterOverview>('GET', 'overview', undefined, { timeoutMs: 10000 })
      setOverview(next)
      if (next.success) pushTraffic(next)
    } catch {
      /* next poll retries */
    }
  }, [pushTraffic])

  usePolling(loadPool, 10000, isXray)
  usePolling(loadStats, 5000)
  usePolling(loadOverview, 5000)
  useEffect(() => {
    if (!isXray) return
    void apiCall<Candidates>('GET', 'xray/servers/candidates')
      .then(setCandidates)
      .catch(() => {})
  }, [isXray])
  const guardRequest = useRef(0)
  const loadGuard = useCallback(async () => {
    const request = ++guardRequest.current
    try {
      const result = await apiCall<{ success: boolean; enabled: boolean; active: boolean; mode: string; health?: { blocked: boolean } }>(
        'GET',
        'traffic-guard'
      )
      if (request !== guardRequest.current) return
      setGuard(
        !result.success
          ? null
          : !result.enabled
            ? 'off'
            : !result.active
              ? 'inactive'
              : result.mode === 'strict' && result.health?.blocked !== false
                ? 'blocked'
                : 'on'
      )
    } catch {
      if (request === guardRequest.current) setGuard(null)
    }
  }, [])
  usePolling(loadGuard, 5000)

  const update = useCallback((next: CardLayout) => {
    setLayout(next)
    saveLayout(next)
  }, [])

  /** A card dropped over the other column moves there, before the card under the pointer. */
  const drop = useCallback(
    (id: CardId, point: { x: number; y: number }) => {
      const x = point.x - window.scrollX
      const y = point.y - window.scrollY
      const from = layout.left.includes(id) ? 'left' : 'right'
      const to = (['left', 'right'] as const).find((side) => {
        const rect = columns.current[side]?.getBoundingClientRect()
        return rect && x >= rect.left && x <= rect.right && y >= rect.top - 40 && y <= rect.bottom + 120
      })
      if (!to || to === from) return
      const children = Array.from(columns.current[to]?.children ?? [])
      const before = children.findIndex((child) => {
        const rect = child.getBoundingClientRect()
        return y < rect.top + rect.height / 2
      })
      const target = layout[to].filter((card) => card !== id)
      target.splice(before < 0 ? target.length : before, 0, id)
      update({ ...layout, [from]: layout[from].filter((card) => card !== id), [to]: target } as CardLayout)
    },
    [layout, update]
  )

  // Manual checks and manual mode leave results only in the shared ping history.
  const pool = snapshot && withHistory(snapshot, history)

  const render = (id: CardId, handle: ReactNode) => {
    switch (id) {
      case 'connection':
        return isXray ? (
          <ConnectionPanel handle={handle} snapshot={pool} candidates={candidates} reload={loadPool} />
        ) : (
          <MihomoConnectionPanel handle={handle} />
        )
      case 'traffic':
        return <TrafficPanel handle={handle} overview={overview} />
      case 'devices':
        return <DevicesPanel handle={handle} overview={overview} onUpdate={setOverview} />
      case 'router':
        return <RouterPanel handle={handle} stats={stats} onOpenModal={onOpenModal} />
      case 'journal':
        return <JournalPanel handle={handle} />
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-wider uppercase">Обзор</h1>
        <p className="text-muted-foreground text-sm">Подключение, трафик и устройства. Карточки можно перетаскивать за значок ⋮⋮.</p>
      </div>
      <Tiles isXray={isXray} snapshot={pool} overview={overview} guard={guard} />
      <div className="grid items-start gap-5 lg:grid-cols-2">
        {(['left', 'right'] as const).map((side) => (
          <Reorder.Group
            key={side}
            as="div"
            axis="y"
            values={layout[side]}
            onReorder={(ids: CardId[]) => update({ ...layout, [side]: ids })}
            ref={(element: HTMLDivElement | null) => {
              columns.current[side] = element
            }}
            className="flex min-h-24 min-w-0 flex-col gap-5"
          >
            {layout[side].map((id) => (
              <CardItem
                key={id}
                id={id}
                render={render}
                onDrop={drop}
                onMove={(card, direction) => update(moveCard(layout, card, direction))}
              />
            ))}
          </Reorder.Group>
        ))}
      </div>
    </div>
  )
}
