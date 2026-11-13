import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { IconDots, IconPencil, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useMemo, type ReactElement } from 'react'
import { cn } from '../../../../lib/utils'
import { delayColor, endpoint, extractMeta, transportLine } from '../outboundMeta'
import { relativeTime, sampleHealth, type DraftStatus, type Sample, type Server } from './model'
import { StatusDot } from './StatusBits'

function Hint({ text, children }: { text: string; children: ReactElement }) {
  if (!text) return children
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{children}</span>} />
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

/** One server of the full list. Checkbox = in the pool (monitoring + failover); «Сделать активным» = carries traffic. */
export function ServerRow({
  server,
  inPool,
  sample,
  active,
  pendingActive,
  status,
  origin,
  pendingRemoval,
  checking,
  disabled,
  lockHint,
  onToggle,
  onActivate,
  onEdit,
  onCheck,
  onDelete,
}: {
  server: Server
  inPool: boolean
  sample: Sample | undefined
  active: boolean
  /** Chosen as active in the draft; applied on save. */
  pendingActive: boolean
  status: DraftStatus
  /** Config outbound tag the server came from; empty for servers added by link. */
  origin: string
  pendingRemoval: boolean
  checking: boolean
  disabled: boolean
  /** Why the pool checkbox is locked, or empty. */
  lockHint: string
  onToggle: (checked: boolean) => void
  onActivate: () => void
  onEdit: () => void
  onCheck: () => void
  onDelete: () => void
}) {
  const meta = useMemo(() => extractMeta(server.outbound), [server.outbound])
  const health = sampleHealth(sample)
  const id = `pool-${server.id}`
  const latency = checking ? (
    <Spinner className="ml-auto size-4" />
  ) : sample ? (
    sample.latency_ms !== null ? (
      <span className={cn('font-medium tabular-nums', delayColor(sample.latency_ms))}>{sample.latency_ms} мс</span>
    ) : (
      <span className="text-red-400">нет ответа</span>
    )
  ) : (
    <span className="text-muted-foreground">не проверен</span>
  )
  return (
    <li
      className={cn(
        'relative grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-5 py-3',
        'lg:grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,13rem)_7.5rem_11.5rem_2rem]',
        active && 'bg-primary/8 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-emerald-500',
        pendingRemoval && 'opacity-60'
      )}
    >
      <Hint text={lockHint}>
        <Checkbox
          id={id}
          checked={inPool}
          disabled={disabled || !!lockHint}
          aria-label={inPool ? `Убрать ${server.name} из пула` : `Добавить ${server.name} в пул`}
          onCheckedChange={(checked) => onToggle(checked === true)}
        />
      </Hint>

      <label htmlFor={id} className="flex min-w-0 cursor-pointer flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <StatusDot health={health} />
          <span className={cn('truncate font-medium', pendingRemoval && 'line-through')}>{server.name}</span>
          <Badge variant="sky" className="shrink-0">
            {(meta.protocolLabel ?? meta.protocol).toUpperCase()}
          </Badge>
          {active && (
            <Badge variant="emerald" className="shrink-0">
              Активный
            </Badge>
          )}
          {pendingActive && (
            <Badge variant="amber" className="shrink-0">
              Станет активным
            </Badge>
          )}
          {pendingRemoval && (
            <Badge variant="rose" className="shrink-0">
              Будет исключён из пула
            </Badge>
          )}
          {!pendingRemoval && status === 'new' && inPool && (
            <Badge variant="amber" className="shrink-0">
              Новый
            </Badge>
          )}
          {!pendingRemoval && status === 'changed' && (
            <Badge variant="amber" className="shrink-0">
              Изменён
            </Badge>
          )}
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {origin ? `из конфига «${origin}»` : 'добавлен по ссылке'}
          <span className="lg:hidden"> · {transportLine(meta)}</span>
        </span>
      </label>

      <span className="hidden min-w-0 flex-col text-xs lg:flex">
        <span className="truncate">{endpoint(meta)}</span>
        <span className="text-muted-foreground truncate">{transportLine(meta)}</span>
      </span>

      <span className="flex flex-col items-end text-sm lg:items-end">
        {latency}
        {sample?.average_ms != null && (
          <span className="text-muted-foreground text-[11px]">
            средний {sample.average_ms} мс · {sample.checks} пров.
          </span>
        )}
        {sample?.time && !checking && <span className="text-muted-foreground text-[11px]">{relativeTime(sample.time)}</span>}
      </span>

      <div className="col-span-3 flex items-center justify-end gap-1.5 pl-8 lg:col-span-2 lg:pl-0">
        {!active && !pendingActive && !pendingRemoval && (
          <Button size="sm" variant="outline" className="lg:min-w-0 lg:flex-1" disabled={disabled} onClick={onActivate}>
            Сделать активным
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="icon-sm" variant="ghost" aria-label={`Действия: ${server.name}`} disabled={disabled}>
                <IconDots />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onCheck}>
                <IconRefresh />
                Проверить
              </DropdownMenuItem>
              {!server.id.startsWith('config:') && (
                <DropdownMenuItem onClick={onEdit}>
                  <IconPencil />
                  Изменить конфиг
                </DropdownMenuItem>
              )}
              {!origin && !inPool && !pendingRemoval && !active && (
                <DropdownMenuItem className="text-destructive" onClick={onDelete}>
                  <IconTrash />
                  Удалить
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}
