import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { IconPencil, IconRefresh } from '@tabler/icons-react'
import { cn } from '../../../../lib/utils'
import { InfoGrid, StatusPill, type PillTone } from '../../../shell/Panel'
import { extractMeta } from '../outboundMeta'
import { health as healthOf, relativeTime, type Health, type Outbound, type Server, type Snapshot } from './model'
import { ConnectionLifetime, Latency } from './StatusBits'

const tones: Record<Health, PillTone> = { ok: 'ok', failing: 'warn', down: 'bad', unknown: 'neutral' }

function Frame({ bare, children }: { bare?: boolean; children: React.ReactNode }) {
  return <div className={cn('flex flex-col gap-5', !bare && 'bg-input-background rounded-lg border p-4 sm:p-5')}>{children}</div>
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="border-primary/50 text-primary"
    >
      {children}
    </Button>
  )
}

function details(outbound: Outbound): [string, React.ReactNode][] {
  const meta = extractMeta(outbound)
  const rows: [string, React.ReactNode][] = [
    ['Адрес', meta.address ?? '—'],
    ['Порт', meta.port ?? '—'],
    ['Транспорт', meta.network ?? 'tcp'],
    ['Защита', meta.security && meta.security !== 'none' ? meta.security : 'нет'],
  ]
  if (meta.sni) rows.push(['SNI', meta.sni])
  if (meta.flow) rows.push(['Flow', meta.flow])
  return rows
}

/** Active server of a configured pool: what carries traffic right now. */
export function CurrentServer({
  server,
  snapshot,
  checking,
  disabled,
  bare,
  onCheck,
  onEdit,
}: {
  server: Server
  snapshot: Snapshot
  checking: boolean
  disabled: boolean
  bare?: boolean
  onCheck: () => void
  onEdit: () => void
}) {
  const settings = snapshot.settings!
  const probe = snapshot.probes.find((p) => p.id === server.id)
  const health = healthOf(probe, snapshot.failures, settings.failure_threshold)
  const meta = extractMeta(server.outbound)
  const busy = checking || !snapshot.ready
  const label = busy
    ? 'Проверка'
    : health === 'ok'
      ? `Работает · ${probe?.latency_ms} мс`
      : health === 'failing'
        ? `Сбои ${snapshot.failures}/${settings.failure_threshold}`
        : health === 'down'
          ? 'Не отвечает'
          : 'Ещё не проверен'
  return (
    <Frame bare={bare}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-lg font-medium break-all">{server.name}</h3>
          <p className="text-muted-foreground text-sm">
            {(meta.protocolLabel ?? meta.protocol).toUpperCase()} · трафик «{settings.target_tag}» ·{' '}
            {settings.auto ? `автопереключение после ${settings.failure_threshold} отказов` : 'ручной выбор'}
          </p>
          <StatusPill tone={busy ? 'neutral' : tones[health]}>
            {checking && <Spinner className="size-3" />}
            {label}
          </StatusPill>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <IconAction label="Проверить сейчас" disabled={disabled} onClick={onCheck}>
            <IconRefresh />
          </IconAction>
          <IconAction label="Изменить конфиг" disabled={disabled} onClick={onEdit}>
            <IconPencil />
          </IconAction>
        </div>
      </div>
      <InfoGrid
        layout="rows"
        items={[
          ...details(server.outbound),
          ['Время жизни', <ConnectionLifetime key="lifetime" since={snapshot.active_since} />],
          ['Задержка', <Latency key="latency" probe={probe} />],
          ['Проверено', relativeTime(snapshot.last_check) || '—'],
          ['Переключено', relativeTime(snapshot.last_switch) || '—'],
        ]}
      />
      {probe?.error && <p className="text-destructive text-xs break-all">{probe.error}</p>}
    </Frame>
  )
}

/** Before setup: which existing outbound carries proxy traffic today. */
export function CurrentOutbound({
  outbound,
  name,
  activeSince,
  isDefault,
  rules,
  bare,
}: {
  outbound: Outbound | undefined
  name?: string
  activeSince?: string | null
  isDefault: boolean
  rules: number
  bare?: boolean
}) {
  if (!outbound)
    return (
      <Frame bare={bare}>
        <p className="text-muted-foreground text-sm">В конфигах не найден proxy outbound, которым можно управлять.</p>
      </Frame>
    )
  const meta = extractMeta(outbound)
  const usage = [isDefault ? 'выход по умолчанию' : '', rules > 0 ? `правил: ${rules}` : ''].filter(Boolean).join(' · ')
  return (
    <Frame bare={bare}>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-lg font-medium break-all">{name || String(outbound.tag)}</h3>
        <p className="text-muted-foreground text-sm">
          {(meta.protocolLabel ?? meta.protocol).toUpperCase()} · outbound из ваших конфигов{usage && ` · ${usage}`}
        </p>
        <StatusPill tone="neutral">Без пула серверов</StatusPill>
      </div>
      <InfoGrid layout="rows" items={[...details(outbound), ['Время жизни', <ConnectionLifetime key="lifetime" since={activeSince} />]]} />
    </Frame>
  )
}
