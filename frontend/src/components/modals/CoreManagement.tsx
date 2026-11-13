import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconAlertTriangle, IconDownload, IconLayoutDashboard, IconRefresh, IconSwitchHorizontal } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useAppContext, useDnsStatusStore } from '../../lib/store'
import { Panel, StatusPill } from '../shell/Panel'
import { CoreLogo } from '../ui/core-logo'

interface Props {
  onSwitchCore: (core: string) => void
  onOpenUpdate: (core: string) => void
}

const CORES = [
  { id: 'xray', label: 'Xray' },
  { id: 'mihomo', label: 'Mihomo' },
]

function Row({
  media,
  title,
  meta,
  status,
  actions,
}: {
  media: ReactNode
  title: ReactNode
  meta: ReactNode
  status: ReactNode
  actions: ReactNode
}) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="bg-muted text-foreground flex size-10 shrink-0 items-center justify-center rounded-md">{media}</span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{title}</span>
            {status}
          </div>
          <span className="text-muted-foreground truncate text-xs">{meta}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">{actions}</div>
    </li>
  )
}

export function CoreManagementPage({ onSwitchCore, onOpenUpdate }: Props) {
  const { state } = useAppContext()
  const { currentCore, coreVersions, availableCores, version, isOutdatedUI, isOutdatedCore } = state
  const dnsStatus = useDnsStatusStore((s) => s.status)

  const isDnsEnabled = currentCore === 'mihomo' && !!dnsStatus && dnsStatus.dnsOverride && dnsStatus.dnsMihomo

  const [pendingCore, setPendingCore] = useState<string | null>(null)
  const busy = state.serviceStatus === 'pending' || state.serviceStatus === 'loading'

  const handleSwitch = (core: string) => {
    if (isDnsEnabled) {
      setPendingCore(core)
      return
    }
    onSwitchCore(core)
  }

  const openUpdate = (core: string) => {
    onOpenUpdate(core)
  }

  return (
    <>
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-bold tracking-wider uppercase">Ядра</h1>
          <p className="text-muted-foreground text-sm">Активное ядро, установленные версии и обновление панели.</p>
        </header>
        <Panel title="Прокси-ядра" id="maintenance-cores">
          <ul className="divide-y rounded-lg border">
            {CORES.map((core) => {
              const isActive = currentCore === core.id
              const isInstalled = availableCores.includes(core.id)
              const coreVersion = coreVersions[core.id as keyof typeof coreVersions]

              return (
                <Row
                  key={core.id}
                  media={<CoreLogo core={core.id} className="size-5" />}
                  title={core.label}
                  status={
                    isActive ? (
                      <StatusPill tone="ok">Активно</StatusPill>
                    ) : isInstalled ? (
                      <StatusPill tone="neutral">Установлено</StatusPill>
                    ) : (
                      <StatusPill tone="neutral">Не установлено</StatusPill>
                    )
                  }
                  meta={
                    isInstalled ? (
                      <>
                        Версия {(coreVersion ?? '').replace(/^v/i, '') || 'неизвестна'}
                        {isActive && isOutdatedCore && (
                          <Badge variant="amber" className="ml-2 align-middle">
                            Есть обновление
                          </Badge>
                        )}
                      </>
                    ) : (
                      'Ядро не найдено на роутере'
                    )
                  }
                  actions={
                    <>
                      {!isActive && isInstalled && (
                        <Button size="sm" disabled={busy} onClick={() => handleSwitch(core.id)}>
                          <IconSwitchHorizontal data-icon="inline-start" />
                          Сделать активным
                        </Button>
                      )}
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => openUpdate(core.id)}>
                        {isInstalled ? <IconRefresh data-icon="inline-start" /> : <IconDownload data-icon="inline-start" />}
                        {isInstalled ? 'Сменить версию' : 'Установить'}
                      </Button>
                    </>
                  }
                />
              )
            })}
          </ul>
        </Panel>
        <Panel title="Панель" id="maintenance-panel">
          <ul className="divide-y rounded-lg border">
            <Row
              media={<IconLayoutDashboard className="size-5" />}
              title="XKeen UI"
              status={isOutdatedUI ? <StatusPill tone="warn">Есть обновление</StatusPill> : null}
              meta={`Версия ${(version ?? '').replace(/^v/i, '') || 'неизвестна'}`}
              actions={
                <Button variant={isOutdatedUI ? 'default' : 'outline'} size="sm" disabled={busy} onClick={() => openUpdate('self')}>
                  <IconRefresh data-icon="inline-start" />
                  {isOutdatedUI ? 'Обновить' : 'Версии'}
                </Button>
              }
            />
          </ul>
        </Panel>
      </div>

      <AlertDialog open={pendingCore !== null} onOpenChange={(open) => !open && setPendingCore(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <IconAlertTriangle />
            </AlertDialogMedia>
            <AlertDialogTitle>Сменить ядро?</AlertDialogTitle>
            <AlertDialogDescription>
              Управление DNS сейчас включено. При переключении ядра доступ в интернет может пропасть.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingCore(null)}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const core = pendingCore
                setPendingCore(null)
                if (core) {
                  onSwitchCore(core)
                }
              }}
            >
              Сменить ядро
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
