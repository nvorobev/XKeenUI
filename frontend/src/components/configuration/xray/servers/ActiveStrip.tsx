import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { IconChevronDown, IconPencil } from '@tabler/icons-react'
import { useState } from 'react'
import { cn } from '../../../../lib/utils'
import { InfoGrid, StatusPill, type PillTone } from '../../../shell/Panel'
import { endpoint, extractMeta, transportLine } from '../outboundMeta'
import { ConnectionLifetime } from './StatusBits'
import { health as healthOf, relativeTime, type Health, type Server, type Snapshot } from './model'

const tones: Record<Health, PillTone> = { ok: 'ok', failing: 'warn', down: 'bad', unknown: 'neutral' }

/** Compact «what carries traffic now» strip for the Servers page. */
export function ActiveStrip({
  server,
  snapshot,
  disabled,
  onEdit,
}: {
  server: Server
  snapshot: Snapshot
  disabled: boolean
  onEdit: () => void
}) {
  const [open, setOpen] = useState(false)
  const settings = snapshot.settings!
  const probe = snapshot.probes.find((p) => p.id === server.id)
  const health = healthOf(probe, snapshot.failures, settings.failure_threshold)
  const meta = extractMeta(server.outbound)
  const label =
    health === 'ok'
      ? `Работает · ${probe?.latency_ms} мс`
      : health === 'failing'
        ? `Сбои ${snapshot.failures}/${settings.failure_threshold}`
        : health === 'down'
          ? 'Не отвечает'
          : 'Ещё не проверен'
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="bg-card relative overflow-hidden rounded-lg border">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-emerald-500" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 pr-3 pl-5">
        <span className="text-xs font-bold tracking-wider text-emerald-600 uppercase dark:text-emerald-400">Активный</span>
        <span className="min-w-0 truncate font-medium">{server.name}</span>
        <StatusPill tone={snapshot.ready ? tones[health] : 'neutral'}>{snapshot.ready ? label : 'Проверка'}</StatusPill>
        <span className="text-muted-foreground hidden text-sm md:inline">
          {settings.auto ? `авто, после ${settings.failure_threshold} отказов` : 'ручной выбор'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Изменить конфиг активного сервера" disabled={disabled} onClick={onEdit}>
            <IconPencil />
          </Button>
          <CollapsibleTrigger
            render={
              <Button variant="ghost" size="sm">
                Подробнее
                <IconChevronDown data-icon="inline-end" className={cn('transition-transform', open && 'rotate-180')} />
              </Button>
            }
          />
        </div>
      </div>
      <CollapsibleContent className="border-t px-5 py-4">
        <InfoGrid
          layout="rows"
          items={[
            ['Протокол', (meta.protocolLabel ?? meta.protocol).toUpperCase()],
            ['Адрес', endpoint(meta)],
            ['Транспорт', transportLine(meta)],
            ['Трафик', `outbound «${settings.target_tag}»`],
            ['Режим', settings.auto ? `авто, после ${settings.failure_threshold} отказов` : 'ручной выбор'],
            ['Проверено', relativeTime(snapshot.last_check) || '—'],
            ['Время жизни', <ConnectionLifetime key="lifetime" since={snapshot.active_since} />],
            ['Переключено', relativeTime(snapshot.last_switch) || '—'],
          ]}
        />
        {probe?.error && <p className="text-destructive mt-3 text-xs break-all">{probe.error}</p>}
      </CollapsibleContent>
    </Collapsible>
  )
}
