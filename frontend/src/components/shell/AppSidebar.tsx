import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  IconAlertCircle,
  IconArrowLeft,
  IconArrowRight,
  IconBox,
  IconChevronDown,
  IconCpu,
  IconLayoutDashboard,
  IconLogout,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconRefresh,
  IconSettings,
  IconTool,
  IconWorld,
} from '@tabler/icons-react'
import { useState, type ComponentType } from 'react'
import { capitalize } from '../../lib/api'
import { navigate, type Page } from '../../lib/navigation'
import { useServiceControl, useSystemStats } from '../../lib/useServiceControl'
import { cn } from '../../lib/utils'
import { InfoGrid, StatusPill, type PillTone } from './Panel'

type Icon = ComponentType<{ className?: string }>
type Entry = { label: string; page?: Page; modal?: string }
type Group = { title: string; icon: Icon; entries: Entry[] }

const toolItems: { page: Page; label: string }[] = [
  { page: 'backups', label: 'Резервные копии' },
  { page: 'cores', label: 'Ядра' },
  { page: 'updates', label: 'Обновление' },
  { page: 'users', label: 'Пользователи' },
  { page: 'settings', label: 'Настройки панели' },
]

function groups(isXray: boolean): Group[] {
  return [
    {
      title: 'Статус',
      icon: IconLayoutDashboard,
      entries: [
        { label: 'Обзор', page: 'overview' },
        { label: 'Монитор трафика', page: 'traffic' },
        { label: 'Журнал', page: 'logs' },
      ],
    },
    {
      title: 'Прокси',
      icon: IconWorld,
      entries: [...(isXray ? [{ label: 'Серверы', page: 'servers' as const }] : []), { label: 'Конфигурация', page: 'config' as const }],
    },
    {
      title: 'Обслуживание',
      icon: IconTool,
      entries: toolItems,
    },
  ]
}

const COLLAPSED_KEY = 'sidebarCollapsed'
function readCollapsed() {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function formatMemoryMB(bytes: number | null | undefined) {
  return bytes ? Math.round(bytes / 1024 / 1024).toString() : '—'
}

function usageColorClass(percent: number | null) {
  if (percent === null) return ''
  if (percent >= 90) return 'text-rose-600 dark:text-rose-400'
  if (percent >= 70) return 'text-amber-600 dark:text-amber-400'
  return ''
}

function statusLabel(status: string, pendingText: string | undefined) {
  if (status === 'running') return 'Работает'
  if (status === 'stopped') return 'Остановлен'
  return (pendingText || 'Загрузка...').replace(/\.{3}$/, '…')
}

function OutdatedDot() {
  return (
    <span className="relative flex size-1.5 shrink-0" aria-label="Доступно обновление ядра">
      <span className="bg-primary absolute inline-flex size-full animate-ping rounded-full opacity-75" />
      <span className="bg-primary relative inline-flex size-1.5 rounded-full" />
    </span>
  )
}

/** Router-cabinet header: product mark, XKeen service state and controls, panel version, settings, logout. */
export function TopBar({
  onRefreshStatus,
  onOpenModal,
  onOpenUpdate,
  onLogout,
}: {
  onRefreshStatus: () => void
  onOpenModal: (modal: string) => void
  onOpenUpdate: (core: string) => void
  onLogout: () => void
}) {
  const service = useServiceControl(onRefreshStatus)
  const { serviceStatus, pendingText, currentCore, coreVersions, isConfigsLoading, version, isOutdatedUI, isOutdatedCore, settings } =
    service.state
  const { isRunning, isPending } = service
  const [popoverOpen, setPopoverOpen] = useState(false)
  const stats = useSystemStats(popoverOpen)
  const versionReady = !isConfigsLoading && !!version
  const tone: PillTone = isRunning ? 'ok' : serviceStatus === 'stopped' ? 'bad' : 'warn'
  const coreVersion = coreVersions[currentCore]
  const memoryPercent = stats?.memoryUsed && stats.memoryTotal ? (stats.memoryUsed / stats.memoryTotal) * 100 : null
  const cpuUsage = stats?.cpuUsage ?? null

  function closeAnd(action: () => void) {
    setPopoverOpen(false)
    action()
  }

  const quickActions = isRunning ? (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Перезапустить" onClick={service.restart} disabled={isPending}>
              <IconRefresh className="size-4" />
            </Button>
          }
        />
        <TooltipContent>Перезапустить</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Остановить"
              className="text-destructive hover:text-destructive"
              onClick={service.stop}
              disabled={isPending}
            >
              <IconPlayerStopFilled className="size-4" />
            </Button>
          }
        />
        <TooltipContent>Остановить</TooltipContent>
      </Tooltip>
    </>
  ) : (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Запустить"
            className="text-emerald-600 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-400"
            onClick={service.start}
            disabled={isPending}
          >
            {isPending ? <Spinner className="size-4" /> : <IconPlayerPlayFilled className="size-4" />}
          </Button>
        }
      />
      <TooltipContent>Запустить</TooltipContent>
    </Tooltip>
  )

  return (
    <TooltipProvider delayDuration={500}>
      <header className="bg-sidebar sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b px-3 shadow-sm sm:gap-4 md:px-6">
        <a
          href="#/overview"
          className="flex shrink-0 items-baseline gap-1.5 text-lg tracking-[0.12em] select-none sm:gap-2 sm:text-xl sm:tracking-[0.2em]"
          aria-label="XKEEN UI — обзор"
        >
          <span className="text-primary font-black">XKEEN</span>
          <span className="text-foreground font-light">UI</span>
        </a>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {versionReady ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" className="hidden md:inline-flex" onClick={() => onOpenUpdate('self')}>
                    <span className="text-sm">{version}</span>
                    {isOutdatedUI && <Badge>Обновление</Badge>}
                  </Button>
                }
              />
              <TooltipContent>{isOutdatedUI ? 'Доступно обновление XKeen UI' : 'Версия XKeen UI'}</TooltipContent>
            </Tooltip>
          ) : (
            <Skeleton className="hidden h-8 w-24 md:block" />
          )}
        </div>

        <div className="flex min-w-0 items-center gap-1">
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <PopoverTrigger
              render={
                <Button variant="ghost" className="h-10 min-w-0 gap-2.5 px-2" aria-label="Сервис XKeen">
                  <StatusPill tone={tone}>{statusLabel(serviceStatus, pendingText)}</StatusPill>
                  <span className="hidden min-w-0 items-center gap-1.5 md:flex">
                    <span className="truncate text-sm">
                      {capitalize(currentCore)}
                      {coreVersion && <span className="text-muted-foreground"> v{coreVersion.replace(/^v/, '')}</span>}
                    </span>
                    {isOutdatedCore && <OutdatedDot />}
                  </span>
                  <IconChevronDown className="text-muted-foreground hidden size-4 shrink-0 sm:block" />
                </Button>
              }
            />
            <PopoverContent align="start" className="w-[min(20rem,calc(100vw-1.5rem))] gap-0 p-0">
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">
                    {capitalize(currentCore)}
                    {coreVersion && <span className="text-muted-foreground font-normal"> v{coreVersion.replace(/^v/, '')}</span>}
                  </span>
                  {isOutdatedCore && <OutdatedDot />}
                </span>
                <StatusPill tone={tone}>{statusLabel(serviceStatus, pendingText)}</StatusPill>
              </div>
              <InfoGrid
                className="grid-cols-2 px-4 py-3 sm:grid-cols-2"
                items={[
                  ['Процессор', <span className={usageColorClass(cpuUsage)}>{cpuUsage === null ? '—' : `${cpuUsage.toFixed(0)} %`}</span>],
                  [
                    'Память',
                    <span className={usageColorClass(memoryPercent)}>
                      {formatMemoryMB(stats?.memoryUsed)} / {formatMemoryMB(stats?.memoryTotal)} МБ
                    </span>,
                  ],
                ]}
              />
              <div className="flex gap-2 border-t px-4 py-3">
                {isRunning ? (
                  <>
                    <Button className="flex-1" onClick={() => closeAnd(service.restart)} disabled={isPending}>
                      <IconRefresh data-icon="inline-start" />
                      Перезапустить
                    </Button>
                    <Button
                      variant="outline"
                      className="text-destructive hover:text-destructive flex-1"
                      onClick={() => closeAnd(service.stop)}
                      disabled={isPending}
                    >
                      <IconPlayerStopFilled data-icon="inline-start" />
                      Остановить
                    </Button>
                  </>
                ) : (
                  <Button className="flex-1" onClick={() => closeAnd(service.start)} disabled={isPending}>
                    {isPending ? <Spinner data-icon="inline-start" /> : <IconPlayerPlayFilled data-icon="inline-start" />}
                    {isPending ? statusLabel(serviceStatus, pendingText) : 'Запустить'}
                  </Button>
                )}
              </div>
              <div className="flex flex-col border-t py-1">
                {versionReady && (
                  <button
                    type="button"
                    className="hover:bg-muted focus-visible:bg-muted flex items-center justify-between gap-3 px-4 py-2 text-left outline-none md:hidden"
                    onClick={() => closeAnd(() => onOpenUpdate('self'))}
                  >
                    <span className="flex items-center gap-2">
                      <IconBox className="text-muted-foreground size-4" />
                      XKeen UI {version}
                    </span>
                    {isOutdatedUI && <Badge>Обновление</Badge>}
                  </button>
                )}
                <button
                  type="button"
                  className="hover:bg-muted focus-visible:bg-muted text-primary flex items-center gap-2 px-4 py-2 text-left outline-none"
                  onClick={() => closeAnd(() => onOpenModal('showCoreManageModal'))}
                >
                  <IconCpu className="size-4" />
                  Ядро и обновления
                </button>
              </div>
            </PopoverContent>
          </Popover>
          {!isConfigsLoading && <div className="hidden items-center gap-0.5 md:flex">{quickActions}</div>}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Настройки панели"
                  className="text-primary"
                  onClick={() => onOpenModal('showSettingsModal')}
                >
                  <IconSettings className="size-5" />
                </Button>
              }
            />
            <TooltipContent>Настройки панели</TooltipContent>
          </Tooltip>
          {settings.authEnabled && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon" aria-label="Выйти" className="text-muted-foreground" onClick={onLogout}>
                    <IconLogout className="size-5" />
                  </Button>
                }
              />
              <TooltipContent>Выйти</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      <AlertDialog open={service.dnsWarningOpen} onOpenChange={service.setDnsWarningOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <IconAlertCircle className="size-5 text-amber-500" /> Внимание
            </AlertDialogTitle>
            <AlertDialogDescription>После остановки XKeen будет отключено управление DNS. Продолжить?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void service.disableDnsAndStop()}>
              Остановить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}

/** Desktop navigation: grouped like a router cabinet. */
export function AppSidebar({ page, isXray, onOpenModal }: { page: Page; isXray: boolean; onOpenModal: (modal: string) => void }) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  function toggle() {
    setCollapsed((value) => {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, value ? '0' : '1')
      } catch {
        /* storage unavailable */
      }
      return !value
    })
  }
  return (
    <aside
      aria-label="Разделы"
      className={cn(
        'bg-sidebar sticky top-14 hidden h-[calc(100dvh-3.5rem)] shrink-0 flex-col border-r transition-[width] md:flex',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      <nav className="flex flex-1 flex-col overflow-y-auto py-3">
        {groups(isXray).map((group) => (
          <div key={group.title} className="flex flex-col pb-3">
            <span
              className={cn(
                'text-primary flex items-center gap-3 px-5 py-2 text-xs font-bold tracking-wider uppercase',
                collapsed && 'justify-center px-0'
              )}
              title={collapsed ? group.title : undefined}
            >
              <group.icon className="size-5 shrink-0" />
              {!collapsed && group.title}
            </span>
            {!collapsed &&
              group.entries.map((entry) => {
                const active = entry.page === page
                return (
                  <button
                    key={entry.label}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => (entry.page ? navigate(entry.page) : entry.modal && onOpenModal(entry.modal))}
                    className={cn(
                      'focus-visible:ring-ring/50 px-6 py-2.5 text-left text-[15px] outline-none focus-visible:ring-[3px]',
                      active ? 'bg-accent text-foreground font-medium' : 'text-foreground/85 hover:bg-accent/60'
                    )}
                  >
                    {entry.label}
                  </button>
                )
              })}
          </div>
        ))}
      </nav>
      <button
        type="button"
        onClick={toggle}
        className={cn(
          'text-primary hover:bg-accent/60 flex items-center gap-3 border-t px-5 py-4 text-sm font-medium',
          collapsed && 'justify-center px-0'
        )}
        aria-label={collapsed ? 'Показать меню' : 'Скрывать меню'}
      >
        {collapsed ? <IconArrowRight className="size-5" /> : <IconArrowLeft className="size-5" />}
        {!collapsed && 'Скрывать меню'}
      </button>
    </aside>
  )
}

/** Compact section switcher for phones. */
export function MobileNav({ page, isXray }: { page: Page; isXray: boolean }) {
  const pages = groups(isXray).flatMap((g) => g.entries.filter((e) => e.page)) as (Entry & { page: Page })[]
  return (
    <nav
      className="bg-sidebar flex gap-1 overflow-x-auto border-b [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] px-3 py-2 md:hidden"
      aria-label="Разделы"
    >
      {pages.map((entry) => (
        <Button
          key={entry.page}
          size="sm"
          variant="ghost"
          aria-current={page === entry.page ? 'page' : undefined}
          className={cn('shrink-0 transition-none', page === entry.page ? 'bg-accent text-primary' : 'text-muted-foreground')}
          onClick={() => navigate(entry.page)}
        >
          {entry.label}
        </Button>
      ))}
    </nav>
  )
}
