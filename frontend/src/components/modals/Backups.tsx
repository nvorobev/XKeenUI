import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { apiCall } from '@/lib/api'
import { downloadBackupFile, uploadBackupFile } from '@/lib/backupTransfer'
import { useAppContext } from '@/lib/store'
import {
  IconAlertTriangle,
  IconBoxOff,
  IconChevronDown,
  IconDownload,
  IconFileZip,
  IconPencil,
  IconPlus,
  IconRestore,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Panel } from '../shell/Panel'

type BackupContent = 'xkeen' | 'xkeen-ui' | 'xray' | 'mihomo'

interface BackupItem {
  name: string
  mtime: string
  size: number
  content?: Partial<Record<BackupContent, string[]>>
}

interface BackupsResponse {
  success: boolean
  error?: string
  backups?: BackupItem[]
}

interface BackupCreateResponse {
  success: boolean
  error?: string
  backup?: BackupItem
}

interface BackupActionResponse {
  success: boolean
  error?: string
}

interface Props {
  onRefreshConfigs: () => Promise<unknown>
}

type ConfirmAction = { type: 'restore'; name: string; contents?: BackupContent[] } | { type: 'delete'; name: string }

const CONTENT_LABELS: Record<BackupContent, string> = {
  xkeen: 'XKeen',
  'xkeen-ui': 'XKeen UI',
  xray: 'Xray',
  mihomo: 'Mihomo',
}

const CONTENT_VARIANTS: Record<BackupContent, 'sky' | 'emerald' | 'amber' | 'rose'> = {
  xkeen: 'sky',
  'xkeen-ui': 'rose',
  xray: 'emerald',
  mihomo: 'amber',
}

const BACKUP_SUFFIX = 'xkeen-ui.tar'

function stripBackupSuffix(name: string) {
  const suffix = `_${BACKUP_SUFFIX}`
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name
}

const CONTENT_ORDER: BackupContent[] = ['xkeen', 'xkeen-ui', 'xray', 'mihomo']
const MAX_BACKUPS_TO_KEEP = 5
const KEEP_LATEST_BACKUPS_KEY = 'backups:keepLatest'

export function BackupsPage({ onRefreshConfigs }: Props) {
  const { showToast } = useAppContext()

  const [backups, setBackups] = useState<BackupItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [keepLatestBackups, setKeepLatestBackups] = useState(() => localStorage.getItem(KEEP_LATEST_BACKUPS_KEY) === 'true')
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [dialogAction, setDialogAction] = useState<ConfirmAction | null>(null)
  const [renamingName, setRenamingName] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameSubmittingRef = useRef(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const fetchBackups = useCallback(async () => {
    const result = await apiCall<BackupsResponse>('GET', 'backup')
    if (!result.success) throw new Error(result.error ?? 'Не удалось загрузить резервные копии')
    const items = Array.isArray(result.backups) ? result.backups : []
    return items.sort((a, b) => b.mtime.localeCompare(a.mtime))
  }, [])

  async function downloadBackup(name: string) {
    if (pendingAction !== null) return
    setPendingAction(`download:${name}`)
    try {
      const blob = await downloadBackupFile(name)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Не удалось скачать копию', 'error')
    } finally {
      setPendingAction(null)
    }
  }

  async function uploadBackup(file: File) {
    if (pendingAction !== null) return
    setPendingAction('upload')
    try {
      await uploadBackupFile(file)
      setBackups(await fetchBackups())
      showToast('Копия загружена. Нажмите «Восстановить» у неё в списке.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Не удалось загрузить копию', 'error')
    } finally {
      setPendingAction(null)
    }
  }

  const loadBackups = useCallback(
    async (silent = false) => {
      if (!silent) setIsLoading(true)
      try {
        setBackups(await fetchBackups())
      } catch (error: any) {
        showToast(error.message ?? 'Не удалось загрузить резервные копии', 'error')
      } finally {
        setIsLoading(false)
      }
    },
    [fetchBackups, showToast]
  )

  useEffect(() => {
    // First load: isLoading is already true; ignore the answer if the dialog is gone.
    let cancelled = false
    fetchBackups()
      .then((items) => {
        if (!cancelled) setBackups(items)
      })
      .catch((error: unknown) => {
        if (!cancelled) showToast(error instanceof Error ? error.message : 'Не удалось загрузить резервные копии', 'error')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [fetchBackups, showToast])

  useEffect(() => {
    localStorage.setItem(KEEP_LATEST_BACKUPS_KEY, String(keepLatestBackups))
  }, [keepLatestBackups])

  // Keep the last action while the dialog animates closed.
  if (confirmAction && confirmAction !== dialogAction) setDialogAction(confirmAction)

  const startRename = useCallback((name: string) => {
    setRenamingName(name)
    setRenameValue(stripBackupSuffix(name))
  }, [])

  const cancelRename = useCallback(() => {
    setRenamingName(null)
    setRenameValue('')
  }, [])

  const submitRename = useCallback(
    async (oldName: string) => {
      if (renameSubmittingRef.current) return
      const newName = renameValue.trim()
      if (!newName || newName === stripBackupSuffix(oldName)) {
        cancelRename()
        return
      }
      renameSubmittingRef.current = true
      const newFullName = `${newName}_${BACKUP_SUFFIX}`
      setPendingAction(`rename:${oldName}`)
      try {
        const result = await apiCall<BackupActionResponse>('PATCH', 'backup', { name: oldName, new_name: newFullName })
        if (!result.success) {
          showToast(result.error ?? 'Не удалось переименовать копию', 'error')
          return
        }
        setBackups((prev) => prev.map((b) => (b.name === oldName ? { ...b, name: newFullName } : b)))
        showToast('Копия переименована')
        cancelRename()
      } catch (error: any) {
        showToast(error.message ?? 'Не удалось переименовать копию', 'error')
      } finally {
        renameSubmittingRef.current = false
        setPendingAction(null)
      }
    },
    [cancelRename, renameValue, showToast]
  )

  const createBackup = useCallback(async () => {
    setPendingAction('create')
    try {
      const result = await apiCall<BackupCreateResponse>('PUT', 'backup')
      if (!result.success) {
        showToast(result.error ?? 'Не удалось создать копию', 'error')
        return
      }
      setConfirmAction(null)
      try {
        let nextBackups = await fetchBackups()
        const staleBackups = keepLatestBackups ? getNewestBackups(nextBackups).slice(MAX_BACKUPS_TO_KEEP) : []

        for (const backup of staleBackups) {
          await deleteBackupRequest(backup.name)
        }

        if (staleBackups.length > 0) {
          const staleNames = new Set(staleBackups.map((backup) => backup.name))
          nextBackups = nextBackups.filter((backup) => !staleNames.has(backup.name))
        }

        setBackups(nextBackups)
        showToast(staleBackups.length > 0 ? `Копия создана, старых удалено: ${staleBackups.length}` : 'Копия создана')
      } catch (error: any) {
        showToast(`Копия создана, но ${(error.message ?? 'автоочистка не удалась').toLowerCase()}`, 'error')
        await loadBackups(true)
      }
    } catch (error: any) {
      showToast(error.message ?? 'Не удалось создать копию', 'error')
    } finally {
      setPendingAction(null)
    }
  }, [fetchBackups, keepLatestBackups, loadBackups, showToast])

  const restoreBackup = useCallback(
    async (name: string, contents?: BackupContent[]) => {
      setPendingAction(getRestoreActionKey(name, contents))
      try {
        const result = await apiCall<BackupActionResponse>('POST', 'backup', contents?.length ? { name, contents } : { name })
        if (!result.success) {
          showToast(result.error ?? 'Не удалось восстановить копию', 'error')
          return
        }
        setConfirmAction(null)
        await onRefreshConfigs()
        showToast(
          contents?.length
            ? `Файлы ${formatContentList(contents)} восстановлены. Перезапустите соответствующую службу для применения.`
            : 'Файлы восстановлены. Перезапустите XKeen и панель для применения настроек.'
        )
      } catch (error: any) {
        showToast(error.message ?? 'Не удалось восстановить копию', 'error')
      } finally {
        setPendingAction(null)
      }
    },
    [onRefreshConfigs, showToast]
  )

  const deleteBackup = useCallback(
    async (name: string) => {
      setPendingAction(`delete:${name}`)
      try {
        await deleteBackupRequest(name)
        setConfirmAction(null)
        setBackups((prev) => prev.filter((backup) => backup.name !== name))
        showToast('Копия удалена')
      } catch (error: any) {
        showToast(error.message ?? 'Не удалось удалить копию', 'error')
      } finally {
        setPendingAction(null)
      }
    },
    [showToast]
  )

  const closeConfirm = useCallback(() => {
    if (pendingAction === null) setTimeout(() => setConfirmAction(null), 0)
  }, [pendingAction])

  const submitConfirm = useCallback(async () => {
    if (!confirmAction) return
    if (confirmAction.type === 'delete') await deleteBackup(confirmAction.name)
    else await restoreBackup(confirmAction.name, confirmAction.contents)
  }, [confirmAction, deleteBackup, restoreBackup])

  const activeDialogAction = dialogAction ?? confirmAction

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-bold tracking-wider uppercase">Резервные копии</h1>
          <p className="text-muted-foreground text-sm">
            Скачайте копию на компьютер или загрузите архив с другого роутера. После загрузки выберите «Восстановить» в списке.
            Восстановление перезапишет текущие файлы конфигураций XKeen, XKeen UI, Xray и Mihomo.
          </p>
        </header>
        <Panel
          title="Копии конфигураций"
          id="maintenance-backups"
          actions={
            <Button
              variant="outline"
              disabled={pendingAction !== null || isLoading || renamingName !== null}
              onClick={() => uploadInputRef.current?.click()}
            >
              {pendingAction === 'upload' ? <Spinner data-icon="inline-start" /> : <IconUpload data-icon="inline-start" />}
              Загрузить копию
            </Button>
          }
        >
          <Input
            ref={uploadInputRef}
            type="file"
            accept=".tar,application/x-tar"
            className="hidden"
            aria-label="Архив резервной копии"
            disabled={pendingAction !== null}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void uploadBackup(file)
            }}
          />
          <p className="text-muted-foreground text-sm">
            Архив .tar, до 32 МБ. Загрузка добавляет копию в список и не меняет текущие настройки. После восстановления перезапустите XKeen,
            а для настроек панели — саму панель.
          </p>
          <div>
            {isLoading ? (
              <ul aria-busy="true" aria-label="Загрузка резервных копий" className="divide-y rounded-lg border">
                {Array.from({ length: 3 }, (_, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-3.5">
                    <Skeleton className="size-9 shrink-0" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <Skeleton className="h-4 w-1/2" />
                      <Skeleton className="h-3 w-1/3" />
                    </div>
                    <Skeleton className="h-8 w-28" />
                  </li>
                ))}
              </ul>
            ) : backups.length === 0 ? (
              <Empty className="min-h-64 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <IconBoxOff />
                  </EmptyMedia>
                  <EmptyTitle>Резервных копий пока нет</EmptyTitle>
                  <EmptyDescription>
                    Создайте копию перед изменением конфигураций, чтобы быстро вернуться к рабочему состоянию.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={() => void createBackup()} disabled={pendingAction !== null}>
                    {pendingAction === 'create' ? <Spinner data-icon="inline-start" /> : <IconPlus data-icon="inline-start" />}
                    Создать копию
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <ul className="divide-y rounded-lg border">
                {backups.map((backup) => {
                  const contents = getBackupContents(backup)
                  const isRestoring = pendingAction?.startsWith(`restore:${backup.name}:`) ?? false
                  const isDeleting = pendingAction === `delete:${backup.name}`
                  const isRenaming = pendingAction === `rename:${backup.name}`
                  const isBusy = pendingAction !== null && !isRestoring && !isDeleting
                  const isRestoreDisabled = isBusy || isDeleting || contents.length === 0
                  const displayName = stripBackupSuffix(backup.name)

                  return (
                    <li key={backup.name} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                          {isRenaming ? <Spinner /> : <IconFileZip className="size-5" />}
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                          {renamingName === backup.name ? (
                            <Input
                              autoFocus
                              aria-label="Новое имя резервной копии"
                              className="h-8"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  e.currentTarget.blur()
                                }
                                if (e.key === 'Escape') {
                                  e.stopPropagation()
                                  cancelRename()
                                }
                              }}
                              onBlur={() => void submitRename(backup.name)}
                              disabled={pendingAction !== null}
                            />
                          ) : (
                            <span className="truncate text-sm font-medium" title={displayName}>
                              {displayName}
                            </span>
                          )}
                          <span className="text-muted-foreground text-xs">
                            {backup.mtime} · {formatBytes(backup.size)}
                          </span>
                          <div className="flex flex-wrap gap-1">
                            {contents.length > 0 ? (
                              contents.map((content) => (
                                <ContentBadge key={content} content={content} files={backup.content?.[content] ?? []} />
                              ))
                            ) : (
                              <Badge variant="outline">Нет данных</Badge>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pendingAction !== null || renamingName !== null}
                          onClick={() => void downloadBackup(backup.name)}
                        >
                          {pendingAction === `download:${backup.name}` ? (
                            <Spinner data-icon="inline-start" />
                          ) : (
                            <IconDownload data-icon="inline-start" />
                          )}
                          Скачать
                        </Button>
                        <ButtonGroup>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirmAction({ type: 'restore', name: backup.name })}
                            disabled={isRestoreDisabled}
                          >
                            {isRestoring ? <Spinner data-icon="inline-start" /> : <IconRestore data-icon="inline-start" />}
                            Восстановить
                          </Button>
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  variant="outline"
                                  size="icon-sm"
                                  aria-label="Восстановить выборочно"
                                  disabled={isRestoreDisabled || contents.length <= 1}
                                >
                                  <IconChevronDown />
                                </Button>
                              }
                            />
                            <DropdownMenuContent align="end" className="min-w-44">
                              <DropdownMenuGroup>
                                <DropdownMenuLabel>Восстановить только</DropdownMenuLabel>
                                {contents.map((content) => (
                                  <DropdownMenuItem
                                    key={content}
                                    onClick={() => setConfirmAction({ type: 'restore', name: backup.name, contents: [content] })}
                                  >
                                    {CONTENT_LABELS[content]}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </ButtonGroup>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={() => startRename(backup.name)}
                                disabled={pendingAction !== null || renamingName === backup.name}
                                aria-label={`Переименовать ${displayName}`}
                              >
                                <IconPencil />
                              </Button>
                            }
                          />
                          <TooltipContent>Переименовать</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => setConfirmAction({ type: 'delete', name: backup.name })}
                                disabled={isBusy || isRestoring}
                                aria-label={`Удалить ${displayName}`}
                              >
                                {isDeleting ? <Spinner /> : <IconTrash />}
                              </Button>
                            }
                          />
                          <TooltipContent>Удалить</TooltipContent>
                        </Tooltip>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <KeepLatestBackupsToggle
              id="keep-latest-backups"
              checked={keepLatestBackups}
              disabled={pendingAction !== null}
              onCheckedChange={setKeepLatestBackups}
            />
            {(isLoading || backups.length > 0) && (
              <Button onClick={() => void createBackup()} disabled={pendingAction !== null || isLoading}>
                {pendingAction === 'create' ? <Spinner data-icon="inline-start" /> : <IconPlus data-icon="inline-start" />}
                Создать копию
              </Button>
            )}
          </div>
        </Panel>
      </div>

      <AlertDialog open={!!confirmAction} onOpenChange={(next) => !next}>
        <AlertDialogContent
          size="sm"
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            closeConfirm()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogMedia className={activeDialogAction?.type === 'delete' ? 'bg-destructive/10 text-destructive' : undefined}>
              {activeDialogAction?.type === 'delete' ? <IconTrash /> : <IconAlertTriangle />}
            </AlertDialogMedia>
            <AlertDialogTitle>
              {activeDialogAction?.type === 'delete'
                ? 'Удалить резервную копию?'
                : activeDialogAction?.contents?.length
                  ? `Восстановить ${formatContentList(activeDialogAction.contents)}?`
                  : 'Восстановить конфигурации?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {activeDialogAction?.type === 'delete'
                ? `Копия «${stripBackupSuffix(activeDialogAction.name)}» будет удалена без возможности восстановления.`
                : 'Текущие конфигурации будут перезаписаны содержимым копии.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={pendingAction !== null} onClick={closeConfirm}>
              Отмена
            </Button>
            <AlertDialogAction
              variant={activeDialogAction?.type === 'delete' ? 'destructive' : 'default'}
              onClick={() => void submitConfirm()}
              disabled={pendingAction !== null}
            >
              {pendingAction !== null && <Spinner data-icon="inline-start" />}
              {activeDialogAction?.type === 'delete' ? 'Удалить' : 'Восстановить'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}

function ContentBadge({ content, files }: { content: BackupContent; files: string[] }) {
  const badge = (
    <Badge className="cursor-default select-none" variant={CONTENT_VARIANTS[content]}>
      {CONTENT_LABELS[content]}
    </Badge>
  )

  if (files.length === 0) return badge

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex cursor-default select-none">{badge}</span>} />
      <TooltipContent sideOffset={6} className="max-w-80 px-3 py-2">
        <div className="space-y-1">
          <div className="text-[11px] font-medium opacity-70">{CONTENT_LABELS[content]}</div>
          <div className="max-h-56 overflow-y-auto">
            {files.map((file) => (
              <div key={file} className="text-xs leading-5 break-all">
                {file}
              </div>
            ))}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function KeepLatestBackupsToggle({
  id,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Label htmlFor={id} className="text-muted-foreground cursor-pointer text-sm font-normal">
                Хранить только {MAX_BACKUPS_TO_KEEP} последних
              </Label>
            }
          />
          <TooltipContent>
            При создании новой копии удалять
            <br /> все, кроме {MAX_BACKUPS_TO_KEEP} последних
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

function getRestoreActionKey(name: string, contents?: BackupContent[]) {
  return `restore:${name}:${contents?.join(',') ?? 'all'}`
}

function getBackupContents(backup: BackupItem) {
  return CONTENT_ORDER.filter((content) => (backup.content?.[content]?.length ?? 0) > 0)
}

function formatContentList(contents: BackupContent[]) {
  return contents.map((content) => CONTENT_LABELS[content]).join(', ')
}

async function deleteBackupRequest(name: string) {
  const result = await apiCall<BackupActionResponse>('DELETE', 'backup', { name })
  if (!result.success) throw new Error(result.error ?? 'Не удалось удалить копию')
}

function getNewestBackups(backups: BackupItem[]) {
  return [...backups].sort((a, b) => b.mtime.localeCompare(a.mtime))
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}
