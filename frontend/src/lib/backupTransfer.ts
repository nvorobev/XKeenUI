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
