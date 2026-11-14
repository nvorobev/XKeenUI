import { useMemo, useState, type ReactNode } from 'react'
import { navigate } from '../../lib/navigation'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Panel } from './Panel'
import { DEVICE_TRAFFIC_WINDOW_MS, intervalOverlap, type DeviceTrafficInterval } from './trafficHistory'

const TOP_DEVICES = 5

type DeviceTraffic = { mac: string; name: string; rx: number; tx: number }

export function summarizeDeviceTraffic(
  intervals: DeviceTrafficInterval[],
  windowMs = DEVICE_TRAFFIC_WINDOW_MS,
  end = intervals.at(-1)?.end ?? 0
) {
  const byDevice = new Map<string, DeviceTraffic>()
  const cutoff = end - windowMs
  for (const interval of intervals) {
    if (interval.end <= cutoff || interval.end <= interval.start) continue
    // Counters are sampled, so estimate the part of the oldest interval inside the window.
    const fraction = intervalOverlap(interval.start, interval.end, cutoff, interval.end) / (interval.end - interval.start)
    for (const device of interval.devices) {
      const previous = byDevice.get(device.mac)
      byDevice.set(device.mac, {
        ...device,
        rx: (previous?.rx ?? 0) + device.rx * fraction,
        tx: (previous?.tx ?? 0) + device.tx * fraction,
      })
    }
  }
  const ranked = [...byDevice.values()].sort((a, b) => b.rx + b.tx - (a.rx + a.tx) || a.mac.localeCompare(b.mac))
  const total = ranked.reduce((sum, device) => ({ rx: sum.rx + device.rx, tx: sum.tx + device.tx }), { rx: 0, tx: 0 })
  const rows = ranked.slice(0, TOP_DEVICES)
  if (ranked.length > TOP_DEVICES) {
    const others = ranked.slice(TOP_DEVICES).reduce((sum, device) => ({ rx: sum.rx + device.rx, tx: sum.tx + device.tx }), {
      rx: 0,
      tx: 0,
    })
    rows.push({ mac: 'other', name: 'Другие клиенты', ...others })
  }
  return { rows, total }
}

export const trafficColors = [
  'text-violet-500 dark:text-violet-400',
  'text-cyan-600 dark:text-cyan-400',
  'text-rose-600 dark:text-rose-400',
  'text-amber-600 dark:text-amber-400',
  'text-teal-600 dark:text-teal-400',
  'text-muted-foreground',
]
const decimal = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 })

export function formatVolume(bytes: number) {
  if (bytes >= 1024 ** 3) return `${decimal.format(bytes / 1024 ** 3)} ГБ`
  if (bytes >= 1024 ** 2) return `${decimal.format(bytes / 1024 ** 2)} МБ`
  if (bytes >= 1024) return `${decimal.format(bytes / 1024)} КБ`
  return `${Math.round(bytes)} Б`
}

export function TrafficDonut({
  rows,
  bytes,
  active,
  onActive,
  format = formatVolume,
  className,
}: {
  rows: DeviceTraffic[]
  bytes: number
  active: string | null
  onActive: (key: string | null) => void
  format?: (value: number) => string
  className?: string
}) {
  const selected = rows.findIndex((row) => row.mac === active)
  const row = rows[selected]
  return (
    <div className={cn('relative mx-auto size-28', className)}>
      <svg viewBox="0 0 100 100" className="block size-full" role="group" aria-label="Распределение трафика по устройствам">
        {rows.map((device, index) => {
          const share = ((device.rx + device.tx) / bytes) * 100
          const previousBytes = rows.slice(0, index).reduce((sum, previous) => sum + previous.rx + previous.tx, 0)
          return (
            <circle
              key={device.mac}
              cx="50"
              cy="50"
              r="36"
              pathLength="100"
              fill="none"
              stroke="currentColor"
              strokeDasharray={`${share} ${100 - share}`}
              strokeDashoffset={(-previousBytes / bytes) * 100}
              transform="rotate(-90 50 50)"
              tabIndex={0}
              aria-label={`${device.name}, ${decimal.format(share)} %, вход ${format(device.rx)}, выход ${format(device.tx)}`}
              className={cn(
                'cursor-default stroke-[22] transition-[opacity,stroke-width] outline-none motion-reduce:transition-none',
                trafficColors[index],
                selected === index ? 'stroke-[28]' : selected >= 0 && 'opacity-45'
              )}
              onPointerEnter={() => onActive(device.mac)}
              onPointerLeave={() => onActive(null)}
              onFocus={() => onActive(device.mac)}
              onBlur={() => onActive(null)}
            />
          )
        })}
      </svg>
      {row && (
        <div
          role="tooltip"
          className="bg-popover text-popover-foreground pointer-events-none absolute top-1/2 left-1/2 z-20 w-max max-w-[min(15rem,80vw)] -translate-x-1/2 -translate-y-1/2 rounded-md border px-3 py-2 text-xs shadow-lg"
        >
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-sm bg-current', trafficColors[selected])} />
            <span className="min-w-0 truncate">{row.name}</span>
            <span className="text-muted-foreground shrink-0">{decimal.format(((row.rx + row.tx) / bytes) * 100)} %</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2 tabular-nums">
            <span>↓ {format(row.rx)}</span>
            <span>↑ {format(row.tx)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export function DeviceTrafficPanel({
  handle,
  intervals,
  available,
}: {
  handle: ReactNode
  intervals: DeviceTrafficInterval[]
  available?: boolean
}) {
  const { rows, total } = useMemo(() => summarizeDeviceTraffic(intervals), [intervals])
  const bytes = total.rx + total.tx
  const [active, setActive] = useState<string | null>(null)

  return (
    <Panel
      title="Монитор трафика"
      id="overview-device-traffic"
      handle={handle}
      actions={
        <Button variant="link" size="sm" className="px-0" onClick={() => navigate('traffic')}>
          Подробнее →
        </Button>
      }
    >
      <p className="text-muted-foreground text-sm">Трафик устройств за последние 3 минуты</p>
      {available === false || bytes === 0 ? (
        <p className="text-muted-foreground text-sm" role="status">
          {available === false
            ? 'Данные об устройствах недоступны.'
            : intervals.length
              ? 'За время наблюдения трафика пока нет.'
              : 'Собираем данные о трафике устройств…'}
        </p>
      ) : (
        <div className="@container">
          <div className="grid min-w-0 items-center gap-5 @md:grid-cols-[auto_minmax(0,1fr)]">
            <TrafficDonut rows={rows} bytes={bytes} active={active} onActive={setActive} />
            <table className="w-full table-fixed text-sm tabular-nums">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th scope="col" className="pb-2 text-left font-normal">
                    Устройство
                  </th>
                  <th scope="col" className="w-20 pb-2 text-right font-normal" title="Входящий трафик">
                    ↓ Вход
                  </th>
                  <th scope="col" className="w-20 pb-2 text-right font-normal" title="Исходящий трафик">
                    ↑ Выход
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y border-y">
                {rows.map((row, index) => (
                  <tr
                    key={row.mac}
                    className={cn(active === row.mac && 'bg-muted')}
                    onPointerEnter={() => setActive(row.mac)}
                    onPointerLeave={() => setActive(null)}
                  >
                    <th scope="row" className="py-2 pr-2 text-left font-medium">
                      <div className="flex min-w-0 items-center gap-2">
                        <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-sm bg-current', trafficColors[index])} />
                        <span className="truncate" title={row.name}>
                          {row.name}
                        </span>
                      </div>
                    </th>
                    <td className="text-right whitespace-nowrap">{formatVolume(row.rx)}</td>
                    <td className="text-right whitespace-nowrap">{formatVolume(row.tx)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="font-semibold">
                <tr>
                  <th scope="row" className="pt-2 text-left">
                    Всего
                  </th>
                  <td className="pt-2 text-right whitespace-nowrap">{formatVolume(total.rx)}</td>
                  <td className="pt-2 text-right whitespace-nowrap">{formatVolume(total.tx)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </Panel>
  )
}
