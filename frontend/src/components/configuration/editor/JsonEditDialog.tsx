import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { IconCode, IconDeviceFloppy } from '@tabler/icons-react'
import { useRef } from 'react'
import { ProviderEditor, type ProviderEditorHandle } from './ProviderEditor'

interface Props {
  /** Dialog is open while an item is being edited; `editorKey` remounts the editor for a new item. */
  editing: { key: number } | null
  title: string
  content: string
  error?: string
  isDirty: boolean
  onChange: (value: string) => void
  onValidationChange: (error: string | undefined) => void
  onSave: () => void
  onClose: () => void
}

/** JSON editor dialog for a single item of a visual editor (outbound, routing rule, balancer). */
export function JsonEditDialog({ editing, title, content, error, isDirty, onChange, onValidationChange, onSave, onClose }: Props) {
  const editorRef = useRef<ProviderEditorHandle>(null)

  return (
    <Dialog open={editing != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4 pr-14">
          <DialogTitle className="truncate text-[15px] font-bold tracking-wider">{title}</DialogTitle>
          <DialogDescription className={error ? 'text-rose-600 dark:text-rose-400' : undefined}>
            {error || 'Изменения попадут в редактор файла после нажатия «Готово»'}
          </DialogDescription>
        </DialogHeader>
        <div className="bg-input-background relative h-[60dvh] min-h-40 shrink overflow-hidden">
          {editing != null && (
            <ProviderEditor
              ref={editorRef}
              key={editing.key}
              content={content}
              language="json"
              lineWrap={false}
              onChange={onChange}
              onSave={onSave}
              onValidationChange={onValidationChange}
            />
          )}
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="outline" disabled={!!error} onClick={() => void editorRef.current?.format()}>
                  <IconCode data-icon="inline-start" /> Формат
                </Button>
              }
            />
            <TooltipContent side="top">
              Форматировать JSON <Kbd>Shift+Alt+F</Kbd>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button disabled={!isDirty || !!error} onClick={onSave}>
                  <IconDeviceFloppy data-icon="inline-start" /> Готово
                </Button>
              }
            />
            <TooltipContent side="top">
              Применить к файлу <Kbd>Ctrl+S</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </DialogContent>
    </Dialog>
  )
}
