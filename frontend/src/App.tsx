import { AnimatePresence, motion } from 'framer-motion'
import { parse as parseJsonc } from 'jsonc-parser'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { LoginForm } from './components/auth/Login'
import { UsersPage } from './components/auth/Users'
import type { CodeMirrorRef } from './components/configuration/CodeMirror'
import { ConfigPanel } from './components/configuration/ConfigPanel'
import { XrayServers } from './components/configuration/xray/servers'
import { LogPanel } from './components/log/LogPanel'
import { ImportModal } from './components/modals/AddOutbound'
import { BackupsPage } from './components/modals/Backups'
import { CommentsWarningModal } from './components/modals/CommentsWarning'
import { CoreManagementPage } from './components/modals/CoreManagement'
import { GeoScanModal } from './components/modals/GeoScan'
import { ImportAmneziaModal } from './components/modals/ImportAmnezia'
import { RouteTesterModal } from './components/modals/RouteTester'
import { SettingsPage } from './components/modals/Settings'
import { TemplateModal } from './components/modals/Templates'
import { UpdatesPage } from './components/modals/Update'
import { AppSidebar, MobileNav, TopBar } from './components/shell/AppSidebar'
import { Overview } from './components/shell/Overview'
import { TrafficMonitor } from './components/shell/TrafficMonitor'
import { useCollectTraffic } from './components/shell/trafficHistory'
import { Toast } from './components/ui/toast'
import { apiCall, capitalize } from './lib/api'
import { useLazyMount } from './lib/loader'
import { listMihomoTakenNames, replaceMihomoProvider, replaceMihomoProxy } from './lib/mihomoReplace'
import { navigate, usePage } from './lib/navigation'
import {
  fetchClashProxies,
  fetchClashRuleProviders,
  fetchPingHistory,
  getAppState,
  syncClashApiPort,
  useAppActions,
  useAppContext,
  useCurrentCore,
  useModalContext,
  useSettings,
} from './lib/store'
import { applyEmojiFont, applyTheme, THEME_MEDIA_QUERY } from './lib/theme'
import {
  DEFAULT_MIHOMO_REPO,
  DEFAULT_PING_TEST_TIMEOUT,
  DEFAULT_PING_TEST_URL,
  DEFAULT_XRAY_REPO,
  type Config,
  type EmojiFont,
  type ThemeMode,
} from './lib/types'
import { parseClashApiCredentials } from './lib/utils'

function useThemeMode(theme: ThemeMode) {
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'auto') return

    const media = window.matchMedia(THEME_MEDIA_QUERY)
    const syncTheme = () => applyTheme('auto')

    media.addEventListener('change', syncTheme)
    return () => media.removeEventListener('change', syncTheme)
  }, [theme])
}

function useEmojiFont(font: EmojiFont) {
  useEffect(() => {
    applyEmojiFont(font)
  }, [font])
}

interface ModalManagerProps {
  onGenerate: (uri: string, excludeName?: string) => { content: string; type: string } | null
  onAddToConfig: (content: string, type: string, position: 'start' | 'end') => void
  onReplace: (kind: 'proxy' | 'provider', content: string, oldName: string, renameRefs: boolean) => void
  onImportTemplate: (url: string) => Promise<void>
}

const ModalManager = memo(function ModalManager({ onGenerate, onAddToConfig, onReplace, onImportTemplate }: ModalManagerProps) {
  const { modals } = useModalContext()

  const mountCommentsWarning = useLazyMount(modals.showCommentsWarningModal)
  const mountImport = useLazyMount(modals.showImportModal)
  const mountAmneziaImport = useLazyMount(modals.showImportAmneziaModal)
  const mountTemplate = useLazyMount(modals.showTemplateModal)
  const mountGeoScan = useLazyMount(modals.showGeoScanModal)
  const mountRouteTest = useLazyMount(modals.showRouteTestModal)

  return (
    <>
      {mountCommentsWarning && <CommentsWarningModal />}
      {mountImport && <ImportModal onGenerate={onGenerate} onAddToConfig={onAddToConfig} onReplace={onReplace} />}
      {mountAmneziaImport && <ImportAmneziaModal onAddToConfig={onAddToConfig} />}
      {mountTemplate && <TemplateModal onImport={onImportTemplate} />}
      {mountGeoScan && <GeoScanModal />}
      {mountRouteTest && <RouteTesterModal />}
    </>
  )
})

function AppContent({ onLogout }: { onLogout: () => void }) {
  const { dispatch, showToast } = useAppActions()
  const guiOutbounds = useSettings((s) => s.guiOutbounds)
  const activeCore = useCurrentCore()
  const editorRef = useRef<CodeMirrorRef | null>(null)
  const configActionsRef = useRef<{ switchTab: (index: number) => void; getActiveIndex: () => number }>({
    switchTab: () => {},
    getActiveIndex: () => 0,
  })

  const checkStatus = useCallback(async () => {
    const data = await apiCall<any>('GET', 'control')
    if (!data.success) return null
    const currentCore = data.currentCore || 'xray'
    dispatch({
      type: 'SET_CORE_INFO',
      currentCore,
      coreVersions: getAppState().coreVersions,
      availableCores: data.cores || [],
    })
    dispatch({ type: 'SET_SERVICE_STATUS', status: data.running ? 'running' : 'stopped' })
    return currentCore
  }, [dispatch])

  const loadConfigs = useCallback(
    async (core?: string, skipProxies = false, silent = false): Promise<Config[]> => {
      if (!silent) dispatch({ type: 'SET_CONFIGS_LOADING', loading: true })
      try {
        const result = await apiCall<any>('GET', core ? `configs?core=${core}` : 'configs')
        if (result.success && result.configs) {
          const configs: Config[] = result.configs.map((c: any) => ({ ...c, savedContent: c.content, isDirty: false }))
          dispatch({ type: 'SET_CONFIGS', configs })
          const yamlConfig = configs.find((c: any) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')
          const { port, secret, unix } = yamlConfig
            ? parseClashApiCredentials(yamlConfig.content)
            : { port: null, secret: null, unix: null }
          dispatch({ type: 'SET_DASHBOARD_PORT', port, secret, unix } as any)
          const appState = getAppState()
          const activeCores = core ?? appState.currentCore
          if ((port || unix) && activeCores === 'mihomo' && !skipProxies && appState.serviceStatus === 'running') {
            fetchClashProxies(port ?? '', secret, false, unix)
            fetchClashRuleProviders(port ?? '', secret, unix)
          }
          return configs
        } else {
          if (!silent) dispatch({ type: 'SET_CONFIGS_LOADING', loading: false })
          showToast('Не удалось загрузить конфигурации', 'error')
        }
      } catch (e: any) {
        if (!silent) dispatch({ type: 'SET_CONFIGS_LOADING', loading: false })
        showToast(`${e.message}`, 'error')
      }
      return []
    },
    [dispatch, showToast]
  )

  const fetchVersion = useCallback(
    async (path: string, showUpdateToast: boolean) => {
      try {
        const data = await apiCall<any>('GET', path)
        if (!data.success) return

        const ui = data['xkeen-ui']
        if (!ui) return

        let isOutdatedCore = false
        const coreVersions: Record<string, string> = {}
        for (const core of ['mihomo', 'xray']) {
          if (data[core]?.version) {
            coreVersions[core] = data[core].version
            if (data[core].outdated) isOutdatedCore = true
          }
        }

        dispatch({
          type: 'SET_VERSION',
          version: ui.version,
          isOutdatedUI: !!ui.outdated,
          isOutdatedCore,
        })

        if (Object.keys(coreVersions).length > 0) {
          const appState = getAppState()
          dispatch({
            type: 'SET_CORE_INFO',
            currentCore: appState.currentCore,
            coreVersions: { ...appState.coreVersions, ...coreVersions },
            availableCores: appState.availableCores,
          })
        }

        if (!showUpdateToast) return
        if (ui.show_toast)
          showToast({
            title: 'Доступно обновление',
            body: 'Доступна новая версия XKeen UI',
            persistent: true,
            id: 'update-ui',
            ...(ui.link && { action: { url: ui.link } }),
          })

        for (const core of ['mihomo', 'xray']) {
          const entry = data[core]
          if (entry?.show_toast) {
            showToast({
              title: 'Доступно обновление',
              body: `Доступна новая версия ${capitalize(core)}`,
              persistent: true,
              id: `update-${core}`,
              ...(entry.link ? { action: { url: entry.link } } : {}),
            })
          }
        }
      } catch {
        /* ignore */
      }
    },
    [dispatch, showToast]
  )

  const checkVersion = useCallback(
    async (showUpdateToast = false) => {
      await fetchVersion('version', showUpdateToast)
      if (showUpdateToast) await fetchVersion('version/check', true)
    },
    [fetchVersion]
  )

  useEffect(() => {
    const loadSettings = async () => {
      const data = await apiCall<any>('GET', 'settings')
      if (data.success) {
        dispatch({
          type: 'SET_SETTINGS',
          settings: {
            autoApply: data.gui.auto_apply,
            guiRouting: data.gui.routing,
            guiOutbounds: data.gui.outbounds ?? false,
            guiLog: data.gui.log,
            autoCheckUI: data.updater.auto_check_ui ?? 2,
            autoCheckCore: data.updater.auto_check_core ?? 2,
            configHistoryMaxSnapshots: data.config_history?.max_snapshots ?? 0,
            backupCore: data.updater.backup_core,
            githubProxies: data.updater.github_proxy || [],
            xrayRepo: data.updater.xray_repo ?? DEFAULT_XRAY_REPO,
            mihomoRepo: data.updater.mihomo_repo ?? DEFAULT_MIHOMO_REPO,
            pingTestUrl: data.clash_api?.ping_url ?? DEFAULT_PING_TEST_URL,
            pingTestTimeout: data.clash_api?.ping_timeout ?? DEFAULT_PING_TEST_TIMEOUT,
            showSourceName: data.clash_api?.show_source_name ?? false,
            closeConnectionsOnApply: data.clash_api?.close_connections_on_apply ?? false,
            mobileLayout: data.clash_api?.mobile_layout ?? true,
            pingMode: data.clash_api?.ping_mode ?? 'double_keep_alive',
            hideUnavailableProxies: data.clash_api?.hide_unavailable_proxies ?? false,
            hideUnavailableProxiesCounter: data.clash_api?.hide_unavailable_proxies_counter ?? 3,
            proxySortOrder: data.clash_api?.proxy_sort_order ?? 'default',
            autoDns: data.clash_api?.auto_dns ?? 'disabled',
            timezone: data.log.timezone,
            authEnabled: !!data.auth?.enabled,
            hiddenConfigFiles: data.ui?.hidden_files ?? [],
          },
        })
      }
    }

    const init = async () => {
      try {
        await loadSettings()
        const currentCore = await checkStatus()
        if (currentCore) loadConfigs(currentCore)
        checkVersion(true)
      } catch {
        showToast('Ошибка инициализации', 'error')
      }
    }

    init()
  }, [checkStatus, loadConfigs, dispatch, showToast, checkVersion])

  useEffect(() => {
    if (activeCore === 'xray' && guiOutbounds) fetchPingHistory()
  }, [activeCore, guiOutbounds])

  const switchCore = useCallback(
    async (core: string) => {
      const appState = getAppState()
      if (appState.serviceStatus === 'pending') return
      if (core === appState.currentCore) {
        showToast('Это ядро уже активно', 'error')
        return
      }
      // Switching replaces the editor files with the other core's ones: unsaved edits would be lost.
      if (appState.configs.some((config) => config.isDirty)) {
        showToast('Сначала сохраните или отмените изменения в редакторе конфигурации', 'error')
        return
      }
      dispatch({ type: 'SHOW_MODAL', modal: 'showCoreManageModal', show: false })
      dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Переключение...' })
      const result = await apiCall<any>('POST', 'control', { action: 'switchCore', core }).catch((e) => ({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }))
      showToast(result.success ? `Ядро изменено на ${capitalize(core)}` : `Ошибка: ${result.error}`, result.success ? 'success' : 'error')
      const data = await apiCall<any>('GET', 'control').catch(() => ({ success: false }))
      if (!data.success) {
        dispatch({ type: 'SET_SERVICE_STATUS', status: 'stopped' })
        return
      }
      dispatch({
        type: 'SET_CORE_INFO',
        currentCore: data.currentCore,
        coreVersions: getAppState().coreVersions,
        availableCores: data.cores,
      })
      dispatch({ type: 'SET_SERVICE_STATUS', status: data.running ? 'running' : 'stopped' })
      // The editor shows the files of the core that actually runs now: the new one, or the old one after a failure.
      await loadConfigs(data.currentCore)
      if (result.success) syncClashApiPort(200)
    },
    [dispatch, showToast, loadConfigs]
  )

  const generateConfig = useCallback((uri: string, excludeName?: string) => {
    const appState = getAppState()
    const currentCore = appState.currentCore
    let existingConfig = editorRef.current?.getValue() ?? ''
    if (currentCore === 'mihomo') {
      const yamlConfig = appState.configs.find((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')
      existingConfig = yamlConfig ? yamlConfig.content : existingConfig
    }
    // При замене прокси (excludeName) передаём точный список занятых имён вместо substring-хака над текстом
    // конфига — иначе "hk" вырезался бы и из "hk-2", "hk.example.com" и т.п.
    const existingParam: string | string[] = excludeName
      ? listMihomoTakenNames(existingConfig).filter((n) => n !== excludeName)
      : existingConfig
    if (typeof (window as any).generateConfigForCore === 'function')
      return (window as any).generateConfigForCore(uri, currentCore, existingParam)
    throw new Error('Parser not loaded')
  }, [])

  const importTemplate = useCallback(
    async (url: string) => {
      const appState = getAppState()
      const activeIndex = configActionsRef.current.getActiveIndex()
      let targetIndex = activeIndex
      if (appState.currentCore === 'mihomo') {
        targetIndex = appState.configs.findIndex((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')
        if (targetIndex === -1) throw new Error('Файл config.yaml не найден')
      }
      if (appState.configs[targetIndex]?.isDirty && !confirm('Несохраненные изменения будут потеряны. Продолжить?'))
        throw new Error('Отменено')
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const content = await res.text()
      if (targetIndex !== activeIndex) configActionsRef.current.switchTab(targetIndex)
      setTimeout(() => {
        if (!editorRef.current) return
        editorRef.current.setValue(content)
        dispatch({ type: 'UPDATE_CONFIG_DIRTY', index: targetIndex, isDirty: true, content })
        showToast('Шаблон импортирован')
      }, 0)
    },
    [dispatch, showToast]
  )

  const addToConfig = useCallback(
    (generated: string, type: string, position: 'start' | 'end') => {
      const appState = getAppState()
      const core = appState.currentCore
      let targetIndex = configActionsRef.current.getActiveIndex()

      if (core === 'mihomo') {
        targetIndex = appState.configs.findIndex((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')
        if (targetIndex === -1) {
          showToast('Файл config.yaml не найден', 'error')
          return
        }
      } else {
        try {
          try {
            const obj = parseJsonc(appState.configs[targetIndex].content)
            if (!Array.isArray(obj.outbounds)) throw new Error()
          } catch {
            targetIndex = appState.configs.findIndex((cfg) => {
              try {
                return Array.isArray(parseJsonc(cfg.content).outbounds)
              } catch {
                return false
              }
            })
            if (targetIndex === -1) {
              showToast('Массив outbounds не найден', 'error')
              return
            }
          }
        } catch (e: any) {
          showToast(`${e.message}`, 'error')
          return
        }
      }

      if (targetIndex !== configActionsRef.current.getActiveIndex()) configActionsRef.current.switchTab(targetIndex)

      setTimeout(() => {
        const editorWrapper = editorRef.current
        if (!editorWrapper) return
        let current = editorWrapper.getValue()
        const lineAtOffset = (text: string, offset: number) => text.slice(0, Math.min(offset, text.length)).split('\n').length
        const scrollToLine = (line: number) => setTimeout(() => editorWrapper.revealLine(Math.max(1, line)), 0)
        const insertAtOffset = (offset: number, text: string, scrollLine?: number) => {
          editorWrapper.replaceRange(offset, offset, text)
          scrollToLine(scrollLine ?? editorWrapper.offsetToLineColumn(offset).lineNumber)
        }

        if (core === 'mihomo') {
          const marker = type === 'proxy' ? 'proxies:' : 'proxy-providers:'
          const markerRegex = new RegExp(`^${marker}(.*)$`, 'm')
          const markerMatch = current.match(markerRegex)

          if (!markerMatch) {
            const eofStr = current.endsWith('\n') ? '' : '\n'
            const insertPos = current.length
            const targetLine = lineAtOffset(current, insertPos) + (eofStr ? 2 : 1)
            insertAtOffset(insertPos, `${eofStr}${marker}\n${generated}\n`, targetLine)
            return
          }

          const markerIdx = markerMatch.index!
          let markerLineEnd = current.indexOf('\n', markerIdx)
          if (markerLineEnd === -1) markerLineEnd = current.length
          else markerLineEnd += 1

          const lineContent = markerMatch[1].trim()
          if (lineContent === '[]' || lineContent === 'null') {
            const pre = current.slice(0, markerIdx)
            const post = current.slice(markerLineEnd)
            current = pre + marker + '\n' + post
            editorWrapper.replaceAll(current)
            markerLineEnd = markerIdx + marker.length + 1
          }

          if (position === 'start') {
            const line = lineAtOffset(current, markerLineEnd)
            insertAtOffset(markerLineEnd, generated + '\n', line)
          } else {
            const afterMarker = markerLineEnd
            const nextKeyMatch = current.slice(afterMarker).search(/^[a-zA-Z0-9_-]+:/m)
            const insertOffset = nextKeyMatch === -1 ? current.length : afterMarker + nextKeyMatch
            let textToInsert = generated + '\n'

            let targetLine = lineAtOffset(current, insertOffset)

            if (nextKeyMatch === -1 && !current.endsWith('\n')) {
              textToInsert = '\n' + textToInsert
              targetLine += 1
            }

            insertAtOffset(insertOffset, textToInsert, targetLine)
          }
        } else {
          try {
            const obj = parseJsonc(current)
            if (position === 'start') obj.outbounds.unshift(JSON.parse(generated))
            else obj.outbounds.push(JSON.parse(generated))
            editorWrapper.replaceAll(JSON.stringify(obj, null, 2))
            scrollToLine(position === 'start' ? 1 : editorWrapper.getLineCount())
          } catch (e: any) {
            showToast(`Ошибка парсинга: ${e.message}`, 'error')
          }
        }
      }, 150)
    },
    [showToast]
  )

  const onReplace = useCallback(
    (kind: 'proxy' | 'provider', content: string, oldName: string, renameRefs: boolean) => {
      const appState = getAppState()
      const targetIndex = appState.configs.findIndex((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')

      if (targetIndex === -1) {
        showToast('Файл config.yaml не найден', 'error')
        return
      }

      if (targetIndex !== configActionsRef.current.getActiveIndex()) configActionsRef.current.switchTab(targetIndex)

      setTimeout(() => {
        const editorWrapper = editorRef.current
        if (!editorWrapper) return
        try {
          const buffer = editorWrapper.getValue()
          const res =
            kind === 'proxy'
              ? replaceMihomoProxy(buffer, oldName, content, { renameRefs })
              : replaceMihomoProvider(buffer, oldName, content, { renameRefs })
          editorWrapper.replaceAll(res.text)
          setTimeout(() => editorWrapper.revealLine(res.line), 0)
          const label = kind === 'proxy' ? 'Прокси' : 'Провайдер'
          const message =
            res.name !== oldName
              ? `${label} «${oldName}» заменён на «${res.name}»${res.refs > 0 ? `, обновлено ссылок: ${res.refs}` : ''}`
              : `${label} «${oldName}» заменён`
          showToast(message)
        } catch (e: any) {
          showToast(e.message, 'error')
        }
      }, 150)
    },
    [showToast]
  )

  const logout = onLogout
  const page = usePage()
  useCollectTraffic(page === 'overview' || page === 'traffic')
  const mountUpdates = useLazyMount(page === 'updates')
  const isXray = activeCore !== 'mihomo'
  const hasUnsavedConfigs = useAppContext({ includeConfigs: true }).state.configs.some((config) => config.isDirty)
  const refreshConfigs = useCallback(() => loadConfigs(undefined, false, true), [loadConfigs])
  useEffect(() => {
    if (page === 'servers' && !isXray) navigate('overview')
  }, [page, isXray])
  const onInstalled = useCallback(() => void checkVersion(), [checkVersion])
  const refreshStatus = useCallback(() => void checkStatus().catch(() => {}), [checkStatus])
  const openModal = useCallback(
    (modal: string) => {
      const pages = {
        showBackupsModal: 'backups',
        showCoreManageModal: 'cores',
        showSettingsModal: 'settings',
        showUsersPage: 'users',
        showUpdateModal: 'updates',
      } as const
      if (modal in pages) navigate(pages[modal as keyof typeof pages])
      else setTimeout(() => dispatch({ type: 'SHOW_MODAL', modal: modal as any, show: true }), 0)
    },
    [dispatch]
  )

  return (
    <div className="bg-muted dark:bg-background flex min-h-dvh flex-col md:h-dvh">
      <TopBar
        onRefreshStatus={refreshStatus}
        onOpenModal={openModal}
        onOpenUpdate={(core: string) => {
          dispatch({ type: 'SET_UPDATE_MODAL_CORE', core })
          openModal('showUpdateModal')
        }}
        onLogout={logout}
      />
      <MobileNav page={page} isXray={isXray} />
      <div className="flex min-h-0 flex-1">
        <AppSidebar page={page} isXray={isXray} onOpenModal={openModal} />
        <main className="flex min-w-0 flex-1 flex-col md:overflow-y-auto">
          <div className="flex min-h-0 w-full flex-1 flex-col gap-4 px-3 py-3 md:px-6 md:py-6">
            {page === 'overview' && <Overview isXray={isXray} onOpenModal={openModal} />}
            {page === 'traffic' && <TrafficMonitor />}
            {page === 'backups' && <BackupsPage onRefreshConfigs={refreshConfigs} />}
            {page === 'cores' && (
              <CoreManagementPage
                onSwitchCore={switchCore}
                onOpenUpdate={(core) => {
                  dispatch({ type: 'SET_UPDATE_MODAL_CORE', core })
                  navigate('updates')
                }}
              />
            )}
            {page === 'settings' && <SettingsPage />}
            {page === 'users' && <UsersPage />}

            {mountUpdates && (
              <div className={page === 'updates' ? '' : 'hidden'}>
                <UpdatesPage active={page === 'updates'} onInstalled={onInstalled} />
              </div>
            )}
            {page === 'servers' && isXray && <XrayServers onChanged={refreshConfigs} hasUnsavedConfigs={hasUnsavedConfigs} />}
            {/* The editor stays mounted: unsaved edits and GUI panels depend on it. */}
            <div className={page === 'config' ? 'flex flex-col md:min-h-0 md:flex-1' : 'hidden'}>
              <ConfigPanel
                editorRef={editorRef}
                configActionsRef={configActionsRef}
                onOpenImportAmnezia={() => openModal('showImportAmneziaModal')}
                onOpenTemplate={() => openModal('showTemplateModal')}
                onOpenGeoScan={() => openModal('showGeoScanModal')}
                onOpenRouteTest={() => openModal('showRouteTestModal')}
                onRefreshConfigs={refreshConfigs}
              />
            </div>
            <div className={page === 'logs' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              <LogPanel />
            </div>
          </div>
        </main>
      </div>
      <Toast />
      <ModalManager onGenerate={generateConfig} onAddToConfig={addToConfig} onReplace={onReplace} onImportTemplate={importTemplate} />
    </div>
  )
}

type AuthState = 'loading' | 'login' | 'setup' | 'authenticated'

export default function App() {
  const { showToast } = useAppActions()
  const [authState, setAuthState] = useState<AuthState>('loading')
  const theme = useSettings((s) => s.theme)
  const emojiFont = useSettings((s) => s.emojiFont)

  useThemeMode(theme)
  useEmojiFont(emojiFont)

  useEffect(() => {
    const checkAuth = () =>
      apiCall<{ enabled: boolean; authenticated: boolean; has_password: boolean }>('GET', 'auth/login', undefined, { timeoutMs: 15000 })
        .then((data) => {
          if (!data.enabled || data.authenticated) setAuthState('authenticated')
          else if (!data.has_password) setAuthState('setup')
          else setAuthState('login')
        })
        .catch(() => setAuthState('login'))
    void checkAuth()
    window.addEventListener('auth-required', checkAuth)
    return () => window.removeEventListener('auth-required', checkAuth)
  }, [])

  const handleLogout = useCallback(async () => {
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('POST', 'auth/logout', undefined, { timeoutMs: 15000 })
      if (!result.success) throw new Error(result.error || 'Не удалось выйти')
      setAuthState('login')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Не удалось выйти', 'error')
    }
  }, [showToast])

  if (authState === 'loading') return null

  return (
    <AnimatePresence mode="wait">
      {authState === 'login' || authState === 'setup' ? (
        <motion.div key="login" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          <LoginForm mode={authState} onAuth={() => setAuthState('authenticated')} />
          <Toast />
        </motion.div>
      ) : (
        <motion.div key="app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          <AppContent onLogout={handleLogout} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
