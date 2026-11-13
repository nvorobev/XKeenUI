import { apiCall } from './api'

type Reply = { success: boolean; error?: string }

/**
 * Undoes a DNS enable whose Mihomo config did not apply: the router gets its previous DNS back
 * and Mihomo its previous config (the new one would take port 53 from the router on the next
 * start). Returns what could not be restored, or null when both are back.
 */
export async function rollbackDnsEnable(file: string, previousContent: string): Promise<string | null> {
  const problems: string[] = []
  const router = await apiCall<Reply>('DELETE', 'dns', {}).catch((e: unknown) => ({
    success: false,
    error: e instanceof Error ? e.message : String(e),
  }))
  if (!router.success) problems.push(`настройки DNS роутера: ${router.error || 'ошибка'}`)
  const config = await apiCall<Reply>('PUT', 'configs', { file, content: previousContent }).catch((e: unknown) => ({
    success: false,
    error: e instanceof Error ? e.message : String(e),
  }))
  if (!config.success) problems.push(`конфигурацию Mihomo: ${config.error || 'ошибка'}`)
  return problems.length ? `Не удалось вернуть ${problems.join('; ')}` : null
}
