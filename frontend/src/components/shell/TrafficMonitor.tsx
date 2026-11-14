import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import { formatVolume, summarizeDeviceTraffic, trafficColors, TrafficDonut } from './DeviceTrafficPanel'
import { Panel } from './Panel'
import {
  DAY_MS,
  DEVICE_TRAFFIC_WINDOW_MS,
  intervalOverlap,
  useRouterOverview,
  useTrafficStore,
  type DeviceTrafficInterval,
} from './trafficHistory'

const periods = [
  { duration: DEVICE_TRAFFIC_WINDOW_MS, label: '3 мин' },
  { duration: 60 * 60_000, label: '1 час' },
  { duration: 180 * 60_000, label: '3 часа' },
  { duration: DAY_MS, label: '1 день' },
]
const modes = [
  { value: 'speed', label: 'Скорость' },
  { value: 'volume', label: 'Трафик' },
] as const
type Mode = (typeof modes)[number]['value']
const digits = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 })
const time = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const shortTime = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' })

function formatSpeed(bps: number) {
  if (bps >= 1e9) return `${digits.format(bps / 1e9)} Гбит/с`
  if (bps >= 1e6) return `${digits.format(bps / 1e6)} Мбит/с`
  if (bps >= 1e3) return `${digits.format(bps / 1e3)} кбит/с`
  return `${digits.format(bps)} бит/с`
}

export function buildTrafficChart(history: DeviceTrafficInterval[], keys: string[], from: number, to: number, mode: Mode, count = 36) {
  const step = (to - from) / count
  const slots = Array.from({ length: count }, (_, index) => ({
    start: from + index * step,
    end: from + (index + 1) * step,
    measuredMs: 0,
    volumes: keys.map(() => 0),
  }))
  const indexes = new Map(keys.map((key, index) => [key, index]))
  const other = indexes.get('other')
  for (const interval of history) {
    if (interval.end <= from || interval.start >= to || interval.end <= interval.start) continue
    const span = interval.end - interval.start
    const first = Math.max(0, Math.floor((interval.start - from) / step))
    const last = Math.min(count - 1, Math.ceil((interval.end - from) / step) - 1)
    for (let index = first; index <= last; index++) {
      const slot = slots[index]
      const fraction = intervalOverlap(interval.start, interval.end, slot.start, slot.end) / span
      slot.measuredMs += (interval.measuredMs ?? span) * fraction
      for (const device of interval.devices) {
        const series = indexes.get(device.mac) ?? other
        if (series !== undefined) slot.volumes[series] += (device.rx + device.tx) * fraction
      }
    }
  }
  return slots.map(({ volumes, measuredMs, ...slot }) => ({
    ...slot,
    measuredMs,
    values: mode === 'speed' && measuredMs > 0 ? volumes.map((bytes) => (bytes * 8000) / measuredMs) : volumes,
  }))
}

function TrafficBars({
  slots,
  keys,
  active,
  onActive,
  format,
  formatTime,
}: {
  slots: ReturnType<typeof buildTrafficChart>
  keys: string[]
  active: string | null
  onActive: (key: string | null) => void
  format: (value: number) => string
  formatTime: (timestamp: number) => string
}) {
  const peak = Math.max(1, ...slots.map((slot) => slot.values.reduce((sum, value) => sum + value, 0)))
  const unit = 10 ** Math.floor(Math.log10(peak))
  const ceiling = Math.ceil(peak / unit) * unit
  return (
    <div className="min-w-0" role="group" aria-label="График входящего и исходящего трафика по времени">
      <div className="relative grid h-60 grid-cols-[auto_minmax(0,1fr)] gap-2 sm:h-80">
        <div className="text-muted-foreground flex flex-col justify-between text-right text-[11px] tabular-nums sm:text-xs">
          {[1, 0.75, 0.5, 0.25, 0].map((fraction) => (
            <span key={fraction}>{format(fraction * ceiling)}</span>
          ))}
        </div>
        <div className="relative min-w-0 border-b">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            {[0, 1, 2, 3, 4].map((line) => (
              <span key={line} className="border-t" />
            ))}
          </div>
          <svg viewBox={`0 0 ${slots.length * 10} 100`} preserveAspectRatio="none" className="absolute inset-0 size-full">
            {slots.map((slot, column) => (
              <g key={slot.start}>
                {slot.values.map((value, index) => {
                  if (value <= 0) return null
                  const previous = slot.values.slice(0, index + 1).reduce((sum, part) => sum + part, 0)
                  return (
                    <rect
                      key={keys[index]}
                      x={column * 10 + 0.4}
                      y={100 - (previous * 100) / ceiling}
                      width={9.2}
                      height={(value * 100) / ceiling}
                      fill="currentColor"
                      className={cn(trafficColors[index], active && active !== keys[index] && 'opacity-35')}
                      onPointerEnter={() => onActive(keys[index])}
                      onPointerLeave={() => onActive(null)}
                    >
                      <title>{`${formatTime(slot.start)} – ${formatTime(slot.end)} · ${format(value)}`}</title>
                    </rect>
                  )
                })}
              </g>
            ))}
          </svg>
        </div>
      </div>
      <div className="text-muted-foreground flex justify-between gap-1 pt-2 pl-20 text-[11px] tabular-nums sm:text-xs">
        {[0, Math.floor(slots.length / 2), slots.length].map((index) => (
          <span key={index}>{formatTime(slots[index]?.start ?? slots[slots.length - 1].end)}</span>
        ))}
      </div>
    </div>
  )
}

export function TrafficMonitor() {
  const overview = useRouterOverview((state) => state.overview)
  const recent = useTrafficStore((state) => state.deviceIntervals)
  const history = useTrafficStore((state) => state.minuteHistory)
  const latest = useTrafficStore((state) => state.last?.t)
  const [duration, setDuration] = useState(DEVICE_TRAFFIC_WINDOW_MS)
  const [mode, setMode] = useState<Mode>('speed')
  const [policy, setPolicy] = useState(false)
  const [device, setDevice] = useState('all')
  const [active, setActive] = useState<string | null>(null)
  const source = duration === DEVICE_TRAFFIC_WINDOW_MS ? recent : history
  const to = latest ?? 0
  const from = to - duration
  const choices = useMemo(() => {
    const byMac = new Map<string, string>()
    for (const interval of source) {
      if (interval.end <= from) continue
      for (const row of interval.devices) if (!policy || row.inXkeen) byMac.set(row.mac, row.name)
    }
    for (const row of overview?.success ? overview.devices : []) {
      if (!policy || row.in_xkeen) byMac.set(row.mac, row.name)
    }
    return [
      { value: 'all', label: 'Топ-5 устройств' },
      ...[...byMac].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
    ]
  }, [from, overview, policy, source])
  const selected = choices.some((choice) => choice.value === device) ? device : 'all'
  const filtered = useMemo(
    () =>
      source
        .filter((interval) => interval.end > from)
        .map((interval) => ({
          ...interval,
          devices: interval.devices.filter((row) => (!policy || row.inXkeen) && (selected === 'all' || row.mac === selected)),
        })),
    [from, policy, selected, source]
  )
  const { total, rows } = useMemo(() => summarizeDeviceTraffic(filtered, duration, to), [filtered, duration, to])
  const keys = useMemo(() => rows.map((row) => row.mac), [rows])
  const slots = useMemo(() => buildTrafficChart(filtered, keys, from, to, mode), [filtered, keys, from, to, mode])
  const measuredMs = slots.reduce((sum, slot) => sum + slot.measuredMs, 0)
  const bytes = total.rx + total.tx
  const format = mode === 'speed' ? formatSpeed : formatVolume
  const average = (value: number) => (mode === 'speed' ? (value * 8000) / Math.max(measuredMs, 1) : value)
  const summary = rows.map((row) => ({ ...row, rx: average(row.rx), tx: average(row.tx) }))
  const formatTime = (timestamp: number) => (duration === DEVICE_TRAFFIC_WINDOW_MS ? time : shortTime).format(timestamp)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-wider uppercase">Монитор трафика</h1>
        <p className="text-muted-foreground text-sm">
          Входящий и исходящий трафик по счётчикам роутера. История собирается, пока открыт «Обзор» или «Монитор трафика».
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select items={choices} value={selected} onValueChange={setDevice}>
          <SelectTrigger popper className="max-w-64" aria-label="Устройство">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start" className="max-w-[calc(100vw-2rem)]">
            {choices.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ButtonGroup aria-label="Устройства по политике">
          <Button variant={policy ? 'outline' : 'default'} aria-pressed={!policy} onClick={() => setPolicy(false)}>
            Все устройства
          </Button>
          <Button variant={policy ? 'default' : 'outline'} aria-pressed={policy} onClick={() => setPolicy(true)}>
            Политика XKeen
          </Button>
        </ButtonGroup>
      </div>
      <div className="flex flex-wrap gap-3">
        <ButtonGroup aria-label="Показатель">
          {modes.map(({ value, label }) => (
            <Button
              key={value}
              variant={mode === value ? 'default' : 'outline'}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {label}
            </Button>
          ))}
        </ButtonGroup>
        <ButtonGroup aria-label="Период">
          {periods.map((period) => (
            <Button
              key={period.duration}
              variant={duration === period.duration ? 'default' : 'outline'}
              aria-pressed={duration === period.duration}
              onClick={() => setDuration(period.duration)}
            >
              {period.label}
            </Button>
          ))}
        </ButtonGroup>
      </div>
      {overview?.success !== false && measuredMs > 0 ? (
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <Panel title={mode === 'speed' ? 'Скорость по времени' : 'Трафик по времени'}>
            <TrafficBars slots={slots} keys={keys} active={active} onActive={setActive} format={format} formatTime={formatTime} />
            {bytes === 0 && (
              <p className="text-muted-foreground text-sm" role="status">
                За этот период трафика нет.
              </p>
            )}
          </Panel>
          <Panel title={mode === 'speed' ? 'Средняя скорость' : 'Общий трафик'}>
            <div className="flex flex-wrap justify-between gap-2 border-b pb-3 text-sm tabular-nums">
              <span aria-label="Входящий трафик">↓ {format(average(total.rx))}</span>
              <span aria-label="Исходящий трафик">↑ {format(average(total.tx))}</span>
            </div>
            {bytes > 0 && (
              <>
                <TrafficDonut
                  rows={summary}
                  bytes={average(bytes)}
                  active={active}
                  onActive={setActive}
                  format={format}
                  className="size-36"
                />
                <ul className="divide-y text-sm">
                  {summary.map((row, index) => (
                    <li
                      key={row.mac}
                      className={cn('flex items-start gap-2 py-2', active === row.mac && 'bg-muted')}
                      onPointerEnter={() => setActive(row.mac)}
                      onPointerLeave={() => setActive(null)}
                    >
                      <span aria-hidden="true" className={cn('mt-1.5 size-2.5 shrink-0 rounded-sm bg-current', trafficColors[index])} />
                      <div className="min-w-0">
                        <div className="truncate" title={row.name}>
                          {row.name}
                        </div>
                        <div className="text-muted-foreground flex flex-wrap gap-x-2 text-xs tabular-nums">
                          <span>↓ {format(row.rx)}</span>
                          <span>↑ {format(row.tx)}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
        </div>
      ) : (
        <Panel title="Трафик устройств">
          <p className="text-muted-foreground text-sm" role="status">
            {overview?.success === false ? 'Данные об устройствах недоступны.' : 'Собираем данные о трафике устройств…'}
          </p>
        </Panel>
      )}
    </div>
  )
}
