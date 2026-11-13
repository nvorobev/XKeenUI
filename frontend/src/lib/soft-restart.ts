import { apiCall } from './api'
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
