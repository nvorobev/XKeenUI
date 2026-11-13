import { apiCall } from './api'

type UploadResult = { success: boolean; error?: string }

export const MAX_BACKUP_BYTES = 32 * 1024 * 1024

async function transfer<T>(endpoint: string, file: File | undefined, read: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)
  try {
    const response = await fetch(`/api/backup/${endpoint}`, {
      method: file ? 'POST' : 'GET',
      ...(file ? { body: file, headers: { 'Content-Type': 'application/x-tar' } } : {}),
      signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('auth-required'))
      throw new Error(response.status === 401 ? 'Необходимо войти в панель' : `Ошибка передачи архива: HTTP ${response.status}`)
    }
    return await read(response)
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Время передачи архива истекло. Повторите операцию.', { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function downloadBackupFile(name: string): Promise<Blob> {
  return transfer(`download?name=${encodeURIComponent(name)}`, undefined, (response) => response.blob())
}

export async function uploadBackupFile(file: File): Promise<void> {
  if (file.size === 0) throw new Error('Архив пустой')
  if (file.size > MAX_BACKUP_BYTES) throw new Error('Архив должен быть не больше 32 МБ')
  await transfer('upload', file, async (response) => {
    const result = (await response.json()) as UploadResult
    if (!result.success) throw new Error(result.error || 'Не удалось загрузить копию')
  })
}

export async function restoreBackupAndWait(name: string, contents?: string[]): Promise<{ panel_restarting: boolean }> {
  // randomUUID is unavailable on HTTP router panels; getRandomValues works there.
  const operation_id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  let response: { success: boolean; error?: string } | undefined
  try {
    response = await apiCall('POST', 'backup', { name, ...(contents?.length ? { contents } : {}), operation_id }, { timeoutMs: 15000 })
  } catch {
    // A network interruption during XKeen restart does not cancel the server task.
  }
  if (response && !response.success) throw new Error(response.error || 'Не удалось восстановить копию')
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    let result:
      { success: boolean; restore?: { operation_id: string; phase: string; error?: string; panel_restarting: boolean } } | undefined
    try {
      result = await apiCall('GET', 'backup/restore-status', undefined, { timeoutMs: 5000 })
    } catch {
      // The daemon is replacing itself; wait for the new one to load its settings.
    }
    const status = result?.success ? result.restore : undefined
    if (status?.operation_id === operation_id) {
      if (status.phase === 'failed') throw new Error(status.error || 'Не удалось применить копию')
      if (status.phase === 'done') return { panel_restarting: status.panel_restarting }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('Не удалось дождаться применения копии. Проверьте журнал панели и доступность роутера.')
}
