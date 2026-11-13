import { useNowStore } from '../../../../lib/store'
import { cn } from '../../../../lib/utils'
import { delayColor } from '../outboundMeta'
import type { Health, Probe } from './model'

const dotColor: Record<Health, string> = {
  ok: 'bg-emerald-500',
  failing: 'bg-amber-500',
  down: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
}

export function StatusDot({ health, className }: { health: Health; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2.5 shrink-0 rounded-full', dotColor[health], className)} />
}

export function Latency({ probe, className }: { probe: Probe | undefined; className?: string }) {
  if (!probe) return <span className={cn('text-muted-foreground tabular-nums', className)}>—</span>
  if (probe.latency_ms === null) return <span className={cn('text-red-400', className)}>нет ответа</span>
  return <span className={cn('font-medium tabular-nums', delayColor(probe.latency_ms), className)}>{probe.latency_ms} мс</span>
}

export function ConnectionLifetime({ since }: { since?: string | null }) {
  // One app-wide clock instead of a timer per row.
  const now = useNowStore((s) => s.now)
  const started = since ? Date.parse(since) : NaN
  if (!Number.isFinite(started)) return <span>—</span>
  const elapsed = Math.max(0, Math.floor((now - started) / 1000))
  const days = Math.floor(elapsed / 86400)
  const time = [Math.floor(elapsed / 3600) % 24, Math.floor(elapsed / 60) % 60, elapsed % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
  return (
    <span className="tabular-nums">
      {days > 0 ? `${days} д ` : ''}
      {time}
    </span>
  )
}
