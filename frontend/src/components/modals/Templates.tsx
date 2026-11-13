import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { IconFileText, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { capitalize } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import { cn } from '../../lib/utils'

const TEMPLATES_URL = 'https://raw.githubusercontent.com/nvorobev/XKeenUI/main/templates/templates.json'
let templatesCache: Record<string, { name: string; url: string }[]> | null = null

export function TemplateModal({ onImport }: { onImport: (url: string) => Promise<void> }) {
  const { state, showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const { currentCore } = state
  const [templates, setTemplates] = useState<{ name: string; url: string }[]>([])
  const [selectedUrl, setSelectedUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showTemplateModal', show: false })

  useEffect(() => {
    if (modals.showTemplateModal) loadTemplates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modals.showTemplateModal, currentCore])

  async function loadTemplates() {
    if (!templatesCache) {
      setLoading(true)
      try {
        const res = await fetch(TEMPLATES_URL)
        if (!res.ok) throw new Error(res.statusText)
        templatesCache = await res.json()
      } catch {
        showToast('Не удалось загрузить шаблоны', 'error')
        setLoading(false)
        return
      }
      setLoading(false)
    }
    const list = templatesCache?.[currentCore] ?? []
    setTemplates(list)
    if (list.length > 0) setSelectedUrl(list[0].url)
  }

  async function handleImport() {
    if (!selectedUrl) return
    setImporting(true)
    try {
      await onImport(selectedUrl)
      close()
    } catch (e: any) {
      showToast(`Ошибка импорта: ${e.message}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={modals.showTemplateModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4 pr-14">
          <DialogTitle className="text-[15px] font-bold tracking-wider uppercase">Шаблоны конфигурации</DialogTitle>
          <DialogDescription>
            Готовые конфигурации для {capitalize(currentCore)}
            {!loading && templates.length > 0 && ` · ${templates.length}`}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-12 rounded-lg" />
              ))}
            </div>
          ) : templates.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <IconFileText />
                </EmptyMedia>
                <EmptyTitle>Шаблонов нет</EmptyTitle>
                <EmptyDescription>Для {capitalize(currentCore)} шаблоны не найдены или не загрузились</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" size="sm" onClick={() => void loadTemplates()}>
                  <IconRefresh data-icon="inline-start" />
                  Повторить
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <RadioGroup value={selectedUrl} onValueChange={setSelectedUrl} aria-label="Шаблон" className="gap-0 divide-y rounded-lg border">
              {templates.map((template, i) => (
                <label
                  key={i}
                  htmlFor={`tpl-${i}`}
                  className={cn(
                    'flex min-w-0 cursor-pointer items-center gap-3 px-4 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg',
                    selectedUrl === template.url ? 'bg-primary/10' : 'hover:bg-muted/50'
                  )}
                >
                  <RadioGroupItem value={template.url} id={`tpl-${i}`} />
                  <span className="min-w-0 truncate text-sm font-medium">{template.name}</span>
                </label>
              ))}
            </RadioGroup>
          )}
        </div>

        <DialogFooter className="border-t px-5 py-3">
          <Button variant="outline" onClick={close}>
            Отмена
          </Button>
          <Button onClick={handleImport} disabled={!selectedUrl || importing || loading}>
            {importing && <Spinner data-icon="inline-start" />}
            Импортировать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
