import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  IconBook,
  IconBraces,
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconDeviceFloppy,
  IconDotsVertical,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconFilePlus,
  IconFileText,
  IconFileUpload,
  IconHistory,
  IconLayoutList,
  IconListDetails,
  IconPencil,
  IconPlayerPlay,
  IconRoute,
  IconSearch,
  IconTool,
  IconTrash,
} from '@tabler/icons-react'
import * as jsyaml from 'js-yaml'
import { parse as parseJsonc } from 'jsonc-parser'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCall, capitalize, clashFetch, getFileLanguage } from '../../lib/api'
import { saveConfigRevision, supportsConfigHistory } from '../../lib/config-history'
import { LazyBoundary, lazyLoad, useLazyMount } from '../../lib/loader'
import { syncClashApiPort, useAppContext, useConnectionsSync, useSettings } from '../../lib/store'
import type { Config } from '../../lib/types'
import { cn } from '../../lib/utils'
import { ConfigHistoryView } from '../modals/ConfigHistory'
import { ProvidersModal } from '../modals/Providers'
import { StatusPill } from '../shell/Panel'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../ui/input-group'
import { Kbd } from '../ui/kbd'
import type { CodeMirrorRef } from './CodeMirror'
import { DnsPanel } from './mihomo/DnsPanel'
import { SelectorDisplaySettings } from './mihomo/SelectorDisplaySettings'

const GuiRouting = lazyLoad(() => import('./xray/GuiRouting'), 'GuiRouting')
const RoutingConstructor = lazyLoad(() => import('./xray/RoutingConstructor'), 'RoutingConstructor')
const GuiLog = lazyLoad(() => import('./xray/GuiLog'), 'GuiLog')
const GuiOutbounds = lazyLoad(() => import('./xray/GuiOutbounds'), 'GuiOutbounds')
const ConnectionsPanel = lazyLoad(() => import('./mihomo/Connections'), 'ConnectionsPanel')
const SelectorsPanel = lazyLoad(() => import('./mihomo/Selectors'), 'SelectorsPanel')
const CodeMirrorEditorLazy = lazyLoad(() => import('./CodeMirror'), 'CodeMirrorEditor')

type ClashMode = 'rule' | 'global' | 'direct'
type ApiResult = { success: boolean; error?: string; applied?: boolean; running?: boolean }

const HOT_RELOAD_UNAVAILABLE = 'Hot reload unavailable'

const isXkeenFile = (file: string) => file.startsWith('/opt/etc/xkeen')

const findNeighborFile = (configs: Config[], removedFile: string, isAvailable: (file: string) => boolean) => {
  const group = configs.filter((config) => isXkeenFile(config.file) === isXkeenFile(removedFile))
  const removedIndex = group.findIndex((config) => config.file === removedFile)
  if (removedIndex < 0) return undefined
  const previous = group
    .slice(0, removedIndex)
    .reverse()
    .find((config) => isAvailable(config.file))
  const following = group.slice(removedIndex + 1).find((config) => isAvailable(config.file))
  return (previous ?? following)?.file
}
type ProvidersModalKind = 'rules' | 'proxies'

type GuiKind = 'routing' | 'log' | 'outbounds'
const GUI_SETTING_KEY = { routing: 'guiRouting', log: 'guiLog', outbounds: 'guiOutbounds' } as const

/** Which visual editor fits the file, regardless of whether it is enabled in settings. */
function detectGuiKind(file: string | undefined, content: string | undefined): GuiKind | null {
  if (!file || getFileLanguage(file) !== 'json') return null
  try {
    const json = parseJsonc(content || '')
    const name = file.toLowerCase()
    if (name.includes('routing') && json && typeof json.routing === 'object') return 'routing'
    if (name.includes('log') && json && typeof json.log === 'object') return 'log'
    if (Array.isArray(json?.outbounds)) return 'outbounds'
  } catch {
    /* */
  }
  return null
}

const DOC_LINKS = [
  { title: 'Документация XKeen', url: 'https://github.com/Corvus-Malus/XKeen/' },
  { title: 'Документация Xray', url: 'https://xtls.github.io/ru/config' },
  { title: 'Документация Mihomo', url: 'https://wiki.metacubex.one/ru/config/general' },
]

const TOGGLE_ALL_SELECTORS_EVENT = 'mihomo:toggle-all-selectors'
const SHOW_HIDDEN_SELECTORS_KEY = 'showHiddenSelectors'

interface Props {
  onOpenImportAmnezia: () => void
  onOpenTemplate: () => void
  onOpenGeoScan: () => void
  onOpenRouteTest: () => void
  onRefreshConfigs: () => Promise<Config[]>
  editorRef: React.RefObject<CodeMirrorRef | null>
  configActionsRef: React.RefObject<{ switchTab: (index: number) => void; getActiveIndex: () => number }>
}

type FileDialogState =
  { type: 'create'; dir: string; isLst: boolean } | { type: 'rename'; file: string } | { type: 'delete'; file: string } | null

type FileAction = {
  key: string
  label: string
  icon: React.ReactNode
  disabled?: boolean
  destructive?: boolean
  run: () => void
}

const fileBaseName = (file: string) =>
  file
    .split('/')
    .pop()
    ?.replace(/\.[^.]+$/, '') ?? file

const isPoolFile = (file: string) =>
  ['/opt/etc/xray/configs/07_pool.json', '/opt/etc/xray/configs/zz-xkeen-ui-servers-tail.json'].includes(file)

const isProtectedFile = (file: string) => file.endsWith('/config.yaml') || file === 'config.yaml' || isPoolFile(file)

/** Actions available for a config file: shared by the tab context menu and the «Файл» menu. */
function buildFileActions(
  file: string,
  {
    editable,
    onDialog,
    onHideFile,
    onOpenHistory,
  }: {
    editable: boolean
    onDialog: (state: NonNullable<FileDialogState>) => void
    onHideFile: (file: string) => void
    onOpenHistory: (file: string) => void
  }
): FileAction[][] {
  const isProtected = isProtectedFile(file)
  const main: FileAction[] = []
  if (editable) {
    main.push(
      {
        key: 'create',
        label: 'Создать файл',
        icon: <IconFilePlus />,
        run: () => onDialog({ type: 'create', dir: file.substring(0, file.lastIndexOf('/')), isLst: file.endsWith('.lst') }),
      },
      {
        key: 'rename',
        label: 'Переименовать',
        icon: <IconPencil />,
        disabled: isProtected,
        run: () => onDialog({ type: 'rename', file }),
      },
      { key: 'hide', label: 'Скрыть файл', icon: <IconEyeOff />, disabled: isProtected, run: () => onHideFile(file) }
    )
  }
  if (supportsConfigHistory(file)) {
    main.push({ key: 'history', label: 'История изменений', icon: <IconHistory />, run: () => onOpenHistory(file) })
  }
  const danger: FileAction[] = editable
    ? [
        {
          key: 'delete',
          label: 'Удалить файл',
          icon: <IconTrash />,
          disabled: isProtected,
          destructive: true,
          run: () => onDialog({ type: 'delete', file }),
        },
      ]
    : []
  return [main, danger].filter((group) => group.length > 0)
}

interface ConfigTabProps {
  config: Config
  actions: FileAction[][]
}

function ConfigTab({ config, actions }: ConfigTabProps) {
  const trigger = (
    <TabsTrigger
      value={config.file}
      className="text-muted-foreground hover:text-foreground data-[state=active]:border-primary! data-[state=active]:text-foreground h-full! flex-none gap-2 rounded-none! border-0 border-b-2 border-transparent bg-transparent! px-3 shadow-none!"
    >
      {fileBaseName(config.file)}
      {config.isDirty && <span className="size-1.5 rounded-full bg-amber-500" aria-label="Есть несохранённые изменения" role="img" />}
    </TabsTrigger>
  )

  const withTooltip = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex h-full">{trigger}</span>} />
      <TooltipContent className="text-[13px]">{config.file}</TooltipContent>
    </Tooltip>
  )

  if (actions.length === 0) return withTooltip

  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents">{withTooltip}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        {actions.map((group, groupIndex) => (
          <Fragment key={groupIndex}>
            {groupIndex > 0 && <ContextMenuSeparator />}
            {group.map((action) => (
              <ContextMenuItem
                key={action.key}
                disabled={action.disabled}
                variant={action.destructive ? 'destructive' : 'default'}
                onSelect={action.run}
              >
                {action.icon} {action.label}
              </ContextMenuItem>
            ))}
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface FileDialogsProps {
  state: FileDialogState
  currentCore: string
  showToast: (msg: string, type?: 'success' | 'error') => void
  onRefreshConfigs: () => Promise<Config[]>
  onClose: () => void
}

function FileDialogs({ state, currentCore, showToast, onRefreshConfigs, onClose }: FileDialogsProps) {
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [prevState, setPrevState] = useState<FileDialogState>(null)
  if (prevState !== state) {
    setPrevState(state)
    if (state?.type === 'rename') setName(fileBaseName(state.file))
    else if (state?.type === 'create') setName('')
  }

  const ext =
    state?.type === 'rename'
      ? (state.file.match(/(\.[^.]+)$/)?.[1] ?? '')
      : state?.type === 'create'
        ? state.isLst
          ? '.lst'
          : currentCore === 'mihomo'
            ? '.yaml'
            : '.json'
        : ''

  async function commit() {
    if (!state || busy) return
    const val = name.trim()
    let req: { method: 'POST' | 'PATCH' | 'DELETE'; body: Record<string, any>; msg: string }
    if (state.type === 'create') {
      if (!val) return
      req = { method: 'POST', body: { file: `${state.dir}/${val}${ext}`, content: '' }, msg: `Файл "${val}${ext}" создан` }
    } else if (state.type === 'rename') {
      if (!val) return
      const dir = state.file.substring(0, state.file.lastIndexOf('/'))
      req = { method: 'PATCH', body: { file: state.file, new_file: `${dir}/${val}${ext}` }, msg: `Файл переименован в "${val}${ext}"` }
    } else {
      req = { method: 'DELETE', body: { file: state.file }, msg: `Файл "${state.file.split('/').pop()}" удалён` }
    }

    setBusy(true)
    try {
      const result = await apiCall<{ success: boolean; error?: string }>(req.method, 'configs', req.body)
      if (result.success) {
        showToast(req.msg)
        await onRefreshConfigs()
        onClose()
      } else {
        showToast(`Ошибка: ${result.error}`, 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  const isNameDialog = state?.type === 'create' || state?.type === 'rename'

  return (
    <>
      <Dialog open={isNameDialog} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-md flex-col gap-0 p-0 sm:max-w-md">
          <DialogHeader className="border-b px-5 py-4 pr-14">
            <DialogTitle className="text-[15px] font-bold tracking-wider uppercase">
              {state?.type === 'create' ? 'Создать файл' : 'Переименовать файл'}
            </DialogTitle>
          </DialogHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault()
              void commit()
            }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <Field>
                <FieldLabel htmlFor="config-file-name">Имя файла</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="config-file-name"
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Имя файла"
                    disabled={busy}
                  />
                  {ext && (
                    <InputGroupAddon align="inline-end">
                      <InputGroupText>{ext}</InputGroupText>
                    </InputGroupAddon>
                  )}
                </InputGroup>
                {state?.type === 'create' && <FieldDescription>Файл будет создан в {state.dir}</FieldDescription>}
              </Field>
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-3">
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                Отмена
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy && <Spinner data-icon="inline-start" />}
                {state?.type === 'create' ? 'Создать' : 'Переименовать'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={state?.type === 'delete'} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить файл?</AlertDialogTitle>
            <AlertDialogDescription>
              Файл «{state?.type === 'delete' ? state.file.split('/').pop() : ''}» будет удалён без возможности восстановления.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void commit()}>
              {busy && <Spinner data-icon="inline-start" />}
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function ConfigPanel({
  onOpenImportAmnezia,
  onOpenTemplate,
  onOpenGeoScan,
  onOpenRouteTest,
  onRefreshConfigs,
  editorRef,
  configActionsRef,
}: Props) {
  const { state, dispatch, showToast } = useAppContext({ includeConfigs: true })
  const { configs, isConfigsLoading, currentCore, serviceStatus, clashApiPort, clashApiSecret, clashApiUnix } = state
  const configHistoryMaxSnapshots = useSettings((s) => s.configHistoryMaxSnapshots)
  const isLocalHistoryEnabled = configHistoryMaxSnapshots > 0
  const guiRouting = useSettings((s) => s.guiRouting)
  const guiLog = useSettings((s) => s.guiLog)
  const guiOutbounds = useSettings((s) => s.guiOutbounds)
  const closeConnsOnApply = useSettings((s) => s.closeConnectionsOnApply)
  const hiddenConfigFiles = useSettings((s) => s.hiddenConfigFiles)
  const [configHistoryFile, setConfigHistoryFile] = useState<string | null>(null)
  const [fileDialog, setFileDialog] = useState<FileDialogState>(null)
  const [isGuiSwitching, setIsGuiSwitching] = useState(false)
  const guiSwitchingRef = useRef(false)

  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending'
  const activeClashApiPort = isRunning ? clashApiPort : null
  const activeClashApiUnix = isRunning ? clashApiUnix : null

  const isCoreMihomo = currentCore === 'mihomo'

  useConnectionsSync(isCoreMihomo ? activeClashApiPort : null, clashApiSecret, serviceStatus, activeClashApiUnix)

  const [activeConfigFile, setActiveConfigFile] = useState<string>(() => localStorage.getItem('lastSelectedTab') ?? '')
  const activeConfigIndex = useMemo(() => {
    if (!configs.length) return 0
    const idx = configs.findIndex((c) => c.file === activeConfigFile)
    if (idx >= 0 && !hiddenConfigFiles.includes(activeConfigFile)) return idx
    const firstVisible = configs.findIndex((c) => !hiddenConfigFiles.includes(c.file))
    return firstVisible >= 0 ? firstVisible : 0
  }, [configs, activeConfigFile, hiddenConfigFiles])
  const [validationState, setValidationState] = useState<{ isValid: boolean; error?: string } | null>(null)

  const [isEditorMounted, setIsEditorMounted] = useState(false)

  const [activePanel, setActivePanel] = useState<'selectors' | 'connections' | 'config' | 'dns'>('selectors')
  const [mountedPanels, setMountedPanels] = useState<Set<string>>(() => new Set(['selectors']))
  const [mode, setMode] = useState<ClashMode>('rule')
  const [allSelectorsCollapsed, setAllSelectorsCollapsed] = useState(false)
  const [constructorContent, setConstructorContent] = useState<string | null>(null)
  const [showHiddenSelectors, setShowHiddenSelectors] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_HIDDEN_SELECTORS_KEY) === '1'
    } catch {
      return false
    }
  })
  const [providersModalKind, setProvidersModalKind] = useState<ProvidersModalKind | null>(null)
  const [isProvidersModalOpen, setIsProvidersModalOpen] = useState(false)
  const mountProvidersModal = useLazyMount(isProvidersModalOpen)
  const currentPanel = isRunning ? activePanel : 'config'

  const configsRef = useRef(configs)
  const activeIndexRef = useRef(activeConfigIndex)
  const viewStatesRef = useRef<Record<string, any>>({})

  useEffect(() => {
    configsRef.current = configs
  }, [configs])
  useEffect(() => {
    activeIndexRef.current = activeConfigIndex
  }, [activeConfigIndex])

  const saveViewState = useCallback(
    (file: string, isDirty?: boolean) => {
      if (!editorRef.current) return
      const state = editorRef.current.saveViewState()
      if (state) {
        viewStatesRef.current[file] = state
        if (!isDirty) {
          try {
            localStorage.setItem(`editor-folds:${file}`, JSON.stringify(state.folds ?? []))
          } catch {
            /* */
          }
        }
      }
    },
    [editorRef]
  )

  useEffect(() => {
    function onBeforeUnload() {
      const currentCfg = configsRef.current[activeIndexRef.current]
      if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [saveViewState])

  const configFilenamesKey = configs.map((c) => c.file).join(',')

  useEffect(() => {
    if (!isCoreMihomo || (!activeClashApiPort && !activeClashApiUnix)) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      clashFetch<{ mode?: ClashMode }>(activeClashApiPort ?? '', 'configs', { secret: clashApiSecret, unix: activeClashApiUnix })
        .then((data) => {
          if (data.mode) setMode(data.mode)
        })
        .catch(() => {})
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isCoreMihomo, activeClashApiPort, clashApiSecret, activeClashApiUnix])

  const changeMode = useCallback(
    async (newMode: ClashMode) => {
      if (newMode === mode || (!activeClashApiPort && !activeClashApiUnix)) return
      setMode(newMode)
      await clashFetch(activeClashApiPort ?? '', 'configs', {
        method: 'PATCH',
        secret: clashApiSecret,
        unix: activeClashApiUnix,
        body: { mode: newMode },
      })
      await clashFetch(activeClashApiPort ?? '', 'connections', { method: 'DELETE', secret: clashApiSecret, unix: activeClashApiUnix })
    },
    [activeClashApiPort, clashApiSecret, activeClashApiUnix, mode]
  )

  const activeConfig = configs[activeConfigIndex]
  const poolReadOnly = !!activeConfig && isPoolFile(activeConfig.file)
  const fileTabsRef = useRef<HTMLDivElement>(null)
  // Keep the active file tab visible in the horizontally scrolling strip (phones, many files).
  useEffect(() => {
    fileTabsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeConfig?.file, isConfigsLoading, configs.length])
  const fileLanguage = activeConfig ? getFileLanguage(activeConfig.file) : null
  const isJsonOrYaml = fileLanguage === 'json' || fileLanguage === 'yaml'
  const canSave = !!(!poolReadOnly && activeConfig?.isDirty && validationState?.isValid)
  const canApply = canSave && isRunning && !isPending
  const canFormat = !!(!poolReadOnly && isJsonOrYaml && validationState?.isValid)

  function openConfigHistory(file: string) {
    const index = configsRef.current.findIndex((config) => config.file === file)
    if (index >= 0 && index !== activeIndexRef.current) switchTab(index)
    setActivePanel('config')
    setMountedPanels((prev) => (prev.has('config') ? prev : new Set([...prev, 'config'])))
    setConfigHistoryFile(file)
  }

  const loadConfigIntoEditor = useCallback(
    (config: Config) => {
      if (!editorRef.current) return
      editorRef.current.setSavedContent(config.savedContent)
      const inMemory = viewStatesRef.current[config.file]
      editorRef.current.setValue(config.content, config.savedContent, inMemory?.history)
      editorRef.current.setLanguage(getFileLanguage(config.file))
      editorRef.current.validate(config.file)
      if (inMemory) {
        editorRef.current.restoreViewState(inMemory)
      } else {
        const folds = (() => {
          try {
            return JSON.parse(localStorage.getItem(`editor-folds:${config.file}`) ?? 'null')
          } catch {
            return null
          }
        })()
        if (folds) editorRef.current.restoreViewState({ anchor: 0, head: 0, scrollTop: 0, scrollLeft: 0, folds })
      }
    },
    [editorRef]
  )

  useEffect(() => {
    const config = configsRef.current[activeConfigIndex]
    if (editorRef.current && config) {
      loadConfigIntoEditor(config)
    }
  }, [activeConfigIndex, configFilenamesKey, loadConfigIntoEditor, editorRef])

  const savedContentKey = activeConfig?.savedContent
  useEffect(() => {
    const config = configsRef.current[activeConfigIndex]
    if (editorRef.current && config) {
      loadConfigIntoEditor(config)
    }
  }, [activeConfigIndex, savedContentKey, loadConfigIntoEditor, editorRef])

  const handleEditorReady = useCallback(() => {
    setIsEditorMounted(true)
    const config = configsRef.current[activeIndexRef.current]
    if (config && editorRef.current) loadConfigIntoEditor(config)
  }, [loadConfigIntoEditor, editorRef])

  const handleContentChange = useCallback(
    (content: string, isDirty: boolean) => {
      const index = activeIndexRef.current
      if (index < 0) return
      const current = configsRef.current[index]
      if (!current) return
      if (current.content === content && current.isDirty === isDirty) return
      dispatch({ type: 'UPDATE_CONFIG_DIRTY', index, isDirty, content })
    },
    [dispatch]
  )

  const handleValidationChange = useCallback((isValid: boolean, error?: string) => {
    setValidationState((prev) => (prev?.isValid === isValid && prev?.error === error ? prev : { isValid, error }))
  }, [])

  const openProvidersModal = useCallback((kind: ProvidersModalKind) => {
    setProvidersModalKind(kind)
    setIsProvidersModalOpen(true)
  }, [])

  const handleProvidersModalOpenChange = useCallback((open: boolean) => setIsProvidersModalOpen(open), [])

  const refreshConfigsAndEditor = useCallback(async () => {
    const currentCfg = configsRef.current[activeIndexRef.current]
    if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)

    const targetFile = currentCfg?.file ?? activeConfigFile
    const previousConfigs = configsRef.current
    const nextConfigs = await onRefreshConfigs()
    const target = nextConfigs.find((config) => config.file === targetFile)
    const neighborFile = findNeighborFile(
      previousConfigs,
      targetFile,
      (file) => !hiddenConfigFiles.includes(file) && nextConfigs.some((config) => config.file === file)
    )
    const nextConfig =
      target && !hiddenConfigFiles.includes(target.file)
        ? target
        : (nextConfigs.find((config) => config.file === neighborFile) ??
          nextConfigs.find((config) => !hiddenConfigFiles.includes(config.file)) ??
          nextConfigs[0])

    if (nextConfig) {
      if (nextConfig.file !== activeConfigFile) {
        setActiveConfigFile(nextConfig.file)
        localStorage.setItem('lastSelectedTab', nextConfig.file)
      }
      loadConfigIntoEditor(nextConfig)
    }

    return nextConfigs
  }, [activeConfigFile, hiddenConfigFiles, loadConfigIntoEditor, onRefreshConfigs, saveViewState])

  const switchTab = useCallback(
    (index: number) => {
      if (index === activeIndexRef.current) return
      const currentCfg = configsRef.current[activeIndexRef.current]
      if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)

      const file = configsRef.current[index]?.file ?? ''
      setActiveConfigFile(file)
      localStorage.setItem('lastSelectedTab', file)
    },
    [saveViewState]
  )

  useEffect(() => {
    configActionsRef.current = { switchTab, getActiveIndex: () => activeIndexRef.current }
  }, [configActionsRef, switchTab])

  function markSaved(cfg: Config, content: string, targetIndex: number) {
    const found = configsRef.current.findIndex((config) => config.file === cfg.file)
    const index = found < 0 ? targetIndex : found
    const active = configsRef.current[activeIndexRef.current]?.file === cfg.file
    // Edits typed while the request was in flight are newer than what was saved: keep them.
    const latest = (active ? editorRef.current?.getValue() : undefined) ?? configsRef.current[index]?.content ?? content
    dispatch({ type: 'SAVE_CONFIG', index, content })
    if (latest !== content) dispatch({ type: 'UPDATE_CONFIG_DIRTY', index, content: latest, isDirty: true })
    if (active) {
      editorRef.current?.setSavedContent(content)
      saveViewState(cfg.file, latest !== content)
    }
  }

  async function refreshPoolConfig() {
    const fresh = await apiCall<{ success: boolean; configs?: Config[] }>('GET', 'configs')
    if (!fresh.success) return
    for (const config of fresh.configs ?? []) {
      if (!isPoolFile(config.file)) continue
      const index = configsRef.current.findIndex((item) => item.file === config.file)
      if (index >= 0) dispatch({ type: 'SAVE_CONFIG', index, content: config.content })
    }
  }

  async function executeSave(cfg: Config, content: string, targetIndex: number) {
    try {
      const result = await apiCall<ApiResult>('PUT', 'configs', { file: cfg.file, content })
      if (!result.success) throw new Error(result.error || 'Ошибка сохранения')
      markSaved(cfg, content, targetIndex)
      if (result.applied) await refreshPoolConfig().catch(() => {})
      const historyError = isLocalHistoryEnabled ? await saveConfigRevision(cfg.file, content, cfg.savedContent) : null
      showToast(
        historyError
          ? `Файл сохранён, но история не записана: ${historyError}`
          : result.applied && result.running
            ? 'Маршруты сохранены и применены к работающему пулу'
            : `Файл "${cfg.file.split('/').pop()}" сохранён`,
        historyError ? 'error' : 'success'
      )
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Ошибка сохранения', 'error')
    }
  }

  async function saveCurrentConfig(force = false) {
    const targetIndex = activeIndexRef.current
    const cfg = configsRef.current[targetIndex]
    if (!cfg || !editorRef.current || isPoolFile(cfg.file)) return
    const content = editorRef.current.getValue()
    if (!content.trim() && !cfg.file.endsWith('.lst')) return showToast('Конфигурация пустая', 'error')
    if (!editorRef.current.isValid(cfg.file)) return showToast('Файл содержит ошибки', 'error')
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({ type: 'SET_PENDING_SAVE_ACTION', action: () => saveCurrentConfig(true) })
      dispatch({ type: 'SHOW_MODAL', modal: 'showCommentsWarningModal', show: true })
      return
    }

    await executeSave(cfg, content, targetIndex)
  }

  function restartActionFor(cfg: Config, content: string) {
    const lang = getFileLanguage(cfg.file)
    return !isXkeenFile(cfg.file) && (lang === 'json' || lang === 'yaml') && !hasCriticalChanges(cfg.savedContent, content, lang)
      ? 'softRestart'
      : 'hardRestart'
  }

  async function applyToHost(cfg: Config, content: string, onHistoryError: (message: string) => void) {
    const core = currentCore
    const isHotReload = core === 'mihomo' && !isXkeenFile(cfg.file)

    let validate = ''
    if (!isXkeenFile(cfg.file) && (core === 'mihomo' || core === 'xray')) {
      validate = `?validate=${core}`
      if (core === 'xray') validate += '&apply=true'
      if (core === 'mihomo' && closeConnsOnApply) validate += '&closeConns=true'
    }
    const saveResult = await apiCall<ApiResult>('PUT', `configs${validate}`, { file: cfg.file, content }, {})
    const hotReloadUnavailable = saveResult.error === HOT_RELOAD_UNAVAILABLE
    if (!saveResult.success && !hotReloadUnavailable) {
      throw new Error(
        saveResult.error === 'Validation failed'
          ? `Ошибка валидации ${capitalize(core)}: проверьте журнал`
          : saveResult.error || 'Ошибка сохранения'
      )
    }

    const historyError = isLocalHistoryEnabled ? await saveConfigRevision(cfg.file, content, cfg.savedContent) : null
    if (historyError) onHistoryError(historyError)

    if (saveResult.applied) {
      await refreshPoolConfig().catch(() => {})
      return true
    }

    if (hotReloadUnavailable) showToast('Clash API недоступен, выполняем полный рестарт', 'warning')

    const action = hotReloadUnavailable
      ? 'hardRestart'
      : isHotReload
        ? hasCriticalChanges(cfg.savedContent, content, 'yaml')
          ? 'hardRestart'
          : null
        : restartActionFor(cfg, content)
    if (!action) return false

    const restartResult = await apiCall<ApiResult>('POST', 'control', { action, core })
    if (!restartResult?.success) throw new Error(restartResult?.error || 'ошибка перезапуска')
    return true
  }

  async function executeApply(cfg: Config, content: string, targetIndex: number) {
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Применение...' })
    let historyError = ''
    try {
      await applyToHost(cfg, content, (error) => {
        historyError = error
      })
      markSaved(cfg, content, targetIndex)
      syncClashApiPort(200)
      showToast(
        historyError ? `Изменения применены, но история не записана: ${historyError}` : 'Изменения применены',
        historyError ? 'error' : 'success'
      )
      return true
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Ошибка применения', 'error')
      return false
    } finally {
      const status = await apiCall<{ running: boolean }>('GET', 'control').catch(() => ({ running: isRunning }))
      dispatch({ type: 'SET_SERVICE_STATUS', status: status.running ? 'running' : 'stopped' })
    }
  }

  async function saveAndApply(force = false) {
    const targetIndex = activeIndexRef.current
    const cfg = configsRef.current[targetIndex]
    if (!cfg || !editorRef.current || isPoolFile(cfg.file)) return
    const content = editorRef.current.getValue()
    if (!content.trim() && !cfg.file.endsWith('.lst')) return showToast('Файл пустой', 'error')
    if (!editorRef.current.isValid(cfg.file)) return showToast('Файл содержит ошибки', 'error')
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({ type: 'SET_PENDING_SAVE_ACTION', action: () => saveAndApply(true) })
      dispatch({ type: 'SHOW_MODAL', modal: 'showCommentsWarningModal', show: true })
      return
    }

    await executeApply(cfg, content, targetIndex)
  }

  function isGuiActive(cfg: Config) {
    const f = cfg.file.toLowerCase()
    return (f.includes('routing') && guiRouting) || (f.includes('log') && guiLog) || (f.includes('outbound') && guiOutbounds)
  }

  const fileForGui = activeConfig?.file
  const contentForGui = activeConfig?.savedContent
  const isRoutingGui = useMemo(() => {
    if (!guiRouting || !fileForGui) return false
    if (!fileForGui.toLowerCase().includes('routing')) return false
    try {
      const j = parseJsonc(contentForGui || '')
      return j && typeof j.routing === 'object'
    } catch {
      return false
    }
  }, [guiRouting, fileForGui, contentForGui])

  const isLogGui = useMemo(() => {
    if (!guiLog || !fileForGui) return false
    if (!fileForGui.toLowerCase().includes('log')) return false
    try {
      const j = parseJsonc(contentForGui || '')
      return j && typeof j.log === 'object'
    } catch {
      return false
    }
  }, [guiLog, fileForGui, contentForGui])

  const isOutboundsGui = useMemo(() => {
    if (!guiOutbounds || !fileForGui || isPoolFile(fileForGui) || isRoutingGui || isLogGui) return false
    try {
      const j = parseJsonc(contentForGui || '')
      return Array.isArray(j?.outbounds)
    } catch {
      return false
    }
  }, [guiOutbounds, fileForGui, contentForGui, isRoutingGui, isLogGui])

  const isAnyGui = isRoutingGui || isLogGui || isOutboundsGui

  const coreConfigs = configs.filter((c) => !isXkeenFile(c.file) && !hiddenConfigFiles.includes(c.file))
  const xkeenConfigs = configs.filter((c) => isXkeenFile(c.file) && !hiddenConfigFiles.includes(c.file))

  const hideConfigFile = useCallback(
    async (file: string) => {
      const visibleCount = configs.filter((c) => c.file !== file && !hiddenConfigFiles.includes(c.file)).length
      if (visibleCount === 0) {
        showToast('Нельзя скрыть последний файл', 'error')
        return
      }
      const next = hiddenConfigFiles.includes(file) ? hiddenConfigFiles : [...hiddenConfigFiles, file]
      try {
        const result = await apiCall<{ success: boolean; error?: string }>('PATCH', 'settings', { ui: { hidden_files: next } })
        if (!result.success) {
          showToast(`Ошибка: ${result.error}`, 'error')
          return
        }
        dispatch({ type: 'SET_SETTINGS', settings: { hiddenConfigFiles: next } })
        showToast('Файл успешно скрыт. Скрытый файл можно вернуть в настройках', 'success')
        if (activeConfigFile === file) {
          const nextFile = findNeighborFile(configs, file, (candidate) => !next.includes(candidate))
          if (nextFile) {
            setActiveConfigFile(nextFile)
            localStorage.setItem('lastSelectedTab', nextFile)
          }
        }
      } catch (e: any) {
        showToast(e.message, 'error')
      }
    },
    [configs, hiddenConfigFiles, activeConfigFile, dispatch, showToast]
  )

  async function rollbackConfig(file: string, content: string, applying = false) {
    const configIndex = configsRef.current.findIndex((config) => config.file === file)
    const config = configsRef.current[configIndex]
    if (!config) throw new Error('Конфигурация недоступна')

    const isDirty = content !== config.savedContent
    dispatch({ type: 'UPDATE_CONFIG_DIRTY', index: configIndex, content, isDirty })
    if (configsRef.current[activeIndexRef.current]?.file === file) {
      const editorViewState = editorRef.current?.saveViewState()
      editorRef.current?.setValue(content)
      editorRef.current?.validate(file)
      if (editorViewState) editorRef.current?.restoreViewState(editorViewState)
      saveViewState(file, isDirty)
    }
    if (!applying) showToast('Изменение отменено в редакторе. Сохраните файл, чтобы применить.', 'success')
  }

  async function rollbackConfigAndApply(file: string, content: string) {
    await rollbackConfig(file, content, true)
    await saveAndApply()
  }

  function showRollbackError(reason: unknown) {
    showToast(reason instanceof Error ? reason.message : 'Не удалось отменить изменение', 'error')
  }

  const isMihomo = isCoreMihomo && (!!activeClashApiPort || !!activeClashApiUnix)

  const editableFiles = new Set(coreConfigs.map((c) => c.file))
  const fileActionsFor = (file: string) =>
    buildFileActions(file, {
      editable: editableFiles.has(file) && !isPoolFile(file),
      onDialog: setFileDialog,
      onHideFile: (target) => void hideConfigFile(target),
      onOpenHistory: openConfigHistory,
    })
  const activeFileActions = activeConfig ? fileActionsFor(activeConfig.file) : []

  const detectedGuiKind = isCoreMihomo || poolReadOnly ? null : detectGuiKind(fileForGui, contentForGui)
  const guiKind: GuiKind | null = isRoutingGui ? 'routing' : isLogGui ? 'log' : isOutboundsGui ? 'outbounds' : detectedGuiKind
  const isGuiOn = isAnyGui

  async function setGuiMode(enabled: boolean) {
    if (!guiKind || enabled === isGuiOn || guiSwitchingRef.current) return
    guiSwitchingRef.current = true
    setIsGuiSwitching(true)
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('PATCH', 'settings', { gui: { [guiKind]: enabled } })
      if (!result.success) {
        showToast(`Ошибка: ${result.error}`, 'error')
        return
      }
      dispatch({ type: 'SET_SETTINGS', settings: { [GUI_SETTING_KEY[guiKind]]: enabled } })
    } catch (e: any) {
      showToast(e.message, 'error')
    } finally {
      guiSwitchingRef.current = false
      setIsGuiSwitching(false)
    }
  }

  const showConfigView = !isMihomo || currentPanel === 'config'

  const lineTabTrigger =
    'text-muted-foreground hover:text-foreground data-[state=active]:border-primary! data-[state=active]:text-foreground h-full! flex-none rounded-none! border-0 border-b-2 border-transparent bg-transparent! px-3 shadow-none!'

  return (
    <TooltipProvider delayDuration={700} timeout={0}>
      <>
        <section
          aria-labelledby="config-page-title"
          className="bg-card relative flex flex-col overflow-hidden rounded-lg border md:min-h-0 md:flex-1"
        >
          {configHistoryFile && (
            <div className="bg-card absolute inset-0 z-20 flex min-h-0 flex-col">
              <ConfigHistoryView
                file={configHistoryFile}
                currentContent={configs.find((config) => config.file === configHistoryFile)?.content ?? ''}
                onClose={() => setConfigHistoryFile(null)}
                onRollback={(file, content) => rollbackConfig(file, content).catch(showRollbackError)}
                onRollbackAndApply={(file, content) => rollbackConfigAndApply(file, content).catch(showRollbackError)}
              />
            </div>
          )}

          <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h1 id="config-page-title" className="text-xl font-bold tracking-wider uppercase">
                Конфигурация {capitalize(currentCore)}
              </h1>
              <p className="text-muted-foreground text-sm">
                Общие файлы ядра на роутере: подключения, маршрутизация и параметры работы. Это не настройки отдельного сервера пула.
              </p>
            </div>

            {isMihomo && currentPanel === 'connections' && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">Режим</span>
                <Select
                  value={mode}
                  items={{ direct: 'DIRECT', rule: 'RULE', global: 'GLOBAL' }}
                  onValueChange={(value) => changeMode(value as ClashMode)}
                >
                  <SelectTrigger className="w-30" aria-label="Режим маршрутизации">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="direct">DIRECT</SelectItem>
                      <SelectItem value="rule">RULE</SelectItem>
                      <SelectItem value="global">GLOBAL</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}

            {isMihomo && currentPanel === 'selectors' && (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => openProvidersModal('proxies')}>
                  <IconListDetails data-icon="inline-start" />
                  Подписки
                </Button>
                <Button variant="outline" onClick={() => openProvidersModal('rules')}>
                  <IconListDetails data-icon="inline-start" />
                  Рулсеты
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={showHiddenSelectors ? 'Скрыть скрытые группы' : 'Показывать скрытые группы'}
                        aria-pressed={showHiddenSelectors}
                        className={cn(showHiddenSelectors && 'border-primary text-primary')}
                        onClick={() => {
                          setShowHiddenSelectors((prev) => {
                            try {
                              localStorage.setItem(SHOW_HIDDEN_SELECTORS_KEY, prev ? '0' : '1')
                            } catch {
                              /* */
                            }
                            return !prev
                          })
                        }}
                      >
                        {showHiddenSelectors ? <IconEyeOff /> : <IconEye />}
                      </Button>
                    }
                  />
                  <TooltipContent>{showHiddenSelectors ? 'Скрыть скрытые' : 'Показывать скрытые'}</TooltipContent>
                </Tooltip>
                <SelectorDisplaySettings />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={allSelectorsCollapsed ? 'Развернуть все группы' : 'Свернуть все группы'}
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent(TOGGLE_ALL_SELECTORS_EVENT, { detail: { collapsed: !allSelectorsCollapsed } })
                          )
                        }
                      >
                        {allSelectorsCollapsed ? <IconChevronDown /> : <IconChevronUp />}
                      </Button>
                    }
                  />
                  <TooltipContent>{allSelectorsCollapsed ? 'Развернуть все' : 'Свернуть все'}</TooltipContent>
                </Tooltip>
              </div>
            )}
          </header>

          {isMihomo && (
            <div className="shrink-0 scrollbar-none overflow-x-auto border-b px-2 [&::-webkit-scrollbar]:hidden">
              <Tabs
                value={currentPanel}
                onValueChange={(value) => {
                  const panel = value as 'config' | 'selectors' | 'connections' | 'dns'
                  setActivePanel(panel)
                  if (panel !== 'config') setConfigHistoryFile(null)
                  setMountedPanels((prev) => (prev.has(panel) ? prev : new Set([...prev, panel])))
                }}
                className="h-11 w-max flex-row!"
              >
                <TabsList variant="line" className="h-full! gap-0 p-0">
                  <TabsTrigger value="selectors" className={lineTabTrigger} disabled={!isRunning}>
                    Группы
                  </TabsTrigger>
                  <TabsTrigger value="connections" className={lineTabTrigger} disabled={!isRunning}>
                    Соединения
                  </TabsTrigger>
                  <TabsTrigger value="dns" className={lineTabTrigger}>
                    DNS
                  </TabsTrigger>
                  <TabsTrigger value="config" className={lineTabTrigger}>
                    Конфиг
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          )}

          {showConfigView && (
            <div className="flex h-11 shrink-0 items-stretch gap-1 border-b pr-3 pl-2">
              <div
                ref={fileTabsRef}
                className="min-w-0 flex-1 scrollbar-none overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden"
              >
                {isConfigsLoading ? (
                  <div className="flex h-full items-center gap-3 px-3">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                ) : (
                  <Tabs
                    value={activeConfig?.file || ''}
                    onValueChange={(value) => {
                      const index = configs.findIndex((c) => c.file === value)
                      if (index >= 0) switchTab(index)
                    }}
                    className="h-full w-max flex-row! items-stretch gap-0"
                  >
                    {coreConfigs.length > 0 && (
                      <TabsList variant="line" aria-label="Файлы ядра" className="h-full! gap-0 p-0">
                        {coreConfigs.map((config) => (
                          <ConfigTab key={config.file} config={config} actions={fileActionsFor(config.file)} />
                        ))}
                      </TabsList>
                    )}
                    {coreConfigs.length > 0 && xkeenConfigs.length > 0 && (
                      <Separator orientation="vertical" className="mx-1 my-3 h-auto!" />
                    )}
                    {xkeenConfigs.length > 0 && (
                      <TabsList variant="line" aria-label="Файлы XKeen" className="h-full! gap-0 p-0">
                        {xkeenConfigs.map((config) => (
                          <ConfigTab key={config.file} config={config} actions={fileActionsFor(config.file)} />
                        ))}
                      </TabsList>
                    )}
                  </Tabs>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2 pl-1">
                {guiKind && !isConfigsLoading && (
                  <Tabs value={isGuiOn ? 'gui' : 'code'} onValueChange={(value) => void setGuiMode(value === 'gui')}>
                    <TabsList className="h-8!" aria-label="Режим редактора">
                      <TabsTrigger
                        value="gui"
                        className="data-[state=active]:bg-background! data-[state=active]:text-foreground! px-2.5 text-xs"
                        disabled={isGuiSwitching}
                      >
                        <IconLayoutList />
                        <span className="hidden sm:inline">Визуально</span>
                      </TabsTrigger>
                      <TabsTrigger
                        value="code"
                        className="data-[state=active]:bg-background! data-[state=active]:text-foreground! px-2.5 text-xs"
                        disabled={isGuiSwitching}
                      >
                        <IconBraces />
                        <span className="hidden sm:inline">JSON</span>
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon-sm" aria-label="Действия с файлом" disabled={activeFileActions.length === 0}>
                        <IconDotsVertical />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="min-w-52">
                    {activeConfig && (
                      <DropdownMenuGroup>
                        <DropdownMenuLabel className="truncate">{activeConfig.file.split('/').pop()}</DropdownMenuLabel>
                      </DropdownMenuGroup>
                    )}
                    {activeFileActions.map((group, groupIndex) => (
                      <Fragment key={groupIndex}>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                          {group.map((action) => (
                            <DropdownMenuItem
                              key={action.key}
                              disabled={action.disabled}
                              variant={action.destructive ? 'destructive' : 'default'}
                              onClick={action.run}
                            >
                              {action.icon} {action.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      </Fragment>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )}

          <div className="relative min-h-[70dvh] md:min-h-0 md:flex-1">
            {isEditorMounted && activeConfig && isRoutingGui && (
              <GuiRouting
                editorRef={editorRef}
                configs={configs}
                activeConfigIndex={activeConfigIndex}
                onApply={(content) => executeApply(configs[activeConfigIndex], content, activeConfigIndex)}
              />
            )}
            {isEditorMounted && activeConfig && isLogGui && (
              <GuiLog editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
            )}
            {isEditorMounted && activeConfig && isOutboundsGui && (
              <GuiOutbounds editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
            )}

            {isMihomo && (
              <>
                {mountedPanels.has('selectors') && (
                  <div className={cn(currentPanel !== 'selectors' && 'hidden')}>
                    <LazyBoundary>
                      <SelectorsPanel
                        clashApiPort={(activeClashApiPort ?? '') as string}
                        mode={mode}
                        clashApiSecret={clashApiSecret ?? null}
                        clashApiUnix={activeClashApiUnix ?? null}
                        showHiddenSelectors={showHiddenSelectors}
                        onCollapsedStateChange={setAllSelectorsCollapsed}
                      />
                    </LazyBoundary>
                  </div>
                )}
                {mountedPanels.has('connections') && (
                  <div className={cn(currentPanel !== 'connections' && 'hidden')}>
                    <LazyBoundary>
                      <ConnectionsPanel
                        clashApiPort={(activeClashApiPort ?? '') as string}
                        clashApiSecret={clashApiSecret ?? null}
                        clashApiUnix={activeClashApiUnix ?? null}
                      />
                    </LazyBoundary>
                  </div>
                )}
                {mountedPanels.has('dns') && (
                  <div className={cn(currentPanel !== 'dns' && 'hidden')}>
                    <LazyBoundary>
                      <DnsPanel />
                    </LazyBoundary>
                  </div>
                )}
              </>
            )}

            {!isConfigsLoading && (!isMihomo || mountedPanels.has('config')) && (
              <div
                className={cn(
                  'absolute inset-0',
                  isAnyGui && 'pointer-events-none invisible opacity-0',
                  isMihomo && currentPanel !== 'config' && 'hidden'
                )}
              >
                <CodeMirrorEditorLazy
                  readOnly={poolReadOnly}
                  ref={editorRef}
                  onContentChange={handleContentChange}
                  onValidationChange={handleValidationChange}
                  onReady={handleEditorReady}
                  onSave={() => saveCurrentConfig()}
                />
              </div>
            )}
          </div>

          {showConfigView && (
            <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-5 py-3">
              <div className="flex min-w-0 flex-1 basis-56 items-center gap-2">
                {isConfigsLoading ? (
                  <Skeleton className="h-6 w-32" />
                ) : (
                  <>
                    {validationState && activeConfig && isJsonOrYaml && (
                      <>
                        <StatusPill tone={validationState.isValid ? 'ok' : 'bad'}>
                          {validationState.isValid ? `${fileLanguage?.toUpperCase()} валиден` : 'Ошибка'}
                        </StatusPill>
                        {!validationState.isValid && (
                          <span
                            className="min-w-0 truncate text-sm text-rose-600 dark:text-rose-400"
                            title={validationState.error || 'Файл невалиден'}
                          >
                            {validationState.error || 'Файл невалиден'}
                          </span>
                        )}
                      </>
                    )}
                    {poolReadOnly && <span className="text-muted-foreground text-sm">Конфиг пула · изменения в разделе «Серверы»</span>}
                    {activeConfig?.isDirty && <StatusPill tone="warn">Не сохранено</StatusPill>}
                  </>
                )}
              </div>

              <div className="ml-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">
                {isConfigsLoading ? (
                  <>
                    <Skeleton className="h-9 w-9" />
                    <Skeleton className="h-9 w-28" />
                    <Skeleton className="h-9 w-28" />
                  </>
                ) : (
                  <>
                    {!isCoreMihomo &&
                      !poolReadOnly &&
                      !isRoutingGui &&
                      (detectedGuiKind === 'routing' || /routing/i.test(activeConfig?.file ?? '')) && (
                        <Button
                          variant="outline"
                          onClick={() => setConstructorContent(editorRef.current?.getValue() ?? activeConfig?.content ?? '')}
                        >
                          <IconRoute data-icon="inline-start" /> Конструктор маршрутов
                        </Button>
                      )}
                    <Button variant="ghost" className="hidden xl:inline-flex" onClick={onOpenTemplate}>
                      <IconFileText data-icon="inline-start" /> Шаблоны
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="outline" size="icon" aria-label="Инструменты">
                            <IconTool />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" className="min-w-60">
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Конфигурация</DropdownMenuLabel>
                          {isCoreMihomo && (
                            <DropdownMenuItem onClick={onOpenImportAmnezia}>
                              <IconFileUpload /> Импорт AmneziaWG
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem className="xl:hidden" onClick={onOpenTemplate}>
                            <IconFileText /> Шаблоны конфигураций
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Диагностика</DropdownMenuLabel>
                          <DropdownMenuItem onClick={onOpenGeoScan}>
                            <IconSearch /> Скан геофайлов
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={onOpenRouteTest}>
                            <IconRoute /> Проверка маршрута
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <IconBook /> Документация
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="min-w-52">
                            {DOC_LINKS.map((link) => (
                              <DropdownMenuItem key={link.url} onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}>
                                <IconExternalLink /> {link.title}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="outline"
                            size="icon"
                            aria-label="Форматировать"
                            disabled={!canFormat}
                            onClick={() => editorRef.current?.format()}
                          >
                            <IconCode />
                          </Button>
                        }
                      />
                      <TooltipContent>
                        Форматировать <Kbd>Shift+Alt+F</Kbd>
                      </TooltipContent>
                    </Tooltip>
                    <Separator orientation="vertical" className="mx-1 hidden h-6! sm:block" />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="outline" disabled={!canSave} onClick={() => saveCurrentConfig()}>
                            <IconDeviceFloppy data-icon="inline-start" /> Сохранить
                          </Button>
                        }
                      />
                      <TooltipContent>
                        Сохранить файл <Kbd>Ctrl+S</Kbd>
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button disabled={!canApply} onClick={() => saveAndApply()}>
                            <IconPlayerPlay data-icon="inline-start" /> Применить
                          </Button>
                        }
                      />
                      <TooltipContent>Сохранить и перезапустить ядро</TooltipContent>
                    </Tooltip>
                  </>
                )}
              </div>
            </footer>
          )}
        </section>
        {constructorContent !== null && (
          <LazyBoundary>
            <RoutingConstructor
              configs={configs}
              file={activeConfig?.file ?? ''}
              content={constructorContent}
              onApply={async (content) => {
                if (!activeConfig) return false
                editorRef.current?.replaceAll(content)
                return executeApply(activeConfig, content, activeConfigIndex)
              }}
              onClose={() => setConstructorContent(null)}
              onTransfer={(content) => {
                editorRef.current?.replaceAll(content)
                showToast('Маршруты переданы в редактор. Нажмите «Применить», чтобы включить их')
              }}
            />
          </LazyBoundary>
        )}
        <FileDialogs
          state={fileDialog}
          currentCore={currentCore}
          showToast={showToast}
          onRefreshConfigs={refreshConfigsAndEditor}
          onClose={() => setFileDialog(null)}
        />
        {providersModalKind && mountProvidersModal && (
          <ProvidersModal
            open={isProvidersModalOpen}
            kind={providersModalKind}
            clashApiPort={activeClashApiPort ?? ''}
            clashApiSecret={clashApiSecret ?? null}
            clashApiUnix={activeClashApiUnix ?? null}
            onOpenChange={handleProvidersModalOpenChange}
          />
        )}
      </>
    </TooltipProvider>
  )
}

function hasComments(content: string) {
  return /(?<!:)\/\/|\/\*[\s\S]*?\*\//.test(content) || /^\s*#/m.test(content)
}

function hasCriticalChanges(oldContent: string, newContent: string, language: string): boolean {
  try {
    if (language === 'yaml') {
      const o = jsyaml.load(oldContent) as Record<string, unknown>
      const n = jsyaml.load(newContent) as Record<string, unknown>
      return [
        'listeners',
        'redir-port',
        'tproxy-port',
        'routing-mark',
        'external-controller',
        'external-controller-tls',
        'external-controller-unix',
        'external-controller-pipe',
        'external-controller-cors',
        'external-controller-routing-mark',
        'external-ui',
        'external-ui-url',
        'external-ui-name',
        'external-doh-server',
        'secret',
        'tls',
      ].some((f) => JSON.stringify(o?.[f]) !== JSON.stringify(n?.[f]))
    }
    if (language === 'json') {
      const o = parseJsonc(oldContent)
      const n = parseJsonc(newContent)
      const clean = (arr: Record<string, unknown>[]) =>
        (arr || []).map((item) => Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'sniffing')))
      return JSON.stringify(clean(o?.inbounds)) !== JSON.stringify(clean(n?.inbounds))
    }
  } catch {
    return false
  }
  return false
}
