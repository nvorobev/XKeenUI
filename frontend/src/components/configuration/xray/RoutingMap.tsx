import type { RouteTestRunResponse } from '@/components/modals/RouteTester'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { IconArrowsMaximize, IconArrowsMinimize } from '@tabler/icons-react'
import { useId, useRef, useState } from 'react'
import type { Destination, RoutingRule } from './routing-builder'

type Path = 'block' | 'direct' | 'vpn' | 'other'
const LABELS: Record<Path, string> = { block: 'Блокировка', direct: 'Напрямую', vpn: 'Через VPN', other: 'Другой выход' }
export function routePath(rule: RoutingRule, targets: Destination[]): Path {
  if (rule.balancerTag === 'xkeen-ui-servers') return 'vpn'
  const target = targets.find((target) => rule[target.kind] === target.tag)
  if (!target) return typeof rule.outboundTag === 'string' && rule.outboundTag.startsWith('xkeen-ui-server-') ? 'vpn' : 'other'
  if (target.protocol === 'blackhole') return 'block'
  if (target.protocol === 'freedom') return 'direct'
  if (target.kind === 'balancerTag' || !['dns', 'loopback'].includes(target.protocol ?? '')) return 'vpn'
  return 'other'
}
const CONDITIONS: Record<string, string> = {
  inboundTag: 'Вход',
  domain: 'Домен',
  ip: 'IP',
  port: 'Порт назначения',
  network: 'Сеть',
  protocol: 'Протокол',
  source: 'IP устройства',
  sourceIP: 'IP устройства',
  sourcePort: 'Порт устройства',
  user: 'Пользователь',
  attrs: 'Атрибуты',
  localIP: 'Локальный IP',
  localPort: 'Локальный порт',
  process: 'Процесс',
}
export function routeConditions(rule: RoutingRule): string {
  return (
    Object.entries(rule)
      .filter(([key]) => !['type', 'outboundTag', 'balancerTag', 'ruleTag'].includes(key))
      .map(
        ([key, value]) =>
          `${CONDITIONS[key] ?? key}: ${Array.isArray(value) ? value.join(' ИЛИ ') : typeof value === 'object' ? JSON.stringify(value) : String(value)}`
      )
      .join(' · И · ') || 'Без условий'
  )
}

function RoutingDiagram({
  edge,
  labels,
  target,
  poolActive,
  expanded,
  inboundTags,
  domainStrategy,
  matchedRule,
  serverName,
  poolMode,
}: {
  edge: (path: Path | 'common' | 'uplink') => string
  labels: Record<'block' | 'direct' | 'vpn', string>
  target?: string
  poolActive: boolean
  expanded: boolean
  inboundTags: string[]
  domainStrategy?: string
  matchedRule?: number
  serverName: string
  poolMode: string
}) {
  const id = useId().replace(/:/g, '')
  const nodes = [
    { id: 'device', x: 20, y: 200, w: 145, h: 90, title: 'Устройство', lines: [target ?? 'Домен или IP'] },
    { id: 'policy', x: 245, y: 185, w: 210, h: 120, title: 'Политика / перехват', lines: ['Keenetic → XKeen', 'Участие трафика в Xray'] },
    {
      id: 'inbound',
      x: 505,
      y: 185,
      w: 210,
      h: 120,
      title: 'Вход Xray',
      lines: [inboundTags.join(' / ') || 'По конфигурации', 'Домен / IP назначения'],
    },
    {
      id: 'rules',
      x: 765,
      y: 185,
      w: 230,
      h: 120,
      title: 'Правила Xray',
      lines: ['Первое совпадение', matchedRule === undefined ? 'Проверка сверху вниз' : `Правило #${matchedRule + 1}`],
      accent: true,
    },
    { id: 'block', x: 505, y: 400, w: 150, h: 110, title: 'Блокировка', lines: ['Остановлен', labels.block] },
    { id: 'direct', x: 675, y: 400, w: 150, h: 110, title: 'Выход direct', lines: ['Напрямую', labels.direct] },
    { id: 'proxy', x: 845, y: 400, w: 150, h: 110, title: 'Выход proxy', lines: [poolActive ? 'Выбор из пула' : 'По правилу', labels.vpn] },
    {
      id: 'dns',
      x: 765,
      y: 65,
      w: 230,
      h: 85,
      title: 'DNS',
      lines: [domainStrategy || 'По настройкам Xray', 'По необходимости'],
    },
    ...(poolActive ? [{ id: 'pool', x: 765, y: 565, w: 230, h: 85, title: 'Пул серверов', lines: [poolMode, serverName] }] : []),
    { id: 'provider', x: 1120, y: 300, w: 190, h: 100, title: 'Провайдер', lines: ['Общий канал связи'] },
    { id: 'vpn', x: 1350, y: 565, w: 245, h: 100, title: 'Прокси / VPN-сервер', lines: [serverName] },
    { id: 'destination', x: 1420, y: 300, w: 200, h: 100, title: 'Сайт / сервис', lines: ['Назначение запроса'] },
  ]
  return (
    <svg
      viewBox="0 0 1640 780"
      className={cn('w-full', expanded && 'max-h-[calc(100dvh-12rem)] min-w-[64rem]')}
      role="img"
      aria-labelledby={`${id}-title ${id}-description`}
    >
      <title id={`${id}-title`}>Карта движения трафика по правилам Xray</title>
      <desc id={`${id}-description`}>
        Внутри роутера показаны политика и перехват трафика, вход Xray, первое совпадение правил и выход напрямую, через прокси или
        блокировку. DNS и выбор сервера из пула показаны как вспомогательные зависимости. Общий канал до провайдера ведёт напрямую к сайту
        или через удалённый сервер.
      </desc>
      <defs>
        <marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="fill-primary" />
        </marker>
      </defs>
      <g data-node="router">
        <rect x="205" y="40" width="850" height="700" rx="20" className="fill-primary/5 stroke-primary" />
        <text x="235" y="85" className="fill-foreground text-[26px] font-semibold">
          Роутер · Keenetic + XKeen
        </text>
        <text x="235" y="115" className="fill-muted-foreground text-lg">
          Обработка трафика и выбор маршрута
        </text>
      </g>
      <rect x="485" y="160" width="530" height="390" rx="14" className="fill-background/50 stroke-border" />
      <text x="505" y="178" className="fill-muted-foreground text-base">
        Xray
      </text>
      <g strokeWidth="2.5" markerEnd={`url(#${id}-arrow)`}>
        <path data-from="device" data-to="policy" d="M 165 245 H 245" className={edge('common')} />
        <path data-from="policy" data-to="inbound" d="M 455 245 H 505" className={edge('common')} />
        <path data-from="inbound" data-to="rules" d="M 715 245 H 765" className={edge('common')} />
        <path data-from="rules" data-to="block" d="M 800 305 V 345 H 580 V 400" className={edge('block')} />
        <path data-from="rules" data-to="direct" d="M 880 305 V 365 H 750 V 400" className={edge('direct')} />
        <path data-from="rules" data-to="proxy" d="M 960 305 V 375 H 920 V 400" className={edge('vpn')} />
        <path data-from="direct" data-to="wan" d="M 750 510 V 535 H 1035" className={edge('direct')} />
        <path data-from="proxy" data-to="wan" d="M 995 455 H 1035" className={edge('vpn')} />
        <path data-from="router" data-to="provider" data-route="shared" d="M 1035 535 V 350 H 1120" className={edge('uplink')} />
        <path data-from="provider" data-to="destination" data-route="direct" d="M 1310 350 H 1420" className={edge('direct')} />
        <path data-from="provider" data-to="vpn" data-route="vpn" d="M 1215 400 V 615 H 1350" className={edge('vpn')} />
        <path data-from="vpn" data-to="destination" d="M 1472 565 V 460 H 1520 V 400" className={edge('vpn')} />
      </g>
      <g className="stroke-muted-foreground fill-none" strokeWidth="1.5" strokeDasharray="5 5">
        <path data-from="dns" data-to="rules" data-kind="dependency" d="M 880 150 V 185" />
        {poolActive && <path data-from="pool" data-to="proxy" data-kind="dependency" d="M 920 565 V 510" />}
        <path data-from="policy" data-to="wan" data-kind="bypass" d="M 245 275 H 225 V 675 H 1035 V 535" />
      </g>
      <g className="fill-muted-foreground text-lg" textAnchor="middle">
        <text x="1365" y="285">
          Напрямую
        </text>
        <text x="1365" y="535">
          Через VPN
        </text>
        <text x="535" y="708">
          Трафик вне Xray → обычный выход роутера
        </text>
      </g>
      {nodes.map((node) => (
        <g key={node.id} data-node={node.id}>
          <title>{[node.title, ...node.lines].join(' · ')}</title>
          <rect
            x={node.x}
            y={node.y}
            width={node.w}
            height={node.h}
            rx="12"
            className={cn('fill-card stroke-border', node.accent && 'fill-primary/10 stroke-primary')}
          />
          <text x={node.x + node.w / 2} y={node.y + 30} textAnchor="middle" className="fill-foreground text-xl font-semibold">
            {node.title}
          </text>
          {node.lines.map((line, index) => (
            <text
              key={index}
              x={node.x + node.w / 2}
              y={node.y + 54 + index * 22}
              textAnchor="middle"
              className="fill-muted-foreground text-base"
            >
              {line.length > 29 ? line.slice(0, 27) + '…' : line}
            </text>
          ))}
        </g>
      ))}
    </svg>
  )
}

export function RoutingMap({
  rules,
  targets,
  result,
  poolActive,
  pool,
  inboundTags = [],
  domainStrategy,
}: {
  rules: RoutingRule[]
  targets: Destination[]
  result?: RouteTestRunResponse | null
  poolActive: boolean
  pool?: { targetTag: string; selectedName?: string; auto: boolean }
  inboundTags?: string[]
  domainStrategy?: string
}) {
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenMapRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<{ index: number; signature: string; result: RouteTestRunResponse | null | undefined } | null>(
    null
  )
  const tested = result?.results?.[0]
  const signature = JSON.stringify(rules)
  const selected = selection?.signature === signature && selection.result === result ? selection.index : null
  const testedRule = tested?.outcome === 'matched' && tested.rule && tested.rule.index < rules.length ? tested.rule.index : undefined
  const highlighted = selected ?? testedRule
  const active =
    selected !== null
      ? routePath(rules[selected], targets)
      : testedRule !== undefined
        ? routePath(rules[testedRule], targets)
        : tested?.outbound || tested?.balancer
          ? routePath({ outboundTag: tested.outbound, balancerTag: tested.balancer?.tag }, targets)
          : null
  const proxyTags = [
    ...new Set(
      rules.filter((rule) => routePath(rule, targets) === 'vpn').map((rule) => String(rule.outboundTag ?? rule.balancerTag ?? ''))
    ),
  ]
  const chosenRule = highlighted === undefined ? undefined : rules[highlighted]
  const proxyTag =
    chosenRule && routePath(chosenRule, targets) === 'vpn'
      ? String(chosenRule.outboundTag ?? chosenRule.balancerTag ?? '')
      : proxyTags.length === 1
        ? proxyTags[0]
        : ''
  const managed = poolActive && (proxyTag === pool?.targetTag || proxyTag === 'xkeen-ui-servers' || proxyTag.startsWith('xkeen-ui-server-'))
  const serverName = managed ? (pool?.selectedName ?? 'Выбранный в пуле') : proxyTag || 'По выбранному правилу'
  const edge = (path: Path | 'common' | 'uplink') =>
    cn(
      'fill-none transition-opacity',
      (
        path === 'uplink'
          ? active === 'block' || active === 'other'
          : path !== 'common' && ((active && active !== path) || (!active && !rules.some((rule) => routePath(rule, targets) === path)))
      )
        ? 'stroke-muted-foreground opacity-20'
        : 'stroke-primary'
    )
  const pathLabel = (path: Path) => {
    const numbers = rules.flatMap((rule, index) => (routePath(rule, targets) === path ? [`#${index + 1}`] : []))
    return numbers.length ? `${numbers.slice(0, 4).join(', ')}${numbers.length > 4 ? ` +${numbers.length - 4}` : ''}` : 'Нет явных правил'
  }
  const view = (expanded: boolean) => (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {expanded
            ? 'Выберите правило для подсветки пути. Проверка адреса доступна в конструкторе.'
            : 'Нажмите правило, чтобы увидеть его путь. Для конкретного запроса используйте проверку адреса ниже.'}
        </p>
        {!expanded && (
          <Button variant="outline" size="sm" onClick={() => setFullscreen(true)}>
            <IconArrowsMaximize data-icon="inline-start" />
            На весь экран
          </Button>
        )}
        {selected !== null && (
          <Button variant="outline" size="sm" onClick={() => setSelection(null)}>
            {tested ? 'Вернуться к проверке' : 'Показать все пути'}
          </Button>
        )}
      </div>
      <div ref={expanded ? fullscreenMapRef : mapRef} className="bg-background scroll-mt-4 overflow-x-auto rounded-lg border">
        <RoutingDiagram
          edge={edge}
          labels={{ block: pathLabel('block'), direct: pathLabel('direct'), vpn: pathLabel('vpn') }}
          target={tested?.target}
          poolActive={poolActive}
          expanded={expanded}
          inboundTags={inboundTags}
          domainStrategy={domainStrategy}
          matchedRule={highlighted}
          serverName={serverName}
          poolMode={pool ? (pool.auto ? 'Авто при отказе' : 'Ручной выбор') : 'По настройкам пула'}
        />
      </div>
      <p className="text-muted-foreground text-sm">
        Маршрут выбирается правилами Xray внутри роутера. Политика Keenetic и обход Xray показаны схематично. Пунктир к DNS и пулу —
        вспомогательные зависимости, а не дополнительные узлы пути.
      </p>
      {tested && (
        <p className="text-sm" role="status">
          {tested.outcome === 'error'
            ? `Путь не рассчитан: ${tested.error}`
            : `${tested.target} → ${tested.rule ? `правило #${tested.rule.index + 1}` : 'выход по умолчанию'} → ${tested.outbound ?? tested.balancer?.tag ?? 'неизвестный выход'}`}
          {tested.skipped?.length || result?.warnings?.length
            ? '. Есть неподдержанные условия или предупреждения: результат требует проверки в списке ниже.'
            : ''}
        </p>
      )}
      {active === 'other' && (
        <p className="text-muted-foreground text-sm">
          Этот выход не относится к обычному VPN, прямому подключению или блокировке. Его условия и tag показаны в правиле ниже.
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        Это схема конфигурации, а не наблюдение за пакетами. Условия внутри правила связаны через «И», значения одного списка — через «ИЛИ».
        Если совпадений нет, Xray использует исходный выход по умолчанию.
      </p>
      <ol className="flex max-h-80 flex-col gap-2 overflow-y-auto" aria-label="Правила на карте">
        {rules.map((rule, index) => (
          <li key={index}>
            <Button
              variant={highlighted === index ? 'secondary' : 'outline'}
              className="h-auto w-full justify-start gap-3 py-3 text-left whitespace-normal"
              onClick={() => {
                setSelection({ index, signature, result })
                ;(expanded ? fullscreenMapRef : mapRef).current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
              }}
              aria-pressed={highlighted === index}
            >
              <Badge variant="outline">#{index + 1}</Badge>
              <span className="flex min-w-0 flex-col gap-1 break-words">
                <span>
                  {LABELS[routePath(rule, targets)]} · {String(rule.outboundTag ?? rule.balancerTag ?? '—')}
                </span>
                <span className="text-muted-foreground text-xs">{routeConditions(rule)}</span>
              </span>
            </Button>
          </li>
        ))}
      </ol>
      {!rules.length && (
        <p className="text-muted-foreground text-sm">Явных правил пока нет. Добавьте их слева или выберите быстрые настройки.</p>
      )}
    </div>
  )
  return (
    <>
      {view(false)}
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent showCloseButton={false} className="flex h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:max-w-none">
          <DialogHeader className="shrink-0 border-b p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <DialogTitle>Карта маршрутов Xray</DialogTitle>
              <Button variant="outline" onClick={() => setFullscreen(false)}>
                <IconArrowsMinimize data-icon="inline-start" />
                Свернуть карту
              </Button>
            </div>
            <DialogDescription>
              Маршрут выбирается на роутере по первому подходящему правилу. Нажмите правило для подсветки его пути.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto p-4">{view(true)}</div>
        </DialogContent>
      </Dialog>
    </>
  )
}
