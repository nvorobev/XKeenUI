import { Button } from '@/components/ui/button'
import { ClearIcon } from '@/components/ui/clear-icon'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { IconBolt, IconCodeDots, IconCornerDownLeft, IconGripVertical, IconPlugX, IconTrash } from '@tabler/icons-react'
import { parse as parseJsonc } from 'jsonc-parser'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCall } from '../../../lib/api'
import { appendPingEntries, clearPingHistory, useAppActions, usePingHistoryStore, type PingEntry } from '../../../lib/store'
import type { Config } from '../../../lib/types'
import { cn, copyText } from '../../../lib/utils'
import type { CodeMirrorRef } from '../CodeMirror'
import { JsonEditDialog } from '../editor/JsonEditDialog'
import { IndexBadge } from './IndexBadge'
import { delayColor, extractMeta } from './outboundMeta'

type Outbound = Record<string, any>

const XRAY_START_ERROR = 'Не удалось запустить Xray, проверьте журнал'

type GenerateConfigForCore = (uri: string, core: string, existingConfig: string) => { type: string; content: string }

const OUTBOUND_LINK_PREFIXES = ['ss://', 'vless://', 'vmess://', 'hysteria2://', 'hy2://', 'trojan://']

function parseOutbounds(content: string): Outbound[] {
  try {
    const json = parseJsonc(content)
    if (Array.isArray(json?.outbounds)) return JSON.parse(JSON.stringify(json.outbounds))
  } catch {
    /* */
  }
  return []
}

function formatEntryTime(time: string): string {
  const date = new Date(time)
  if (isNaN(date.getTime())) return time
  return date.toLocaleString('sv-SE', { hour12: false }).replace('T', ' ')
}

/**
 * Значок «мёртвого» аутбаунда — delay 0 в истории (по аналогии с михомо-селекторами).
 */
function GraveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true" className={className}>
      <rect x="46.913" y="424.382" width="418.175" height="87.618" />
      <path d="M263.957 0h-15.916C160.059 0 88.737 71.322 88.737 159.305v238.941h334.525V159.305C423.262 71.322 351.941 0 263.957 0m75.009 225.189h-61.389v95.91h-43.155v-95.91h-61.389v-43.304h61.389v-59.918h43.155v59.918h61.389z" />
    </svg>
  )
}

interface Props {
  editorRef: React.RefObject<CodeMirrorRef | null>
  configs: Config[]
  activeConfigIndex: number
}

export function GuiOutbounds({ editorRef, configs, activeConfigIndex }: Props) {
  const { showToast } = useAppActions()
  const [outbounds, setOutbounds] = useState<Outbound[]>(() => parseOutbounds(configs[activeConfigIndex]?.content ?? ''))
  const history = usePingHistoryStore((state) => state.history)
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [link, setLink] = useState('')
  const [isPingingAll, setIsPingingAll] = useState(false)
  const outboundsRef = useRef<Outbound[]>(outbounds)
  const cleanListRef = useRef<Outbound[]>(outbounds)
  const inFlightRef = useRef<Set<string>>(new Set())
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ index: number; tag: string; key: number } | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editOriginal, setEditOriginal] = useState('')
  const [editError, setEditError] = useState<string | undefined>(undefined)

  useEffect(() => {
    const list = parseOutbounds(configs[activeConfigIndex]?.content ?? '')
    if (JSON.stringify(list) === JSON.stringify(outboundsRef.current)) return
    outboundsRef.current = list
    cleanListRef.current = list
    setOutbounds(list)
  }, [activeConfigIndex, configs])

  const syncToEditor = useCallback(
    (list: Outbound[]) => {
      cleanListRef.current = list
      const wrapper = editorRef.current
      if (!wrapper) return
      try {
        const json = parseJsonc(wrapper.getValue())
        json.outbounds = list
        wrapper.replaceAll(JSON.stringify(json, null, 2))
      } catch (e: any) {
        showToast(`Ошибка синхронизации: ${e.message}`, 'error')
      }
    },
    [editorRef, showToast]
  )

  const startDrag = useCallback(
    (e: React.MouseEvent | React.TouchEvent, fromIndex: number) => {
      if (e.cancelable) e.preventDefault()
      let current = fromIndex
      setDraggingIndex(fromIndex)

      const onMove = (ev: MouseEvent | TouchEvent) => {
        const clientY = 'touches' in ev ? ev.touches[0].clientY : ev.clientY
        for (let i = 0; i < cardRefs.current.length; i++) {
          if (i === current) continue
          const rect = cardRefs.current[i]?.getBoundingClientRect()
          if (!rect || clientY < rect.top || clientY > rect.bottom) continue
          const list = [...outboundsRef.current]
          const [moved] = list.splice(current, 1)
          list.splice(i, 0, moved)
          current = i
          outboundsRef.current = list
          setOutbounds(list)
          setDraggingIndex(i)
          break
        }
      }
      const onUp = () => {
        if (JSON.stringify(outboundsRef.current) === JSON.stringify(cleanListRef.current)) {
          setOutbounds(cleanListRef.current)
        } else {
          syncToEditor(outboundsRef.current)
        }
        setDraggingIndex(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('touchmove', onMove)
        document.removeEventListener('touchend', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.addEventListener('touchmove', onMove, { passive: true })
      document.addEventListener('touchend', onUp, { passive: true })
    },
    [syncToEditor]
  )

  const handlePing = useCallback(
    async (tag: string, outbound: Outbound) => {
      if (!tag || inFlightRef.current.has(tag)) return
      inFlightRef.current.add(tag)
      setTesting((prev) => ({ ...prev, [tag]: true }))
      try {
        const r = await apiCall<{ success: boolean; latency_ms?: number; error?: string }>(
          'POST',
          'healthcheck',
          { outbound },
          { timeoutMs: 30000 }
        )
        if (!r.success) {
          showToast(r.error ?? XRAY_START_ERROR, 'error')
          return
        }
        appendPingEntries([{ tag, delay: r.latency_ms ?? 0, error: r.error }])
      } catch (e: any) {
        showToast(`Пинг «${tag}»: ${e?.message ?? 'ошибка запроса'}`, 'error')
      } finally {
        setTesting((prev) => ({ ...prev, [tag]: false }))
        inFlightRef.current.delete(tag)
      }
    },
    [showToast]
  )

  const handlePingAll = useCallback(async () => {
    const targets = outboundsRef.current.filter(
      (outbound) =>
        outbound.protocol !== 'blackhole' &&
        outbound.protocol !== 'dns' &&
        outbound.protocol !== 'loopback' &&
        typeof outbound.tag === 'string' &&
        outbound.tag
    )
    if (targets.length === 0) return
    setIsPingingAll(true)
    setTesting((prev) => {
      const next = { ...prev }
      for (const { tag } of targets) next[tag] = true
      return next
    })
    try {
      const r = await apiCall<{
        success: boolean
        error?: string
        results?: { tag: string; success: boolean; latency_ms?: number; error?: string }[]
      }>('POST', 'healthcheck/all', { outbounds: targets }, { timeoutMs: 45000 })
      if (!r.success) {
        showToast(r.error ?? XRAY_START_ERROR, 'error')
        return
      }
      appendPingEntries(
        (r.results ?? []).map(({ tag, success, latency_ms, error }) => ({
          tag,
          delay: success ? (latency_ms ?? 0) : 0,
          error: success ? undefined : error,
        }))
      )
    } catch (e: any) {
      showToast(`Тест всех: ${e?.message ?? 'ошибка запроса'}`, 'error')
    } finally {
      setTesting((prev) => {
        const next = { ...prev }
        for (const { tag } of targets) next[tag] = false
        return next
      })
      setIsPingingAll(false)
    }
  }, [showToast])

  const addOutbound = useCallback(() => {
    try {
      const { generateConfigForCore } = window as unknown as { generateConfigForCore: GenerateConfigForCore }
      const outbound = JSON.parse(generateConfigForCore(link.trim(), 'xray', editorRef.current?.getValue() ?? '').content)
      const list = [...outboundsRef.current, outbound]
      outboundsRef.current = list
      setOutbounds(list)
      syncToEditor(list)
      setLink('')
      showToast(`Outbound «${outbound.tag}» добавлен`)
      setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 50)
    } catch (e: any) {
      showToast(e.message, 'error')
    }
  }, [link, editorRef, syncToEditor, showToast])

  const openEdit = useCallback((index: number) => {
    const ob = outboundsRef.current[index]
    if (!ob) return
    const original = JSON.stringify(ob, null, 2)
    setEditContent(original)
    setEditOriginal(original)
    setEditError(undefined)
    setEditing({ index, tag: typeof ob.tag === 'string' ? ob.tag : '', key: Date.now() })
  }, [])

  const saveEdit = useCallback(() => {
    if (editing == null || editContent === editOriginal || editError) return
    let parsed: Outbound
    try {
      parsed = JSON.parse(editContent)
    } catch {
      setEditError('Синтаксическая ошибка JSON')
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setEditError('Outbound должен быть JSON-объектом')
      return
    }
    const list = [...outboundsRef.current]
    list[editing.index] = parsed
    outboundsRef.current = list
    setOutbounds(list)
    syncToEditor(list)
    setEditing(null)
    showToast('Outbound обновлён')
  }, [editing, editContent, editOriginal, editError, syncToEditor, showToast])

  const handleRemove = useCallback(
    (index: number) => {
      const removed = outboundsRef.current[index]
      if (!removed) return
      const tag: string = typeof removed.tag === 'string' ? removed.tag : ''
      const list = outboundsRef.current.filter((_, i) => i !== index)
      outboundsRef.current = list
      setOutbounds(list)
      syncToEditor(list)
      if (tag) clearPingHistory(tag)
      showToast(tag ? `Outbound «${tag}» удалён` : 'Outbound удалён')
    },
    [syncToEditor, showToast]
  )

  const isValidLink = OUTBOUND_LINK_PREFIXES.some((prefix) => link.trim().toLowerCase().startsWith(prefix))
  const isDraftDirty = editing != null && editContent !== editOriginal

  return (
    <TooltipProvider delayDuration={500}>
      <div className="absolute inset-0 flex flex-col">
        <div ref={scrollRef} className="flex min-h-0 flex-1 scrollbar-thin flex-col overflow-y-auto">
          {outbounds.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <IconPlugX />
                </EmptyMedia>
                <EmptyTitle>Подключения не найдены</EmptyTitle>
                <EmptyDescription>
                  Вставьте ссылку на подключение в поле ниже или выберите шаблон Outbounds в разделе «Шаблоны»
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col divide-y border-b">
              {outbounds.map((ob, index) => {
                const tag: string = typeof ob?.tag === 'string' ? ob.tag : ''
                return (
                  <div
                    key={index}
                    ref={(el) => {
                      cardRefs.current[index] = el
                    }}
                  >
                    <OutboundCard
                      index={index}
                      outbound={ob}
                      isDragging={draggingIndex === index}
                      entries={history[tag] ?? []}
                      isTesting={!!testing[tag]}
                      onPing={handlePing}
                      onEdit={openEdit}
                      onRemove={handleRemove}
                      onDragStart={startDrag}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-5 py-3">
          <InputGroup className="min-w-40 flex-1">
            <InputGroupInput
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isValidLink) addOutbound()
              }}
              placeholder="Ссылка vless://, vmess://, ss://, trojan://, hy2://"
              aria-label="Ссылка на подключение"
            />

            {link && (
              <InputGroupAddon align="inline-end">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setLink('')}
                  aria-label="Очистить"
                  className="text-muted-foreground hover:text-destructive hover:bg-transparent!"
                >
                  <ClearIcon className="size-3.25" />
                </Button>
              </InputGroupAddon>
            )}
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                className="rounded-sm"
                variant="default"
                disabled={!isValidLink}
                onClick={addOutbound}
                aria-label="Добавить подключение"
              >
                <span className="hidden text-xs sm:inline">Добавить</span>
                <IconCornerDownLeft />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <Button
            variant="outline"
            disabled={isPingingAll || outbounds.length === 0}
            onClick={handlePingAll}
            aria-label="Тест всех подключений"
          >
            {isPingingAll ? <Spinner data-icon="inline-start" /> : <IconBolt data-icon="inline-start" />}{' '}
            <span className="hidden sm:inline">Тест всех</span>
          </Button>
        </div>
      </div>

      <JsonEditDialog
        editing={editing}
        title={editing?.tag || `Подключение #${(editing?.index ?? 0) + 1}`}
        content={editContent}
        error={editError}
        isDirty={isDraftDirty}
        onChange={setEditContent}
        onValidationChange={setEditError}
        onSave={saveEdit}
        onClose={() => setEditing(null)}
      />
    </TooltipProvider>
  )
}

interface OutboundCardProps {
  index: number
  outbound: Outbound
  isDragging: boolean
  entries: PingEntry[]
  isTesting: boolean
  onPing: (tag: string, outbound: Outbound) => void
  onEdit: (index: number) => void
  onRemove: (index: number) => void
  onDragStart: (e: React.MouseEvent | React.TouchEvent, index: number) => void
}

const OutboundCard = memo(function OutboundCard({
  index,
  outbound,
  isDragging,
  entries,
  isTesting,
  onPing,
  onEdit,
  onRemove,
  onDragStart,
}: OutboundCardProps) {
  const tag: string = typeof outbound?.tag === 'string' ? outbound.tag : ''
  const meta = useMemo(() => extractMeta(outbound), [outbound])
  const last = entries.length > 0 ? entries[entries.length - 1] : null
  const hasDelay = !!last?.delay && !isTesting
  const [confirmOpen, setConfirmOpen] = useState(false)
  const { showToast } = useAppActions()

  const handleCopy = useCallback(
    (label: string, value: string) => {
      copyText(value).then((ok) => (ok ? showToast(`${label} скопирован в буфер`) : showToast(`Ошибка копирования «${label}»`, 'error')))
    },
    [showToast]
  )
  const addr = meta.address ?? (meta.port != null ? String(meta.port) : '')

  return (
    <div className={cn('flex flex-col gap-2 px-5 py-3 transition-colors select-none', isDragging ? 'bg-primary/5' : 'hover:bg-muted/30')}>
      {/* Header */}
      <div className="flex items-center gap-1">
        <div
          aria-label="Перетащить"
          className={cn(
            'text-muted-foreground hover:text-foreground hover:bg-muted/50 -ml-2 touch-none rounded p-1 transition-colors',
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          )}
          onMouseDown={(e) => onDragStart(e, index)}
          onTouchStart={(e) => onDragStart(e, index)}
        >
          <IconGripVertical size={16} />
        </div>
        <IndexBadge index={index} />
        <span className={cn('truncate text-sm font-medium', !tag && 'text-muted-foreground font-normal')}>{tag || 'Без тега'}</span>
        {(meta.address || meta.port) && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  onClick={() => handleCopy('Адрес', addr)}
                  className="text-muted-foreground hover:text-foreground ml-1 hidden min-w-0 cursor-pointer truncate text-sm transition-colors sm:inline"
                >
                  {meta.address ?? ''}
                  {meta.port ? `:${meta.port}` : ''}
                </span>
              }
            />
            <TooltipContent side="top">Скопировать адрес</TooltipContent>
          </Tooltip>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="outline" size="icon-sm" onClick={() => onEdit(index)} aria-label="Редактировать JSON">
                  <IconCodeDots className="size-4.5" />
                </Button>
              }
            />
            <TooltipContent>Редактировать JSON</TooltipContent>
          </Tooltip>
          <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <PopoverTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label="Удалить outbound"
                        disabled={isDragging}
                        className="hover:text-destructive"
                      />
                    }
                  >
                    <IconTrash size={16} />
                  </PopoverTrigger>
                }
              />
              <TooltipContent>Удалить подключение</TooltipContent>
            </Tooltip>
            <PopoverContent align="end" sideOffset={6} className="max-w-72">
              <PopoverHeader>
                <PopoverTitle>Удалить подключение «{tag || `#${index + 1}`}» из конфига?</PopoverTitle>
              </PopoverHeader>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setConfirmOpen(false)}>
                  Отмена
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setConfirmOpen(false)
                    onRemove(index)
                  }}
                >
                  Удалить
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          {meta.protocol !== 'blackhole' && meta.protocol !== 'dns' && meta.protocol !== 'loopback' && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size={hasDelay ? 'sm' : 'icon-sm'}
                    onClick={() => !isTesting && tag && onPing(tag, outbound)}
                    disabled={isTesting || !tag}
                    aria-label="Проверить подключение"
                    className={cn(
                      'disabled:pointer-events-auto disabled:cursor-not-allowed',
                      hasDelay && 'min-w-12 justify-center px-2 text-xs tabular-nums',
                      isTesting && 'disabled:opacity-100',
                      !tag && 'opacity-40'
                    )}
                  >
                    {isTesting ? (
                      <Spinner className="size-4" />
                    ) : entries.length === 0 ? (
                      <IconBolt />
                    ) : !last!.delay ? (
                      <GraveIcon className="size-4 text-rose-500!" />
                    ) : (
                      <span className={cn('text-xs font-medium tracking-wide tabular-nums', delayColor(last!.delay))}>{last!.delay}</span>
                    )}
                  </Button>
                }
              />
              {entries.length > 0 ? (
                <TooltipContent side="top" className="p-2">
                  <div className="flex min-w-35 flex-col gap-1">
                    {entries.map((entry, i) => (
                      <div key={i} className="flex flex-col">
                        <div className="flex items-center justify-between gap-3">
                          <span className="tabular-nums">{formatEntryTime(entry.time)}</span>
                          <span className={cn('font-medium tabular-nums', delayColor(entry.delay))}>
                            {entry.delay ? `${entry.delay}ms` : '—'}
                          </span>
                        </div>
                        {entry.error && <span className="line-clamp-2 max-w-64 text-xs break-words text-rose-400">{entry.error}</span>}
                      </div>
                    ))}
                  </div>
                </TooltipContent>
              ) : (
                <TooltipContent>Протестировать подключение</TooltipContent>
              )}
            </Tooltip>
          )}
        </div>
      </div>

      {/* Metadata badges */}
      <div className="flex flex-wrap items-center gap-1 pl-7">
        <MetaChip className="bg-primary/10 text-primary">{meta.protocolLabel ?? meta.protocol.toUpperCase()}</MetaChip>
        {meta.protocol !== 'hysteria' && meta.network && <MetaChip>{meta.network.toUpperCase()}</MetaChip>}
        {meta.security === 'tls' && <MetaChip>TLS</MetaChip>}
        {meta.security === 'reality' && <MetaChip>REALITY</MetaChip>}
        {meta.flow && <MetaChip>{meta.flow}</MetaChip>}
        {meta.muxEnabled && <MetaChip>mux.cool</MetaChip>}
        {meta.fingerprint && <MetaChip>{meta.fingerprint}</MetaChip>}
        {meta.sni && (
          <Tooltip>
            <TooltipTrigger
              render={
                <MetaChip className="hover:text-foreground cursor-pointer" onClick={() => handleCopy('SNI', meta.sni!)}>
                  SNI: {meta.sni}
                </MetaChip>
              }
            />
            <TooltipContent side="top">Скопировать SNI</TooltipContent>
          </Tooltip>
        )}
        {meta.domainStrategy && <MetaChip>{meta.domainStrategy}</MetaChip>}
        {meta.sockoptDomainStrategy && <MetaChip>{meta.sockoptDomainStrategy}</MetaChip>}
        {meta.alpn && <MetaChip>{`ALPN: ${meta.alpn.join(', ')}`}</MetaChip>}
        {meta.congestion && <MetaChip>{meta.congestion.toUpperCase()}</MetaChip>}
      </div>
    </div>
  )
})

function MetaChip({ className, onClick, children }: { className?: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <span
      onClick={onClick}
      className={cn('bg-muted text-muted-foreground max-w-full truncate rounded px-2 py-0.5 text-xs font-medium', className)}
    >
      {children}
    </span>
  )
}
