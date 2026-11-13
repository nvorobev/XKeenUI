import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from '@/components/ui/code-block'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { apiCall } from '@/lib/api'
import { deleteConfigHistory } from '@/lib/config-history'
import { cn } from '@/lib/utils'
import { IconAlertCircle, IconArrowLeft, IconCamera, IconHistory, IconRestore, IconTrash } from '@tabler/icons-react'
import { motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useState } from 'react'

interface Snapshot {
  id: string
  date: string
}

interface DiffSegment {
  text: string
  emphasized: boolean
}

interface DiffCell {
  line: number
  segments: DiffSegment[]
}

type DiffRow =
  | { type: 'equal'; left_line: number; right_line: number; text: string }
  | { type: 'change'; left: DiffCell | null; right: DiffCell | null }
  | { type: 'skipped'; count: number }

interface DiffPreview {
  rows: DiffRow[]
  content: string
}

interface Props {
  file: string
  currentContent: string
  onClose: () => void
  onRollback: (file: string, content: string) => Promise<void>
  onRollbackAndApply: (file: string, content: string) => Promise<void>
}

type SnapshotsResponse = { success: boolean; history?: Snapshot[]; error?: string }
type DiffResponse = { success: boolean; rows?: DiffRow[]; content?: string; error?: string }

function formatDay(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Сегодня'
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера'
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('ru-RU')
}

function getFileName(file: string) {
  return file.split(/[\\/]/).filter(Boolean).at(-1) || file
}

function DiffLine({
  side,
  line,
  kind,
  segments,
}: {
  side: 'left' | 'right'
  line?: number
  kind?: 'added' | 'removed'
  segments?: DiffSegment[]
}) {
  return (
    <CodeBlockLine
      variant={kind}
      data-line={line}
      className={cn(
        'mx-0! ps-1.5! before:me-5 before:inline-block before:min-w-6! before:text-end before:content-[attr(data-line)] after:start-9!',
        side === 'left' && 'border-border border-e',
        !segments && 'bg-muted/30',
        segments && !kind && 'text-muted-foreground',
        kind === 'removed' && 'bg-rose-500/10 text-rose-800 dark:text-rose-200',
        kind === 'added' && 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
      )}
    >
      {segments?.map((segment, index) => (
        <span
          key={index}
          className={cn(
            segment.emphasized && 'rounded-sm',
            segment.emphasized && (kind === 'removed' ? 'bg-rose-500/40' : 'bg-emerald-500/40')
          )}
        >
          {segment.text}
        </span>
      ))}
    </CodeBlockLine>
  )
}

function SnapshotDiff({ preview, onRestore }: { preview: DiffPreview; onRestore: (content: string, apply: boolean) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {!preview.rows.length && <p className="text-muted-foreground text-sm">Эта версия совпадает с текущим файлом</p>}

      {preview.rows.length > 0 && (
        <CodeBlock size="sm" className="bg-input-background!">
          <CodeBlockHeader className="border-border grid grid-cols-2 border-b pb-2">
            <CodeBlockTitle className="text-sm!">Сохранённая версия</CodeBlockTitle>
            <CodeBlockTitle className="text-sm!">Текущий файл</CodeBlockTitle>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-96">
            {preview.rows.map((row, rowIndex) =>
              row.type === 'skipped' ? (
                <div key={rowIndex} className="bg-muted/40 text-muted-foreground py-0.5 text-center text-xs">
                  Скрыто строк: {row.count}
                </div>
              ) : (
                <div key={rowIndex} className="grid grid-cols-2">
                  {row.type === 'equal' ? (
                    <>
                      <DiffLine side="left" line={row.left_line} segments={[{ text: row.text, emphasized: false }]} />
                      <DiffLine side="right" line={row.right_line} segments={[{ text: row.text, emphasized: false }]} />
                    </>
                  ) : (
                    <>
                      <DiffLine side="left" line={row.left?.line} kind={row.left ? 'removed' : undefined} segments={row.left?.segments} />
                      <DiffLine side="right" line={row.right?.line} kind={row.right ? 'added' : undefined} segments={row.right?.segments} />
                    </>
                  )}
                </div>
              )
            )}
          </CodeBlockContent>
        </CodeBlock>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="outline" disabled={!preview.rows.length} onClick={() => onRestore(preview.content, false)}>
          <IconRestore data-icon="inline-start" />
          Вернуть в редактор
        </Button>
        <Button size="sm" disabled={!preview.rows.length} onClick={() => onRestore(preview.content, true)}>
          <IconRestore data-icon="inline-start" />
          Вернуть и применить
        </Button>
      </div>
    </div>
  )
}

export function ConfigHistoryView({ file, currentContent, onClose, onRollback, onRollbackAndApply }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [expandedIds, setExpandedIds] = useState<string[]>([])
  const [previews, setPreviews] = useState<Record<string, DiffPreview>>({})
  const [loadingId, setLoadingId] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState('')
  const [isVisible, setIsVisible] = useState(true)
  const [isClosing, setIsClosing] = useState(false)

  const isBusy = isLoading || !!deletingId
  const fileName = getFileName(file)

  const closeHistory = useCallback(() => {
    if (isClosing) return
    setIsClosing(true)
    setIsVisible(false)
  }, [isClosing])

  const groups = useMemo(() => {
    const result: { day: string; entries: { snapshot: Snapshot; number: number }[] }[] = []
    for (let index = snapshots.length - 1; index >= 0; index--) {
      const day = formatDay(snapshots[index].date)
      const entry = { snapshot: snapshots[index], number: index + 1 }
      const group = result.at(-1)
      if (group?.day === day) group.entries.push(entry)
      else result.push({ day, entries: [entry] })
    }
    return result
  }, [snapshots])

  const fetchHistory = useCallback(async () => {
    const response = await apiCall<SnapshotsResponse>('GET', `configs/history?file=${encodeURIComponent(file)}`)
    if (!response.success) throw new Error(response.error || 'Не удалось загрузить историю')
    return response.history ?? []
  }, [file])

  const showHistory = useCallback((history: Snapshot[]) => {
    setSnapshots(history)
    setExpandedIds([])
    setPreviews({})
  }, [])

  const loadHistory = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      showHistory(await fetchHistory())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить историю')
    } finally {
      setIsLoading(false)
    }
  }, [fetchHistory, showHistory])

  useEffect(() => {
    // First load: state is already «loading, no error»; ignore the answer once closed.
    let cancelled = false
    fetchHistory()
      .then((history) => {
        if (!cancelled) showHistory(history)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить историю')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [fetchHistory, showHistory])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape внутри диалога подтверждения закрывает только его.
      if (event.key === 'Escape' && !confirmClear && confirmDeleteId === null) closeHistory()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeHistory, confirmClear, confirmDeleteId])

  async function changeExpanded(value: string[]) {
    setError('')
    const openedId = value.find((id) => !expandedIds.includes(id))
    if (!openedId) return setExpandedIds(value)
    if (loadingId) return
    setLoadingId(openedId)
    try {
      const response = await apiCall<DiffResponse>('POST', 'configs/history/diff', { file, id: openedId, current_content: currentContent })
      if (!response.success || !response.rows || response.content === undefined)
        throw new Error(response.error || 'Не удалось построить diff')
      const preview: DiffPreview = { rows: response.rows, content: response.content }
      setPreviews((previous) => ({ ...previous, [openedId]: preview }))
      setExpandedIds((previous) => [...previous, openedId])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось построить diff')
    } finally {
      setLoadingId('')
    }
  }

  function restore(content: string, apply: boolean) {
    closeHistory()
    void (apply ? onRollbackAndApply : onRollback)(file, content)
  }

  async function removeHistory(id?: string) {
    setDeletingId(id ?? 'all')
    setError('')
    try {
      const deleteError = await deleteConfigHistory(file, id)
      if (deleteError) throw new Error(deleteError)
      setConfirmDeleteId(null)
      setConfirmClear(false)
      await loadHistory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось удалить историю')
    } finally {
      setDeletingId('')
    }
  }

  const confirmOpen = confirmClear || confirmDeleteId !== null
  const confirmNumber = confirmDeleteId ? snapshots.findIndex((snapshot) => snapshot.id === confirmDeleteId) + 1 : 0

  return (
    <motion.section
      className="bg-card text-foreground flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 8, scale: 0.985 }}
      animate={isVisible ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 6, scale: 0.985 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      onAnimationComplete={() => {
        if (isClosing && !isVisible) onClose()
      }}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="outline" size="icon-sm" aria-label="Выйти из истории изменений" onClick={closeHistory}>
            <IconArrowLeft />
          </Button>
          <div className="flex min-w-0 flex-col">
            <h2 className="text-[15px] font-bold tracking-wider uppercase">История изменений</h2>
            <p className="text-muted-foreground truncate text-xs" title={file}>
              {fileName}
              {snapshots.length > 0 && ` · ${snapshots.length} ${pluralSnapshots(snapshots.length)}`}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="hover:text-destructive shrink-0"
          disabled={!snapshots.length || isBusy}
          onClick={() => setConfirmClear(true)}
        >
          <IconTrash data-icon="inline-start" />
          <span className="hidden sm:inline">Очистить историю</span>
          <span className="sm:hidden">Очистить</span>
        </Button>
      </header>

      {error && snapshots.length > 0 && (
        <Alert variant="destructive" className="mx-4 mt-3 w-auto sm:mx-5">
          <IconAlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto">
        <div className="flex min-h-full flex-col gap-5 px-4 py-4 sm:px-5">
          {snapshots.length ? (
            <Accordion type="multiple" value={expandedIds} onValueChange={(value) => void changeExpanded(value)} className="gap-5">
              {groups.map((group) => (
                <section key={group.day} className="flex flex-col gap-2">
                  <h3 className="text-muted-foreground px-1 text-xs font-semibold tracking-wider uppercase">{group.day}</h3>
                  <div className="divide-y overflow-hidden rounded-lg border">
                    {group.entries.map(({ snapshot, number }) => (
                      <AccordionItem key={snapshot.id} value={snapshot.id} className="border-b-0">
                        <div className="hover:bg-muted/40 grid grid-cols-[minmax(0,1fr)_auto] items-center transition-colors">
                          <AccordionTrigger className="min-w-0 items-center gap-3 rounded-none border-0 px-4 py-3 hover:no-underline focus-visible:ring-inset">
                            <span className="flex min-w-0 flex-1 items-center gap-3">
                              <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                                {loadingId === snapshot.id ? <Spinner /> : <IconCamera className="size-5" />}
                              </span>
                              <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="text-sm font-medium">Версия {number}</span>
                                <time dateTime={snapshot.date} className="text-muted-foreground text-xs font-normal">
                                  {formatTime(snapshot.date)}
                                </time>
                              </span>
                            </span>
                          </AccordionTrigger>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-destructive mr-2"
                            disabled={isBusy}
                            aria-label={`Удалить версию ${number}`}
                            onClick={() => setConfirmDeleteId(snapshot.id)}
                          >
                            {deletingId === snapshot.id ? <Spinner /> : <IconTrash />}
                          </Button>
                        </div>

                        <AccordionContent className="border-t px-4 pt-3">
                          {previews[snapshot.id] && <SnapshotDiff preview={previews[snapshot.id]} onRestore={restore} />}
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </div>
                </section>
              ))}
            </Accordion>
          ) : isLoading ? (
            <ul aria-busy="true" aria-label="Загрузка истории" className="divide-y rounded-lg border">
              {Array.from({ length: 4 }, (_, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="size-9 shrink-0" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </li>
              ))}
            </ul>
          ) : error ? (
            <Alert variant="destructive">
              <IconAlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <Empty className="min-h-64 flex-1 border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <IconHistory />
                </EmptyMedia>
                <EmptyTitle className="text-base">Сохранённых версий пока нет</EmptyTitle>
                <EmptyDescription>Новая версия появляется при каждом сохранении файла.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !deletingId) {
            setConfirmClear(false)
            setConfirmDeleteId(null)
          }
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <IconTrash />
            </AlertDialogMedia>
            <AlertDialogTitle>{confirmClear ? 'Очистить историю?' : `Удалить версию ${confirmNumber}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmClear
                ? `Все сохранённые версии файла ${fileName} будут удалены без возможности восстановления.`
                : `Версия будет удалена из истории ${fileName} без возможности восстановления.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingId}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!!deletingId}
              onClick={() => void removeHistory(confirmClear ? undefined : (confirmDeleteId ?? undefined))}
            >
              {deletingId && <Spinner data-icon="inline-start" />}
              {confirmClear ? 'Очистить' : 'Удалить'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.section>
  )
}

function pluralSnapshots(count: number) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return 'версия'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'версии'
  return 'версий'
}
