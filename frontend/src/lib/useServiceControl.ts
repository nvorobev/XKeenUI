import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_DNS_CONFIG, ensureDnsEnabled, setDnsEnabled } from '../components/configuration/mihomo/DnsPanel'
import { apiCall, clashFetch } from './api'
import { saveConfigRevision } from './config-history'
import { bumpDnsRefresh, fetchDnsStatus, getAppState, syncClashApiPort, useAppContext, useDnsStatusStore } from './store'

export type SystemStats = { memoryUsed: number | null; memoryTotal: number | null; cpuUsage: number | null }

const STATUS_REFRESH_MS = 3000

type ControlResult = { success: boolean; output?: string; error?: string }

/** POST /api/control that never rejects: a lost response must not leave the status stuck in 'pending'. */
function control(action: string): Promise<ControlResult> {
  return apiCall<ControlResult>('POST', 'control', { action }).catch((e) => ({
    success: false,
    error: e instanceof Error ? e.message : String(e),
  }))
}

async function readYamlConfig() {
  const configsResult = await apiCall<{ success: boolean; configs?: { file: string; content: string }[] }>('GET', 'configs')
  return configsResult.success ? configsResult.configs?.find((c) => c.file.endsWith('/config.yaml')) : undefined
}

async function applyAutoDns(setupFilter: boolean) {
  const yamlConfig = await readYamlConfig()
  if (!yamlConfig) return
  const configContent = ensureDnsEnabled(yamlConfig.content, DEFAULT_DNS_CONFIG)
  const result = await apiCall<{ success: boolean; error?: string }>('POST', 'dns', {
    config_content: configContent,
    setup_filter: setupFilter,
  })
  if (!result.success) throw new Error(result.error || 'Не удалось сохранить конфигурацию DNS')
  const historyError = await saveConfigRevision(yamlConfig.file, configContent, yamlConfig.content)
  if (historyError) throw new Error(`Конфигурация DNS сохранена, но история не записана: ${historyError}`)
}

async function persistDnsEnabled(enabled: boolean) {
  const yamlConfig = await readYamlConfig()
  if (!yamlConfig) return
  const updated = setDnsEnabled(yamlConfig.content, enabled)
  const result = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs', { file: yamlConfig.file, content: updated })
  if (!result.success) throw new Error(result.error || 'Не удалось сохранить конфигурацию DNS')
  const historyError = await saveConfigRevision(yamlConfig.file, updated, yamlConfig.content)
  if (historyError) throw new Error(`Конфигурация DNS сохранена, но история не записана: ${historyError}`)
}

/**
 * XKeen service control shared by the cabinet header: periodic status refresh,
 * start / stop / hard restart (with mihomo auto-DNS and the DNS warning before stop).
 */
export function useServiceControl(onRefreshStatus: () => void) {
  const { state, dispatch, showToast } = useAppContext({ includeSettings: true })
  const { serviceStatus, currentCore, settings } = state

  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending' || serviceStatus === 'loading'

  const [dnsWarningOpen, setDnsWarningOpen] = useState(false)

  useEffect(() => {
    if (currentCore === 'mihomo') fetchDnsStatus().catch(() => {})
  }, [currentCore])

  const prevServiceStatusRef = useRef(serviceStatus)
  useEffect(() => {
    const prev = prevServiceStatusRef.current
    prevServiceStatusRef.current = serviceStatus
    if (prev === 'pending' && serviceStatus === 'running' && currentCore === 'mihomo') {
      fetchDnsStatus().catch(() => {})
    }
  }, [serviceStatus, currentCore])

  useEffect(() => {
    const interval = setInterval(() => {
      if (serviceStatus !== 'pending' && !document.hidden) onRefreshStatus()
    }, STATUS_REFRESH_MS)
    return () => clearInterval(interval)
  }, [serviceStatus, onRefreshStatus])

  const setPending = useCallback(
    (text: string) => dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: text }),
    [dispatch]
  )

  async function start() {
    setPending('Запуск...')
    const result = await control('start')
    showToast(result.success ? 'XKeen запущен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    if (!result.success) {
      dispatch({ type: 'SET_SERVICE_STATUS', status: 'stopped' })
      onRefreshStatus()
      return
    }
    syncClashApiPort()
    if (settings.autoDns !== 'disabled' && getAppState().currentCore === 'mihomo') {
      try {
        await applyAutoDns(settings.autoDns === 'with_filter')
        const { clashApiPort, clashApiSecret, clashApiUnix } = getAppState()
        await clashFetch(clashApiPort ?? '', 'configs', {
          method: 'PUT',
          secret: clashApiSecret,
          unix: clashApiUnix,
          body: {},
        })
        bumpDnsRefresh()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        showToast(`XKeen запущен, но авто-включение DNS не удалось: ${msg}`, 'error')
      }
    }
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'running' })
    syncClashApiPort(200)
    onRefreshStatus()
  }

  async function stop() {
    const cached = useDnsStatusStore.getState().status
    const dnsManaged = currentCore === 'mihomo' && !!cached && cached.dnsOverride && cached.dnsMihomo
    if (dnsManaged) {
      setDnsWarningOpen(true)
      return
    }
    setPending('Остановка...')
    const result = await control('stop')
    showToast(result.success ? 'XKeen остановлен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: result.success ? 'stopped' : 'running' })
    onRefreshStatus()
  }

  async function disableDnsAndStop() {
    setDnsWarningOpen(false)
    setPending('Остановка...')
    const stopResult = await control('stop')
    showToast(
      stopResult.success ? 'XKeen остановлен' : `${stopResult.output || stopResult.error}`,
      stopResult.success ? 'success' : 'error'
    )
    dispatch({ type: 'SET_SERVICE_STATUS', status: stopResult.success ? 'stopped' : 'running' })
    if (!stopResult.success) {
      onRefreshStatus()
      return
    }
    try {
      await persistDnsEnabled(false)
      const result = await apiCall<{ success: boolean; error?: string }>('DELETE', 'dns', {})
      if (result.success) {
        showToast('Управление DNS отключено')
      } else {
        showToast(`Ошибка DNS: ${result.error}`, 'error')
      }
    } catch {
      showToast('Ошибка отключения DNS', 'error')
    }
    onRefreshStatus()
  }

  async function restart() {
    setPending('Перезапуск...')
    const result = await control('hardRestart')
    showToast(result.success ? 'XKeen перезапущен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: result.success ? 'running' : 'stopped' })
    if (result.success) {
      syncClashApiPort(200)
    }
    onRefreshStatus()
  }

  return {
    state,
    isRunning,
    isPending,
    start,
    stop,
    restart,
    disableDnsAndStop,
    dnsWarningOpen,
    setDnsWarningOpen,
  }
}

/** Router CPU / RAM from GET /api/system, polled only while `enabled` (e.g. the service popover is open). */
export function useSystemStats(enabled: boolean) {
  const [stats, setStats] = useState<SystemStats | null>(null)
  useEffect(() => {
    if (!enabled) return
    let mounted = true
    const refresh = async () => {
      try {
        const result = await apiCall<{ success: boolean } & SystemStats>('GET', 'system')
        if (mounted && result.success) setStats(result)
      } catch {
        // The header stays usable if system statistics are unavailable.
      }
    }
    refresh()
    const interval = setInterval(refresh, STATUS_REFRESH_MS)
    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [enabled])
  return stats
}
