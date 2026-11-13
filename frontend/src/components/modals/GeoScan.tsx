import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ClearIcon } from '@/components/ui/clear-icon'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IconFiles, IconSearch, IconServer, IconWorld } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { useAppContext, useModalContext } from '../../lib/store'
import { copyText } from '../../lib/utils'
import { StatusPill } from '../shell/Panel'

type GeoType = 'domain' | 'ip'
type FileStatus = {
  categories: string[]
  status: 'idle' | 'scanning' | 'found' | 'not-found' | 'error'
}

function formatMtime(seconds: number) {
  const d = new Date(seconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function GeoScanModal() {
  const { showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const [geoType, setGeoType] = useState<GeoType>('domain')
  const [input, setInput] = useState('')
  const [geoFiles, setGeoFiles] = useState<{ domain: string[]; ip: string[] }>({
    domain: [],
    ip: [],
  })
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [mtimes, setMtimes] = useState<Record<string, number>>({})
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileStatus>>({})
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(true)

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showGeoScanModal', show: false })

  function initStatuses(files: string[]) {
    setFileStatuses(Object.fromEntries(files.map((f) => [f, { categories: [], status: 'idle' as const }])))
  }

  useEffect(() => {
    // Initial state is already «loading»; ignore the answer once the dialog is gone.
    let cancelled = false
    fetch('/api/geo')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data.success) return
        const files = { domain: data.site_files || [], ip: data.ip_files || [] }
        setGeoFiles(files)
        setMtimes(data.mtimes || {})
        setSelectedFiles(files.domain)
        initStatuses(files.domain)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function switchType(type: GeoType) {
    setGeoType(type)
    setInput('')
    setSelectedFiles(geoFiles[type])
    initStatuses(geoFiles[type])
  }

  function toggleFile(filename: string) {
    setSelectedFiles((prev) => (prev.includes(filename) ? prev.filter((f) => f !== filename) : [...prev, filename]))
  }

  async function scan() {
    if (!input.trim() || selectedFiles.length === 0) return
    setScanning(true)
    const endpoint = geoType === 'ip' ? '/api/geo/ip' : '/api/geo/site'
    const paramName = geoType === 'ip' ? 'ip' : 'domain'

    for (const file of selectedFiles) {
      setFileStatuses((prev) => ({
        ...prev,
        [file]: { status: 'scanning', categories: [] },
      }))
      try {
        const res = await fetch(`${endpoint}?file=${encodeURIComponent(file)}&${paramName}=${encodeURIComponent(input.trim())}`)
        const data = await res.json()
        if (!data.success && data.error) {
          showToast(data.error, 'error')
          setFileStatuses((prev) => ({
            ...prev,
            [file]: { status: 'error', categories: [] },
          }))
        } else {
          setFileStatuses((prev) => ({
            ...prev,
            [file]:
              data.success && data.categories?.length
                ? { status: 'found', categories: data.categories }
                : { status: 'not-found', categories: [] },
          }))
        }
      } catch {
        setFileStatuses((prev) => ({
          ...prev,
          [file]: { status: 'error', categories: [] },
        }))
      }
    }
    setScanning(false)
  }

  const currentFiles = geoFiles[geoType]
  const allSelected = currentFiles.length > 0 && currentFiles.every((f) => selectedFiles.includes(f))

  const canScan = !scanning && !!input.trim() && selectedFiles.length > 0

  return (
    <Dialog open={modals.showGeoScanModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4 pr-14">
          <DialogTitle className="text-[15px] font-bold tracking-wider uppercase">Поиск в геофайлах</DialogTitle>
          <DialogDescription>Покажет, в каких категориях геофайлов есть домен или IP-адрес</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <Tabs value={geoType} onValueChange={(value) => switchType(value as GeoType)}>
            <TabsList className="w-full">
              <TabsTrigger value="domain" className="flex-1">
                <IconWorld /> GeoSite
              </TabsTrigger>
              <TabsTrigger value="ip" className="flex-1">
                <IconServer /> GeoIP
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <Field>
            <FieldLabel htmlFor="geo-scan-input">{geoType === 'ip' ? 'IP-адрес или домен' : 'Домен'}</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <IconSearch />
              </InputGroupAddon>
              <InputGroupInput
                id="geo-scan-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canScan && scan()}
                placeholder={geoType === 'ip' ? '1.1.1.1 или www.google.com' : 'www.google.com'}
                autoComplete="off"
                spellCheck={false}
              />
              {input && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Очистить"
                    onClick={() => setInput('')}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <ClearIcon className="size-3.5" />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
            <FieldDescription>Нажмите на найденную категорию, чтобы скопировать её для правила маршрутизации</FieldDescription>
          </Field>

          <div className="rounded-lg border">
            <div className="bg-muted/40 flex items-center justify-between gap-3 rounded-t-lg border-b px-4 py-2.5">
              <Field orientation="horizontal" className="w-auto">
                <Checkbox
                  id="geo-select-all"
                  checked={allSelected}
                  disabled={loading || currentFiles.length === 0}
                  onCheckedChange={() => setSelectedFiles(allSelected ? [] : [...currentFiles])}
                />
                <FieldLabel htmlFor="geo-select-all" className="font-normal">
                  Все файлы
                </FieldLabel>
              </Field>
              <span className="text-muted-foreground text-sm tabular-nums">
                {selectedFiles.length} из {currentFiles.length}
              </span>
            </div>

            {loading ? (
              <div className="flex flex-col gap-2 p-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 rounded-md" />
                ))}
              </div>
            ) : currentFiles.length === 0 ? (
              <Empty className="p-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <IconFiles />
                  </EmptyMedia>
                  <EmptyTitle className="text-base">Геофайлы не найдены</EmptyTitle>
                  <EmptyDescription>Файлы {geoType === 'ip' ? 'GeoIP' : 'GeoSite'} отсутствуют в каталоге ядра</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="divide-y">
                {currentFiles.map((file) => {
                  const status = fileStatuses[file]
                  const isChecked = selectedFiles.includes(file)
                  return (
                    <li key={file} className="flex flex-col gap-2 px-4 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <Checkbox id={`geo-file-${file}`} checked={isChecked} onCheckedChange={() => toggleFile(file)} />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                          <label htmlFor={`geo-file-${file}`} className="min-w-0 cursor-pointer truncate text-sm font-medium">
                            {file}
                          </label>
                          {mtimes[file] != null && (
                            <span className="text-muted-foreground shrink-0 text-xs">обновлён {formatMtime(mtimes[file])}</span>
                          )}
                        </div>
                        <FileStatusView status={status} />
                      </div>
                      {status?.categories.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pl-7">
                          {status.categories.map((cat) => (
                            <Badge
                              key={cat}
                              variant={geoType === 'domain' ? 'rose' : 'sky'}
                              render={<button type="button" />}
                              title="Скопировать для правила"
                              onClick={() =>
                                copyText(`"ext:${file}:${cat.toLowerCase()}"`).then((ok) =>
                                  ok ? showToast('Категория скопирована') : showToast('Ошибка копирования', 'error')
                                )
                              }
                              className="h-6 cursor-pointer rounded-md px-2 hover:opacity-80"
                            >
                              {cat}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter className="border-t px-5 py-3">
          <Button variant="outline" onClick={close}>
            Закрыть
          </Button>
          <Button onClick={scan} disabled={!canScan}>
            {scanning && <Spinner data-icon="inline-start" />}
            {scanning ? 'Поиск…' : 'Найти'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FileStatusView({ status }: { status?: FileStatus }) {
  if (!status || status.status === 'idle') return null
  if (status.status === 'scanning') return <Spinner className="text-muted-foreground shrink-0" />
  return (
    <span className="shrink-0">
      {status.status === 'found' && <StatusPill tone="ok">Найдено: {status.categories.length}</StatusPill>}
      {status.status === 'not-found' && <StatusPill tone="neutral">Нет</StatusPill>}
      {status.status === 'error' && <StatusPill tone="bad">Ошибка</StatusPill>}
    </span>
  )
}
