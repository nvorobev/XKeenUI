import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/** Cabinet card: bold uppercase heading, optional actions on the right. */
export function Panel({
  title,
  actions,
  handle,
  children,
  className,
  id,
}: {
  title: ReactNode
  actions?: ReactNode
  /** Drag handle shown before the title (reorderable cards). */
  handle?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section aria-labelledby={id} className={cn('bg-card flex flex-col rounded-lg border', className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {handle}
          <h2 id={id} className="text-[15px] font-bold tracking-wider uppercase">
            {title}
          </h2>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className="flex flex-col gap-4 px-5 pb-5">{children}</div>
    </section>
  )
}

export type PillTone = 'ok' | 'warn' | 'bad' | 'neutral'
const pillTone: Record<PillTone, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  bad: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
  neutral: 'border-border bg-muted text-muted-foreground',
}

/** Status plate like "● ПОДКЛЮЧЕНО 01:03:16". */
export function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-2 rounded border px-2.5 py-1 text-xs font-medium tracking-wide uppercase',
        pillTone[tone]
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  )
}

/** Label → value grid used on cabinet cards. */
export function InfoGrid({
  items,
  className,
  layout = 'grid',
}: {
  items: [string, ReactNode][]
  className?: string
  layout?: 'grid' | 'rows'
}) {
  return (
    <dl className={cn(layout === 'rows' ? 'flex flex-col gap-3' : 'grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4', className)}>
      {items.map(([label, value]) => (
        <div key={label} className={cn('flex min-w-0', layout === 'rows' ? 'gap-x-6' : 'flex-col gap-1')}>
          <dt className={cn('text-muted-foreground text-sm', layout === 'rows' && 'w-28 shrink-0')}>{label}</dt>
          <dd className="min-w-0 text-sm break-all">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
