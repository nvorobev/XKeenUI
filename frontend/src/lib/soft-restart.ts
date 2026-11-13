import { apiCall } from './api'
import { getAppState } from './store'
import type { AppAction } from './types'

type ToastType = 'success' | 'error'

/**
 * Restarts the core after a visual editor saved its file. Whatever happens, including a lost
 * connection, the service status ends with what the backend reports instead of staying `pending`
 * (which would block the service controls).
 */
export async function softRestartAfterSave(
  core: string,
  dispatch: (action: AppAction) => void,
  showToast: (message: string, type?: ToastType) => void
): Promise<void> {
  dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Перезапуск...' })
  try {
    const result = await apiCall<{ success: boolean; error?: string }>('POST', 'control', { action: 'softRestart', core })
    showToast(result?.success ? 'Изменения применены' : `Ошибка: ${result?.error}`, result?.success ? 'success' : 'error')
  } catch (reason) {
    showToast(`Ошибка перезапуска: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
  } finally {
    const state = await apiCall<{ success: boolean; running?: boolean }>('GET', 'control').catch(() => null)
    dispatch({ type: 'SET_SERVICE_STATUS', status: state?.success && state.running ? 'running' : 'stopped' })
  }
}

/**
 * Marks a config as saved with `saved`. Edits typed while the save was in flight (`latest`)
 * are newer: they stay in the editor state and keep the file marked as changed.
 */
export function markConfigSaved(dispatch: (action: AppAction) => void, index: number, saved: string, latest: string): void {
  dispatch({ type: 'SAVE_CONFIG', index, content: saved })
  if (latest !== saved) dispatch({ type: 'UPDATE_CONFIG_DIRTY', index, content: latest, isDirty: true })
}

/**
 * Marks `file` as saved after a request that took a while. The tab may have changed meanwhile:
 * the file is found by name, and the editor text counts only when it still shows that file
 * (`editorText` is undefined otherwise), else the stored draft of that file is kept.
 */
export function markFileSaved(dispatch: (action: AppAction) => void, file: string, saved: string, editorText: string | undefined): void {
  const configs = getAppState().configs
  const index = configs.findIndex((config) => config.file === file)
  if (index < 0) return
  markConfigSaved(dispatch, index, saved, editorText ?? configs[index].content)
}

/** The file the shared config editor shows; set where a file is loaded into the editor. */
let editorFile: string | undefined

export function setEditorFile(file: string): void {
  editorFile = file
}

/** Whether the shared editor still shows `file` (a visual editor may have been switched away from it). */
export function editorShowsFile(file: string): boolean {
  return editorFile === file
}
