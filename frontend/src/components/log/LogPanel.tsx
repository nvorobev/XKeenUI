import { Button } from '@/components/ui/button'
import { Empty, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { IconChevronDown, IconFile, IconFilter, IconMaximize, IconMinimize, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useSettings } from '../../lib/store'
import { cn } from '../../lib/utils'
import type { WsMessage } from '../../lib/websocket'
import { useWebSocket } from '../../lib/websocket'
import { ClearIcon } from '../ui/clear-icon'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group'

const LOG_FILES = ['error.log', 'access.log']
const MAX_LINES = 1000

export function LogPanel() {
  const timezone = useSettings((s) => s.timezone)
  const [filter, setFilter] = useState('')
  const [currentFile, setCurrentFile] = useState('error.log')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)
  const [isEmpty, setIsEmpty] = useState(true)

  const logRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const isFullscreenRef = useRef(false)
  const isAnimatingRef = useRef(false)
  const filterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoScrollRef = useRef(true)
  const linesRef = useRef<string[]>([])
  const scrollTickingRef = useRef(false)
  const lastScrollTopRef = useRef(0)

  useEffect(() => {
    return () => {
      if (filterTimerRef.current) clearTimeout(filterTimerRef.current)
      document.body.style.overflow = ''
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const trimToCap = useCallback(() => {
    const el = logRef.current
    if (!el) return
    const overflow = linesRef.current.length - MAX_LINES
    if (overflow <= 0) return
    linesRef.current.splice(0, overflow)
    for (let i = 0; i < overflow && el.firstChild; i++) {
      el.removeChild(el.firstChild)
    }
  }, [])

  const renderAll = useCallback((lines: string[]) => {
    const el = logRef.current
    if (!el) return

    const capped = lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines
    linesRef.current = capped
    const hasLines = capped.length > 0

    setIsEmpty(!hasLines)
    el.innerHTML = hasLines ? capped.join('') : ''

    if (hasLines && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  const appendLines = useCallback(
    (newLines: string[]) => {
      if (newLines.length === 0) return
      const el = logRef.current
      if (!el) return

      setIsEmpty(false)
      linesRef.current.push(...newLines)
      el.insertAdjacentHTML('beforeend', newLines.join(''))

      if (autoScrollRef.current) {
        trimToCap()
        el.scrollTop = el.scrollHeight
      }
    },
    [trimToCap]
  )

  const handleMessage = useCallback(
    (data: WsMessage) => {
      if (data.error) {
        renderAll([`<div style="color:#ef4444">ERROR: ${data.error}</div>`])
        return
      }
      if (data.type === 'initial' || data.type === 'filtered') {
        renderAll(data.lines || [])
        return
      }
      if (data.type === 'clear') {
        renderAll([])
        return
      }
      if (data.type === 'append' && data.content) {
        appendLines(data.content.split('\n').filter((l) => l.trim()))
      }
    },
    [renderAll, appendLines]
  )

  const ws = useWebSocket(handleMessage)

  useEffect(() => {
    ws.reload(filter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timezone])

  function switchFile(filename: string) {
    if (filename === currentFile) return
    setCurrentFile(filename)
    renderAll([])
    ws.switchFile(filename)
  }

  function handleFilterChange(value: string) {
    setFilter(value)
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current)
    filterTimerRef.current = setTimeout(() => ws.applyFilter(value), 100)
  }

  const checkScrollPosition = useCallback(() => {
    const el = logRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.clientHeight <= el.scrollTop + 40
    if (atBottom) autoScrollRef.current = true
    else if (el.scrollTop < lastScrollTopRef.current) autoScrollRef.current = false
    lastScrollTopRef.current = el.scrollTop
    setShowScrollBtn(!autoScrollRef.current)
  }, [])

  function handleScroll() {
    if (isAnimating || scrollTickingRef.current) return
    scrollTickingRef.current = true
    requestAnimationFrame(() => {
      checkScrollPosition()
      scrollTickingRef.current = false
    })
  }

  function handleScrollToBottom() {
    autoScrollRef.current = true
    setShowScrollBtn(false)
    trimToCap()
    scrollToBottom()
  }

  function handleLogClick(e: React.MouseEvent<HTMLDivElement>) {
    const badge = (e.target as HTMLElement).closest('span')
    if (!badge?.textContent) return
    const level = badge.textContent
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current)
    setFilter(level)
    ws.applyFilter(level)
  }

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) {
      setIsFullscreen((v) => {
        const next = !v
        isFullscreenRef.current = next
        document.body.style.overflow = next ? 'hidden' : ''
        return next
      })
      return
    }

    const first = el.getBoundingClientRect()
    const nextFullscreen = !isFullscreenRef.current
    isFullscreenRef.current = nextFullscreen

    if (nextFullscreen) document.body.style.overflow = 'hidden'

    const backdrop = backdropRef.current
    if (backdrop) {
      if (!isAnimatingRef.current) {
        backdrop.style.transition = 'none'
        backdrop.style.opacity = nextFullscreen ? '0' : '1'
      }
      requestAnimationFrame(() => {
        backdrop.style.transition = 'opacity 0.2s'
        backdrop.style.opacity = nextFullscreen ? '1' : '0'
      })
    }

    el.style.transition = 'none'

    flushSync(() => {
      setIsFullscreen(nextFullscreen)
      setIsAnimating(true)
    })

    isAnimatingRef.current = true

    el.style.willChange = 'transform, border-radius'
    el.style.transform = ''
    const last = el.getBoundingClientRect()

    const dx = first.left - last.left
    const dy = first.top - last.top
    const scaleX = first.width / last.width
    const scaleY = first.height / last.height

    el.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`
    el.style.transformOrigin = 'top left'

    void el.offsetHeight

    el.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)'
    el.style.transform = ''

    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== 'transform') return
      el.removeEventListener('transitionend', onTransitionEnd)

      if (!isFullscreenRef.current) {
        document.body.style.overflow = ''
      }

      el.style.transition = ''
      el.style.transformOrigin = ''
      el.style.willChange = ''
      isAnimatingRef.current = false
      setIsAnimating(false)
      checkScrollPosition()
    }

    if ((el as any)._onTransitionEnd) {
      el.removeEventListener('transitionend', (el as any)._onTransitionEnd)
    }
    ;(el as any)._onTransitionEnd = onTransitionEnd
    el.addEventListener('transitionend', onTransitionEnd)
  }, [checkScrollPosition])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === 'Escape' && isFullscreenRef.current) {
        toggleFullscreen()
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.code !== 'KeyA') return
      const el = logRef.current
      if (el && (el.contains(document.activeElement) || document.activeElement === el)) {
        e.preventDefault()
        window.getSelection()?.selectAllChildren(el)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [toggleFullscreen])

  useEffect(() => {
    const el = logRef.current
    if (!el) return

    let frameRequested = false
    const stickToBottom = () => {
      if (!autoScrollRef.current || frameRequested) return
      frameRequested = true
      requestAnimationFrame(() => {
        scrollToBottom()
        frameRequested = false
      })
    }

    const resizeObserver = new ResizeObserver(stickToBottom)
    resizeObserver.observe(el)
    document.fonts.addEventListener('loadingdone', stickToBottom)
    document.fonts.ready.then(stickToBottom)

    return () => {
      resizeObserver.disconnect()
      document.fonts.removeEventListener('loadingdone', stickToBottom)
    }
  }, [scrollToBottom])

  return (
    <TooltipProvider delayDuration={500}>
      <div className="relative h-[calc(100dvh-9rem)] min-h-80 w-full md:h-auto md:min-h-0 md:flex-1">
        <div
          ref={backdropRef}
          className="fixed inset-0 z-40 bg-black/50 opacity-0"
          style={{
            display: isFullscreen || isAnimating ? 'block' : 'none',
          }}
          onClick={toggleFullscreen}
        />

        <div
          ref={containerRef}
          className={cn(
            'border-border bg-card flex flex-col overflow-hidden rounded-lg border',
            isFullscreen ? 'fixed inset-x-3 bottom-3 z-50 shadow-2xl sm:inset-x-4 sm:mx-auto sm:max-w-400' : 'absolute inset-0 z-10 w-full'
          )}
          style={{
            height: isFullscreen ? 'calc(100dvh - 1.25rem)' : '100%',
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="flex shrink-0 flex-col justify-between gap-3 px-5 pt-5 pb-1 lg:flex-row lg:items-center">
              <h2 className="text-[15px] font-bold tracking-wider uppercase select-none">Журнал</h2>
              {
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="relative flex min-w-30 basis-full items-center sm:basis-auto">
                    <InputGroup className="w-full sm:w-40">
                      <InputGroupInput
                        placeholder="Фильтр"
                        className="right-2"
                        value={filter}
                        onChange={(e) => handleFilterChange(e.target.value)}
                      />
                      <InputGroupAddon>
                        <IconFilter />
                      </InputGroupAddon>
                      <InputGroupAddon align="inline-end">
                        {filter && (
                          <InputGroupButton
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => {
                              if (filterTimerRef.current) clearTimeout(filterTimerRef.current)
                              setFilter('')
                              ws.applyFilter('')
                            }}
                            className="text-muted-foreground hover:text-destructive hover:bg-transparent!"
                          >
                            <ClearIcon className="size-3.25" />
                          </InputGroupButton>
                        )}
                      </InputGroupAddon>
                    </InputGroup>
                  </div>
                  <Select value={currentFile} onValueChange={switchFile}>
                    <SelectTrigger className="flex-1 sm:flex-none md:w-33">
                      <SelectValue />
                    </SelectTrigger>

                    <SelectContent>
                      <SelectGroup>
                        {LOG_FILES.map((f) => (
                          <SelectItem key={f} value={f} className="text-sm">
                            {f}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className="ml-auto flex items-center gap-1.5 lg:ml-0">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="outline"
                            size="icon"
                            className="hover:text-destructive"
                            aria-label="Очистить лог"
                            onClick={() => ws.clearLog()}
                          >
                            <IconTrash />
                          </Button>
                        }
                      />
                      <TooltipContent>Очистить лог</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="outline"
                            size="icon"
                            aria-label={isFullscreen ? 'Свернуть' : 'Развернуть'}
                            onClick={toggleFullscreen}
                          >
                            {isFullscreen ? <IconMinimize /> : <IconMaximize />}
                          </Button>
                        }
                      />
                      <TooltipContent>{isFullscreen ? 'Свернуть' : 'Развернуть'}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              }
            </div>

            <div className="relative mt-0 min-h-0 flex-1">
              <div className="bg-input-background absolute inset-x-5 top-3 bottom-5 overflow-hidden rounded-md border">
                {isEmpty && (
                  <Empty className="h-full gap-0">
                    <EmptyMedia variant="icon" className="size-8.5">
                      <IconFile className="text-muted-foreground size-5" />
                    </EmptyMedia>
                    <EmptyTitle className="text-ring font-mono text-[13px] tracking-normal">Журнал пуст</EmptyTitle>
                  </Empty>
                )}
                <div
                  ref={logRef}
                  tabIndex={0}
                  className={cn(
                    'text-foreground scrollbar-width:thin h-full overflow-y-auto px-3 py-1.5 font-mono text-[13px] leading-[1.6] wrap-anywhere contain-content',
                    isAnimating && 'pointer-events-none'
                  )}
                  onScroll={handleScroll}
                  onClick={handleLogClick}
                />
              </div>

              {showScrollBtn && !isAnimating && (
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="bg-background/80 absolute right-8 bottom-8 z-10 shadow-lg backdrop-blur!"
                  onClick={handleScrollToBottom}
                >
                  <IconChevronDown size={14} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
