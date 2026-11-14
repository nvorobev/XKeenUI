import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { IconGripVertical, IconRefresh, IconSettings } from '@tabler/icons-react'
import { LayoutGroup, motion, useDragControls, useReducedMotion } from 'framer-motion'
import { useId, useRef, useState, type ReactNode } from 'react'
import { cn } from '../../lib/utils'

const titles = {
  connection: 'Подключение',
  devices: 'Устройства',
  'device-traffic': 'Монитор трафика',
  traffic: 'Трафик, 10 мин',
  router: 'Роутер и служба',
  journal: 'Журнал',
}

export type CardId = keyof typeof titles
type Side = 'left' | 'right'
type Direction = Side | 'up' | 'down'
export type CardLayout = Record<Side, CardId[]>
type LayoutPreferences = CardLayout & { hidden: CardId[] }
type Destination = { side: Side; before: CardId | null }

const SIDES = ['left', 'right'] as const
const CARD_IDS = Object.keys(titles) as CardId[]
export const DEFAULT_LAYOUT: CardLayout = { left: ['connection', 'devices'], right: ['device-traffic', 'traffic', 'router', 'journal'] }
const defaults: LayoutPreferences = { ...DEFAULT_LAYOUT, hidden: [] }
const LAYOUT_KEY = 'xkeen-ui:overview-layout'

export function normalizeLayout(value: unknown): CardLayout {
  const saved = value as Partial<CardLayout> | null
  if (!saved || !Array.isArray(saved.left) || !Array.isArray(saved.right)) return DEFAULT_LAYOUT
  const seen = new Set<CardId>()
  const keep = (ids: unknown[]) =>
    ids.filter((id): id is CardId => CARD_IDS.includes(id as CardId) && !seen.has(id as CardId) && !!seen.add(id as CardId))
  const left = keep(saved.left)
  const right = keep(saved.right)
  if (!seen.has('device-traffic')) {
    const column = left.includes('traffic') ? left : right
    column.splice(Math.max(0, column.indexOf('traffic')), 0, 'device-traffic')
    seen.add('device-traffic')
  }
  return { left, right: [...right, ...CARD_IDS.filter((id) => !seen.has(id))] }
}

export function normalizeOverviewPreferences(value: unknown): LayoutPreferences {
  const hidden = (value as Partial<LayoutPreferences> | null)?.hidden
  return { ...normalizeLayout(value), hidden: Array.isArray(hidden) ? CARD_IDS.filter((id) => hidden.includes(id)) : [] }
}

function readPreferences() {
  try {
    return normalizeOverviewPreferences(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null'))
  } catch {
    return defaults
  }
}

export function placeCard(layout: CardLayout, id: CardId, { side, before }: Destination): CardLayout {
  const from = layout.left.includes(id) ? 'left' : 'right'
  const source = layout[from]
  if (from === side && (source[source.indexOf(id) + 1] ?? null) === before) return layout
  const target = layout[side].filter((card) => card !== id)
  const index = before === null ? -1 : target.indexOf(before)
  target.splice(index < 0 ? target.length : index, 0, id)
  return { ...layout, [from]: source.filter((card) => card !== id), [side]: target }
}

export function moveCard(layout: CardLayout, id: CardId, direction: Direction): CardLayout {
  const from = layout.left.includes(id) ? 'left' : 'right'
  const index = layout[from].indexOf(id)
  if (direction === 'left' || direction === 'right') {
    if (direction === from) return layout
    return placeCard(layout, id, { side: direction, before: layout[direction][index] ?? null })
  }
  if (direction === 'up' && index > 0) return placeCard(layout, id, { side: from, before: layout[from][index - 1] })
  if (direction === 'down' && index + 1 < layout[from].length) {
    return placeCard(layout, id, { side: from, before: layout[from][index + 2] ?? null })
  }
  return layout
}

const directions: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

function LayoutCard({
  id,
  render,
  onTrack,
  onDrop,
  onMove,
}: {
  id: CardId
  render: CardRender
  onTrack: (id: CardId, event: PointerEvent) => void
  onDrop: (id: CardId, event: PointerEvent) => void
  onMove: (id: CardId, direction: Direction) => void
}) {
  const controls = useDragControls()
  const reduced = useReducedMotion()
  const handle = (
    <button
      type="button"
      data-card-grip
      aria-label={`Переместить карточку «${titles[id]}»`}
      title="Перетащите или используйте клавиши со стрелками"
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -ml-1.5 inline-flex shrink-0 cursor-grab touch-none items-center rounded p-1 outline-none focus-visible:ring-3 active:cursor-grabbing"
      onPointerDown={(event) => controls.start(event)}
      onKeyDown={(event) => {
        const direction = directions[event.key]
        if (!direction) return
        event.preventDefault()
        onMove(id, direction)
      }}
    >
      <IconGripVertical className="size-4" />
    </button>
  )

  return (
    <motion.div
      data-overview-card={id}
      className="relative min-w-0"
      layout={reduced ? false : 'position'}
      layoutId={reduced ? undefined : id}
      transition={{ layout: { duration: 0.2, ease: 'easeOut' } }}
      drag
      dragListener={false}
      dragControls={controls}
      dragMomentum={false}
      dragSnapToOrigin
      whileDrag={{ zIndex: 10 }}
      onDrag={(event) => onTrack(id, event as PointerEvent)}
      onDragEnd={(event) => onDrop(id, event as PointerEvent)}
    >
      {render(id, handle)}
    </motion.div>
  )
}

type CardRender = (id: CardId, handle: ReactNode) => ReactNode

function CardGrid({
  layout,
  hidden,
  update,
  compact = false,
  render,
}: {
  layout: CardLayout
  hidden: CardId[]
  update: (layout: CardLayout) => void
  compact?: boolean
  render: CardRender
}) {
  const gridId = useId()
  const grid = useRef<HTMLDivElement>(null)
  const columns = useRef<Partial<Record<Side, HTMLDivElement>>>({})
  const [destination, setDestination] = useState<Destination | null>(null)
  const visible = { left: layout.left.filter((id) => !hidden.includes(id)), right: layout.right.filter((id) => !hidden.includes(id)) }
  const hasCards = visible.left.length + visible.right.length > 0
  const getDestination = (id: CardId, { clientX: x, clientY: y }: PointerEvent): Destination | null => {
    const bounds = grid.current?.getBoundingClientRect()
    const left = columns.current.left?.getBoundingClientRect()
    const right = columns.current.right?.getBoundingClientRect()
    if (!bounds || !left || !right || x < bounds.left || x > bounds.right || y < bounds.top - 24 || y > bounds.bottom + 24) return null
    const stacked = right.left < left.right
    const side = (stacked ? y < (left.bottom + right.top) / 2 : x < (left.right + right.left) / 2) ? 'left' : 'right'
    const children = Array.from(columns.current[side]?.querySelectorAll<HTMLElement>(':scope > [data-overview-card]') ?? [])
    const next = children.find((child) => {
      if (child.dataset.overviewCard === id) return false
      const rect = child.getBoundingClientRect()
      return y < rect.top + rect.height / 2
    })
    return { side, before: (next?.dataset.overviewCard as CardId | undefined) ?? null }
  }

  const drop = (id: CardId, event: PointerEvent) => {
    const target = event.type === 'pointercancel' ? null : getDestination(id, event)
    setDestination(null)
    if (!target) return
    const reordered = placeCard(visible, id, target)
    if (reordered !== visible) update(placeCard(layout, id, target))
  }

  const move = (id: CardId, direction: Direction) => {
    const moved = moveCard(visible, id, direction)
    if (moved === visible) return
    const side = moved.left.includes(id) ? 'left' : 'right'
    const before = moved[side][moved[side].indexOf(id) + 1] ?? null
    update(placeCard(layout, id, { side, before }))
    requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`[data-overview-card="${id}"] [data-card-grip]`)?.focus())
  }

  if (!hasCards) return null
  return (
    <LayoutGroup id={gridId}>
      <div ref={grid} className={cn('grid items-stretch', compact ? 'gap-3 sm:grid-cols-2' : 'gap-3 lg:grid-cols-2 lg:gap-5')}>
        {SIDES.map((side) => (
          <div
            key={side}
            ref={(node) => {
              if (node) columns.current[side] = node
              else delete columns.current[side]
            }}
            className={cn(
              'relative flex min-w-0 flex-col',
              compact ? 'gap-3' : 'gap-5',
              visible[side].length === 0 && (compact ? 'min-h-4 sm:min-h-16' : 'min-h-4 lg:min-h-16')
            )}
          >
            {visible[side].map((id) => (
              <LayoutCard
                key={id}
                id={id}
                render={(card, handle) => (
                  <>
                    {destination?.side === side && destination.before === id && (
                      <span className="bg-primary pointer-events-none absolute inset-x-2 -top-2 h-0.5 rounded" />
                    )}
                    {render(card, handle)}
                    {destination?.side === side && destination.before === null && visible[side].at(-1) === id && (
                      <span className="bg-primary pointer-events-none absolute inset-x-2 -bottom-2 h-0.5 rounded" />
                    )}
                  </>
                )}
                onTrack={(card, event) => {
                  const next = getDestination(card, event)
                  setDestination((current) => (current?.side === next?.side && current?.before === next?.before ? current : next))
                }}
                onDrop={drop}
                onMove={move}
              />
            ))}
            {destination?.side === side && visible[side].length === 0 && (
              <span className="bg-primary pointer-events-none absolute inset-x-2 top-1 h-0.5 rounded" />
            )}
          </div>
        ))}
      </div>
    </LayoutGroup>
  )
}

export function OverviewLayout({ render }: { render: CardRender }) {
  const [preferences, setPreferences] = useState(readPreferences)
  const update = (next: LayoutPreferences) => {
    setPreferences(next)
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
    } catch {
      /* Preferences stay in memory until reload. */
    }
  }
  const updateOrder = (layout: CardLayout) => update({ ...preferences, ...layout })
  return (
    <>
      <CardGrid layout={preferences} hidden={preferences.hidden} update={updateOrder} render={render} />
      <div className="bg-card flex justify-center rounded-lg border p-5">
        <Dialog>
          <DialogTrigger render={<Button variant="outline" className="text-primary" />}>
            <IconSettings data-icon="inline-start" />
            Настройки системного монитора
          </DialogTrigger>
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Расположение плиток</DialogTitle>
            </DialogHeader>
            <CardGrid
              layout={preferences}
              hidden={[]}
              update={updateOrder}
              compact
              render={(id, handle) => (
                <div className="bg-background flex flex-col gap-4 rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{titles[id]}</span>
                    {handle}
                  </div>
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={!preferences.hidden.includes(id)}
                      aria-label={`Показывать плитку «${titles[id]}»`}
                      onCheckedChange={(checked) =>
                        update({
                          ...preferences,
                          hidden: checked ? preferences.hidden.filter((card) => card !== id) : [...preferences.hidden, id],
                        })
                      }
                    />
                    <span className="text-muted-foreground">Показать плитку</span>
                  </div>
                </div>
              )}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => update(defaults)}>
                <IconRefresh data-icon="inline-start" />
                Сброс
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </>
  )
}
