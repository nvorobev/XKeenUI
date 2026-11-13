import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { IconAlertTriangle } from '@tabler/icons-react'
import { useModalContext } from '../../lib/store'

export function CommentsWarningModal() {
  const { modals, dispatch } = useModalContext()

  function close() {
    dispatch({
      type: 'SHOW_MODAL',
      modal: 'showCommentsWarningModal',
      show: false,
    })
    dispatch({ type: 'SET_PENDING_SAVE_ACTION', action: null })
  }

  function confirm() {
    modals.pendingSaveAction?.()
    close()
  }

  return (
    <Dialog open={modals.showCommentsWarningModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-md flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b px-5 py-4 pr-14">
          <DialogTitle className="text-[15px] font-bold tracking-wider uppercase">Комментарии будут удалены</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 gap-3 overflow-y-auto px-5 py-4">
          <IconAlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden />
          <DialogDescription>
            В файле есть комментарии. При сохранении из визуального редактора они будут потеряны. Сохранить всё равно?
          </DialogDescription>
        </div>
        <DialogFooter className="border-t px-5 py-3">
          <Button variant="outline" onClick={close}>
            Отмена
          </Button>
          <Button onClick={confirm}>Сохранить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
