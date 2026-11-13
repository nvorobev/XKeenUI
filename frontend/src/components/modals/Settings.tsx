import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ClearIcon } from '@/components/ui/clear-icon'
import { FieldContent, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  IconActivityHeartbeat,
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconArrowBackUp,
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconCornerDownLeft,
  IconHelpCircle,
  IconLock,
  IconPalette,
  IconRefresh,
  IconShieldLock,
  IconTrash,
  type Icon,
} from '@tabler/icons-react'
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { apiCall } from '../../lib/api'
import { navigate } from '../../lib/navigation'
import { saveProxyLabelStyle, type ProxyLabelStyle } from '../../lib/proxy-label-style'
import { useAppContext } from '../../lib/store'
import { applyEmojiFont } from '../../lib/theme'
import type { AppSettings, AutoDnsMode, EmojiFont, PingMode, ProxySortOrder, ThemeMode } from '../../lib/types'

type BooleanSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never
}[keyof AppSettings]

type ToggleSetting = {
  id: string
  key: BooleanSettingKey
  path: string
  title: string
  description: string
}

type ToggleSettingHandler = (item: ToggleSetting, value: boolean) => void

const guiSettings: ToggleSetting[] = [
  {
    id: 'gui-routing',
    key: 'guiRouting',
    path: 'gui.routing',
    title: 'Routing',
    description: 'Визуальный редактор правил маршрутизации Xray',
  },
  {
    id: 'gui-outbounds',
    key: 'guiOutbounds',
    path: 'gui.outbounds',
    title: 'Outbounds',
    description: 'Визуальный редактор подключений Xray',
  },
  {
    id: 'gui-log',
    key: 'guiLog',
    path: 'gui.log',
    title: 'Log',
    description: 'Визуальный редактор настроек логирования Xray',
  },
  {
    id: 'auto-apply',
    key: 'autoApply',
    path: 'gui.auto_apply',
    title: 'Автоприменение',
    description: 'Сразу применять изменения в визуальном редакторе:\n • Routing: смена outboundTag\n • Log: любые изменения',
  },
]

const updateSettings: ToggleSetting[] = [
  {
    id: 'backup',
    key: 'backupCore',
    path: 'updater.backup_core',
    title: 'Резервная копия ядра',
    description: 'Сохранять предыдущую версию ядра при обновлении',
  },
]

type IntervalSetting = Omit<ToggleSetting, 'key'> & { key: 'autoCheckUI' | 'autoCheckCore' }

type IntervalSettingHandler = (item: IntervalSetting, value: number) => void

const checkIntervalSettings: IntervalSetting[] = [
  {
    id: 'auto-ui',
    key: 'autoCheckUI',
    path: 'updater.auto_check_ui',
    title: 'Проверка обновлений панели',
    description: 'Интервал в часах, от 1 до 24. 0 — не проверять',
  },
  {
    id: 'auto-core',
    key: 'autoCheckCore',
    path: 'updater.auto_check_core',
    title: 'Проверка обновлений ядра',
    description: 'Интервал в часах, от 1 до 24. 0 — не проверять',
  },
]

const clashApiSettings: ToggleSetting[] = [
  {
    id: 'show-source-name',
    key: 'showSourceName',
    path: 'clash_api.show_source_name',
    title: 'Имя устройства вместо IP',
    description: 'Показывать имя клиента Keenetic вместо IP-адреса. Нужна актуальная версия KeeneticOS',
  },
  {
    id: 'close-conns-on-apply',
    key: 'closeConnectionsOnApply',
    path: 'clash_api.close_connections_on_apply',
    title: 'Сбрасывать соединения при применении',
    description: 'Закрывать все соединения после успешного применения конфигурации Mihomo',
  },
  {
    id: 'mobile-layout',
    key: 'mobileLayout',
    path: 'clash_api.mobile_layout',
    title: 'Карточки на телефоне',
    description: 'Показывать соединения карточками на мобильных устройствах',
  },
]

const pingModeOptions: { value: PingMode; label: string }[] = [
  { value: 'single', label: 'Одинарный' },
  { value: 'double', label: 'Двойной' },
  { value: 'double_keep_alive', label: 'Двойной + KeepAlive' },
]

const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'auto', label: 'Как в системе' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
]

const emojiFontOptions: { value: EmojiFont; label: string }[] = [
  { value: 'twemoji', label: 'Twemoji' },
  { value: 'notocoloremoji', label: 'Noto Color Emoji' },
]

const proxyLabelStyleOptions: { value: ProxyLabelStyle; label: string }[] = [
  { value: 'plain', label: 'Текст' },
  { value: 'outlined', label: 'Капсула' },
]

const sortOrderOptions: { value: ProxySortOrder; label: string }[] = [
  { value: 'default', label: 'Как в конфиге' },
  { value: 'name', label: 'По названию' },
  { value: 'ping', label: 'По задержке' },
]

const autoDnsOptions: { value: AutoDnsMode; label: string }[] = [
  { value: 'disabled', label: 'Выключено' },
  { value: 'enabled', label: 'Включено' },
  { value: 'with_filter', label: 'Включено + авто' },
]

const timezoneOptions = Array.from({ length: 27 }, (_, i) => {
  const offset = i - 12
  return { value: String(offset), label: `UTC${offset >= 0 ? '+' : ''}${offset}` }
})

type SectionId = 'appearance' | 'editor' | 'access' | 'protection' | 'ping' | 'mihomo' | 'updates'

const SECTIONS: { id: SectionId; label: string; description: string; icon: Icon }[] = [
  { id: 'appearance', label: 'Внешний вид', description: 'Тема и шрифты панели', icon: IconPalette },
  { id: 'editor', label: 'Редактор и журнал', description: 'Визуальный редактор, история изменений и журнал', icon: IconCode },
  { id: 'access', label: 'Доступ и вход', description: 'Защита панели паролем', icon: IconLock },
  { id: 'protection', label: 'Защита трафика', description: 'Не выпускать трафик мимо прокси', icon: IconShieldLock },
  { id: 'ping', label: 'Проверка соединений', description: 'Адрес, таймаут и режим теста задержки', icon: IconActivityHeartbeat },
  { id: 'mihomo', label: 'Mihomo', description: 'Селекторы, соединения и DNS для ядра Mihomo', icon: IconAdjustmentsHorizontal },
  { id: 'updates', label: 'Ядра и обновления', description: 'Автопроверка, источники и прокси для загрузки', icon: IconRefresh },
]

const sectionItems = Object.fromEntries(SECTIONS.map((s) => [s.id, s.label]))

/* ─── Layout primitives ─────────────────────────────────────────────────────── */

function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title && <h4 className="text-muted-foreground px-1 text-xs font-semibold tracking-wider uppercase">{title}</h4>}
      <div className="divide-y rounded-lg border">{children}</div>
    </section>
  )
}

/**
 * Строка настройки: подпись и описание слева, контрол справа.
 * `inline` — контрол всегда справа (переключатели, степперы),
 * `responsive` — на узких экранах контрол уходит под подпись (селекты),
 * `stacked` — контрол всегда под подписью (поля ввода, списки).
 */
function SettingRow({
  label,
  labelAddon,
  htmlFor,
  description,
  layout = 'inline',
  children,
}: {
  label: ReactNode
  /** Элемент рядом с подписью, вне `<label>` (например, кнопка подсказки). */
  labelAddon?: ReactNode
  htmlFor?: string
  description?: ReactNode
  layout?: 'inline' | 'responsive' | 'stacked'
  children: ReactNode
}) {
  return (
    <div
      role="group"
      className={cn(
        'flex px-4 py-3.5',
        layout === 'inline' && 'items-center justify-between gap-4',
        layout === 'responsive' && 'flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6',
        layout === 'stacked' && 'flex-col gap-3'
      )}
    >
      <FieldContent className="min-w-0">
        {labelAddon ? (
          <div className="flex items-center gap-1.5">
            <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
            {labelAddon}
          </div>
        ) : (
          <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
        )}
        {description && <FieldDescription className="text-[13px] whitespace-pre-line">{description}</FieldDescription>}
      </FieldContent>
      {layout === 'responsive' ? <div className="w-full sm:w-52 sm:shrink-0">{children}</div> : children}
    </div>
  )
}

function OptionSelect({
  id,
  value,
  options,
  onValueChange,
  disabled = false,
}: {
  id: string
  value: string
  options: { value: string; label: string }[]
  onValueChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <Select
      disabled={disabled}
      value={value}
      items={Object.fromEntries(options.map((o) => [o.value, o.label]))}
      onValueChange={onValueChange}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function WarningAlert({ children }: { children: ReactNode }) {
  return (
    <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
      <IconAlertTriangle />
      <AlertDescription className="text-[13px] text-amber-700 dark:text-amber-300">{children}</AlertDescription>
    </Alert>
  )
}

/* ─── Controls ──────────────────────────────────────────────────────────────── */

const NumberStepperInput = memo(function NumberStepperInput({
  id,
  value,
  min,
  max,
  onCommit,
  className,
  inputClassName,
  ariaLabel,
  incrementLabel = 'Увеличить',
  decrementLabel = 'Уменьшить',
}: {
  id?: string
  value: number
  min: number
  max: number
  onCommit: (value: number) => void
  className?: string
  inputClassName?: string
  ariaLabel?: string
  incrementLabel?: string
  decrementLabel?: string
}) {
  const [draft, setDraft] = useState(() => String(value))
  const focusedRef = useRef(false)
  const skipCommitRef = useRef(false)

  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value))
  }, [value])

  const applyValue = useCallback(
    (raw: string | number) => {
      const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10)
      if (!Number.isFinite(parsed)) {
        setDraft(String(value))
        return
      }
      const next = Math.max(min, Math.min(max, Math.trunc(parsed)))
      setDraft(String(next))
      if (next !== value) onCommit(next)
    },
    [max, min, onCommit, value]
  )

  const step = useCallback(
    (delta: number) => {
      const parsed = Number.parseInt(draft, 10)
      applyValue((Number.isNaN(parsed) ? value : parsed) + delta)
    },
    [applyValue, draft, value]
  )

  return (
    <InputGroup className={className}>
      <InputGroupInput
        id={id}
        inputMode="numeric"
        className={inputClassName}
        value={draft}
        aria-label={ariaLabel}
        onFocus={() => {
          focusedRef.current = true
        }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            skipCommitRef.current = true
            focusedRef.current = false
            setDraft(String(value))
            e.currentTarget.blur()
          }
        }}
        onBlur={() => {
          focusedRef.current = false
          if (skipCommitRef.current) {
            skipCommitRef.current = false
            return
          }
          applyValue(draft)
        }}
      />
      <InputGroupAddon align="inline-end" className="flex flex-col gap-0">
        <InputGroupButton
          aria-label={incrementLabel}
          className="text-muted-foreground hover:text-foreground h-[calc(50%-0.5px)]! min-h-0! px-1 text-[9px]"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => step(1)}
        >
          <IconChevronUp />
        </InputGroupButton>
        <InputGroupButton
          aria-label={decrementLabel}
          className="text-muted-foreground hover:text-foreground h-[calc(50%-0.5px)]! min-h-0! px-1 text-[9px]"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => step(-1)}
        >
          <IconChevronDown />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
})

const IntervalSettingField = memo(function IntervalSettingField({
  item,
  value,
  onChangeInterval,
}: {
  item: IntervalSetting
  value: number
  onChangeInterval: IntervalSettingHandler
}) {
  const commit = useCallback((next: number) => onChangeInterval(item, next), [item, onChangeInterval])

  return (
    <SettingRow label={item.title} htmlFor={item.id} description={item.description}>
      <NumberStepperInput id={item.id} value={value} min={0} max={24} onCommit={commit} className="w-20 shrink-0" inputClassName="px-2" />
    </SettingRow>
  )
})

const ConfigHistorySnapshotsField = memo(function ConfigHistorySnapshotsField({
  value,
  onSave,
}: {
  value: number
  onSave: (value: number) => Promise<boolean>
}) {
  const commit = useCallback((next: number) => void onSave(next), [onSave])

  return (
    <SettingRow
      label="Снимков на файл"
      htmlFor="config-history-max-snapshots"
      description="Сколько версий каждого файла хранить в истории изменений, от 1 до 100. 0 — не вести историю"
    >
      <NumberStepperInput
        id="config-history-max-snapshots"
        value={value}
        min={0}
        max={100}
        onCommit={commit}
        className="w-20 shrink-0"
        inputClassName="px-2"
        ariaLabel="Количество снимков журнала изменений"
        incrementLabel="Увеличить количество снимков"
        decrementLabel="Уменьшить количество снимков"
      />
    </SettingRow>
  )
})

const SwitchSettingField = memo(function SwitchSettingField({
  item,
  checked,
  onToggleSetting,
}: {
  item: ToggleSetting
  checked: boolean
  onToggleSetting: ToggleSettingHandler
}) {
  const onToggle = useCallback((value: boolean) => onToggleSetting(item, value), [item, onToggleSetting])

  return (
    <SettingRow label={item.title} htmlFor={item.id} description={item.description}>
      <Switch id={item.id} checked={checked} onCheckedChange={onToggle} aria-label={item.title} />
    </SettingRow>
  )
})

/** Строка списка (прокси, скрытые файлы) с кнопкой удаления. */
const RemovableRow = memo(function RemovableRow({
  value,
  index,
  removeLabel,
  onRemove,
}: {
  value: string
  index: number
  removeLabel: string
  onRemove: (index: number) => Promise<void>
}) {
  const onRemoveClick = useCallback(() => void onRemove(index), [index, onRemove])

  return (
    <li className="bg-muted/40 flex min-w-0 items-center gap-2 rounded-md border py-1 pr-1 pl-3">
      <span className="min-w-0 flex-1 truncate text-sm" title={value}>
        {value}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-destructive shrink-0"
        onClick={onRemoveClick}
        aria-label={`${removeLabel} ${value}`}
      >
        <IconTrash className="size-4" />
      </Button>
    </li>
  )
})

const ProxySettingsField = memo(function ProxySettingsField({
  githubProxies,
  onAddProxy,
  onRemoveProxy,
}: {
  githubProxies: string[]
  onAddProxy: (url: string) => Promise<boolean>
  onRemoveProxy: (index: number) => Promise<void>
}) {
  const [newProxy, setNewProxy] = useState('')
  const hasNewProxy = newProxy.trim().length > 0

  const addProxy = useCallback(async () => {
    if (!hasNewProxy) return
    const ok = await onAddProxy(newProxy)
    if (ok) setNewProxy('')
  }, [hasNewProxy, newProxy, onAddProxy])

  return (
    <SettingRow
      layout="stacked"
      label="GitHub-прокси"
      htmlFor="github-proxy-input"
      description="Используются для загрузки обновлений, если GitHub недоступен. Перебираются сверху вниз"
    >
      {githubProxies.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">Прокси не добавлены</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {githubProxies.map((proxy, index) => (
            <RemovableRow key={proxy + index} value={proxy} index={index} removeLabel="Удалить прокси" onRemove={onRemoveProxy} />
          ))}
        </ul>
      )}

      <InputGroup>
        <InputGroupAddon align="inline-start">https://</InputGroupAddon>
        <InputGroupInput
          id="github-proxy-input"
          value={newProxy}
          onChange={(e) => setNewProxy(e.target.value.replace(/^https?:\/\//i, ''))}
          onKeyDown={(e) => e.key === 'Enter' && void addProxy()}
          placeholder="example.com"
          className="pl-0!"
        />
        <InputGroupAddon align="inline-end">
          {hasNewProxy && (
            <InputGroupButton
              aria-label="Очистить поле"
              className="text-muted-foreground hover:text-destructive hover:bg-transparent!"
              onClick={() => setNewProxy('')}
            >
              <ClearIcon size={14} />
            </InputGroupButton>
          )}
        </InputGroupAddon>
        <InputGroupAddon align="inline-end">
          <InputGroupButton variant="default" className="rounded-sm text-xs" onClick={() => void addProxy()} disabled={!hasNewProxy}>
            Добавить
            <IconCornerDownLeft />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </SettingRow>
  )
})

const HiddenFilesField = memo(function HiddenFilesField({
  hiddenFiles,
  onRemoveFile,
}: {
  hiddenFiles: string[]
  onRemoveFile: (index: number) => Promise<void>
}) {
  return (
    <SettingRow
      layout="stacked"
      label="Скрытые файлы"
      description="Файлы, скрытые из вкладок редактора. Удалите файл из списка, чтобы вернуть вкладку"
    >
      {hiddenFiles.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">Нет скрытых файлов</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {hiddenFiles.map((file, index) => (
            <RemovableRow key={file + index} value={file} index={index} removeLabel="Показать файл" onRemove={onRemoveFile} />
          ))}
        </ul>
      )}
    </SettingRow>
  )
})

type RepoSourceKey = 'xrayRepo' | 'mihomoRepo'

const GITHUB_REPO_PREFIX = 'https://github.com/'

function normalizeGitHubRepoUrl(raw: string): string | null {
  let url = raw.trim().replace(/\/+$/, '')
  if (!url) return null
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  url = url.replace(/^http:\/\/github\.com\//i, GITHUB_REPO_PREFIX)
  const match = url.match(/^https:\/\/github\.com\/([^/\s?#]+)\/([^/\s?#]+)(?:[/?#].*)?$/i)
  if (!match) return null
  const owner = match[1]
  const repo = match[2].replace(/\.git$/i, '')
  if (!owner || !repo) return null
  return `${GITHUB_REPO_PREFIX}${owner}/${repo}`
}

const RepoSourceField = memo(function RepoSourceField({
  repoKey,
  label,
  description,
  value,
  onSave,
  showToast,
}: {
  repoKey: RepoSourceKey
  label: string
  description: string
  value: string
  onSave: (key: RepoSourceKey, url: string) => Promise<boolean>
  showToast: (msg: string, type?: 'success' | 'error') => void
}) {
  const [draft, setDraft] = useState(value)

  const defaultUrl = repoKey === 'xrayRepo' ? 'https://github.com/XTLS/Xray-core' : 'https://github.com/MetaCubeX/mihomo'

  const invalid = normalizeGitHubRepoUrl(draft) === null

  const save = useCallback(
    async (overrideUrl?: string) => {
      const raw = (typeof overrideUrl === 'string' ? overrideUrl : draft).trim().replace(/\/+$/, '')
      if (!raw) {
        showToast('URL репозитория не может быть пустым', 'error')
        return
      }
      const url = normalizeGitHubRepoUrl(raw)
      if (!url) {
        showToast('Некорректный URL', 'error')
        return
      }
      if (url === value) {
        setDraft(url)
        return
      }
      if (await onSave(repoKey, url)) setDraft(url)
    },
    [draft, onSave, repoKey, showToast, value]
  )

  return (
    <SettingRow layout="stacked" label={label} htmlFor={`${repoKey}-input`} description={description}>
      <div className="flex flex-col gap-1.5">
        <InputGroup>
          <InputGroupInput
            id={`${repoKey}-input`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            onBlur={() => void save()}
            placeholder={defaultUrl}
            aria-invalid={invalid}
          />
          {draft !== defaultUrl && (
            <InputGroupAddon align="inline-end">
              <TooltipProvider delayDuration={500}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <InputGroupButton
                        aria-label="Вернуть значение по умолчанию"
                        className="text-muted-foreground hover:text-foreground hover:bg-transparent!"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => void save(defaultUrl)}
                      >
                        <IconArrowBackUp className="size-4.5" />
                      </InputGroupButton>
                    }
                  />
                  <TooltipContent side="top" sideOffset={4}>
                    Вернуть значение по умолчанию
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </InputGroupAddon>
          )}
        </InputGroup>
        {invalid && <FieldError>Некорректный URL репозитория GitHub</FieldError>}
      </div>
    </SettingRow>
  )
})

const PING_URL_PRESETS = [
  'yahoo.com',
  'cp.cloudflare.com/generate_204',
  'www.gstatic.com/generate_204',
  'www.google.com/generate_204',
  'www.youtube.com/generate_204',
  'redirector.googlevideo.com/generate_204',
  'connectivitycheck.gstatic.com/generate_204',
] as const

const PING_URL_CUSTOM = '__custom__'

function parsePingUrl(raw: string): { protocol: string; host: string; custom: boolean } {
  const match = raw.match(/^(https?):\/\/(.+)$/i)
  const protocol = match?.[1]?.toLowerCase() ?? 'https'
  const host = match?.[2] ?? raw
  return { protocol, host, custom: !(PING_URL_PRESETS as readonly string[]).includes(host) }
}

const PingTestSettingsField = memo(function PingTestSettingsField({
  pingUrl,
  pingTimeout,
  onSave,
  showToast,
}: {
  pingUrl: string
  pingTimeout: number
  onSave: (url: string, timeout: number) => Promise<boolean>
  showToast: (msg: string, type?: 'success' | 'error') => void
}) {
  const [initial] = useState(() => parsePingUrl(pingUrl))
  const [protocol, setProtocol] = useState(initial.protocol)
  const [host, setHost] = useState(initial.host)
  const [custom, setCustom] = useState(initial.custom)
  const [timeout, setTimeout] = useState(String(pingTimeout))

  const save = useCallback(async () => {
    const tHost = host.trim()
    const tTimeout = Number(timeout)
    if (!tHost) return showToast('URL пинг-теста пустой', 'error')
    if (!(Number.isInteger(tTimeout) && tTimeout > 0)) return showToast('Таймаут должен быть целым числом больше 0', 'error')
    const tUrl = `${protocol}://${tHost}`
    if (tUrl === pingUrl && tTimeout === pingTimeout) return
    const ok = await onSave(tUrl, tTimeout)
    if (ok) {
      setHost(tHost)
      setTimeout(String(tTimeout))
    }
  }, [onSave, pingUrl, pingTimeout, showToast, timeout, host, protocol])

  const saveHost = useCallback(
    async (newHost: string, newProtocol: string) => {
      const tHost = newHost.trim()
      const tTimeout = Number(timeout)
      if (!tHost) return showToast('URL пинг-теста пустой', 'error')
      if (!(Number.isInteger(tTimeout) && tTimeout > 0)) return showToast('Таймаут должен быть целым числом больше 0', 'error')
      const tUrl = `${newProtocol}://${tHost}`
      if (tUrl === pingUrl && tTimeout === pingTimeout) return
      const ok = await onSave(tUrl, tTimeout)
      if (ok) {
        setHost(tHost)
        setProtocol(newProtocol)
        setTimeout(String(tTimeout))
      }
    },
    [onSave, pingUrl, pingTimeout, showToast, timeout]
  )

  const hostSelectValue = custom ? PING_URL_CUSTOM : host

  return (
    <>
      <SettingRow
        layout="stacked"
        label="Адрес проверки"
        htmlFor="ping-test-host"
        description="Адрес, к которому идёт запрос при проверке задержки подключений Xray и Mihomo"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Select
            value={protocol}
            items={{ http: 'http', https: 'https' }}
            onValueChange={(value) => {
              setProtocol(value)
              void saveHost(host, value)
            }}
          >
            <SelectTrigger className="w-24 shrink-0" aria-label="Протокол">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="http">http</SelectItem>
                <SelectItem value="https">https</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select
            value={hostSelectValue}
            items={{
              ...Object.fromEntries(PING_URL_PRESETS.map((p) => [p, p])),
              [PING_URL_CUSTOM]: 'Свой адрес…',
            }}
            onValueChange={(value) => {
              if (value === PING_URL_CUSTOM) {
                setCustom(true)
              } else {
                setHost(value)
                setCustom(false)
                void saveHost(value, protocol)
              }
            }}
          >
            <SelectTrigger id="ping-test-host" className="min-w-0 flex-1" aria-label="Хост">
              {custom ? <span className="text-muted-foreground">Свой адрес…</span> : <SelectValue />}
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {PING_URL_PRESETS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
                <SelectItem value={PING_URL_CUSTOM} className="text-muted-foreground">
                  Свой адрес…
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {custom && (
          <InputGroup>
            <InputGroupAddon align="inline-start">{protocol}://</InputGroupAddon>
            <InputGroupInput
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
              onBlur={() => void save()}
              placeholder="www.example.com/generate_204"
              aria-label="Свой адрес проверки"
              className="pl-0!"
            />
          </InputGroup>
        )}
      </SettingRow>

      <SettingRow
        layout="responsive"
        label="Таймаут"
        htmlFor="ping-test-timeout"
        description="Если ответа нет дольше этого времени, подключение считается недоступным"
      >
        <InputGroup>
          <InputGroupInput
            id="ping-test-timeout"
            type="number"
            min={1}
            step={100}
            inputMode="numeric"
            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            value={timeout}
            onChange={(e) => setTimeout(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            onBlur={() => void save()}
            placeholder="5000"
          />
          <InputGroupAddon align="inline-end" className="text-muted-foreground px-2 text-xs">
            мс
          </InputGroupAddon>
        </InputGroup>
      </SettingRow>
    </>
  )
})

function AuthSettingsField({ authEnabled, onToggle }: { authEnabled: boolean; onToggle: (value: boolean) => Promise<void> }) {
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const toggle = useCallback(
    async (value: boolean) => {
      if (pendingRef.current) return
      pendingRef.current = true
      setPending(true)
      try {
        await onToggle(value)
      } finally {
        pendingRef.current = false
        setPending(false)
      }
    },
    [onToggle]
  )

  return (
    <SettingsGroup>
      <SettingRow label="Вход по паролю" htmlFor="auth-enabled" description="Запрашивать пароль при открытии панели">
        <Switch id="auth-enabled" checked={authEnabled} disabled={pending} onCheckedChange={toggle} aria-label="Вход по паролю" />
      </SettingRow>

      <SettingRow label="Пользователи" description="Добавление пользователей и смена паролей для входа">
        <Button variant="outline" size="sm" onClick={() => navigate('users')}>
          Открыть
        </Button>
      </SettingRow>
    </SettingsGroup>
  )
}

type TrafficGuardStatus = {
  success: boolean
  error?: string
  enabled: boolean
  active: boolean
  supported: boolean
  reason: string | null
  ports: string | null
  mode: 'proxy' | 'strict'
  target: string
  core?: string
  targets?: string[]
  health?: { blocked: boolean; vpn: string | null; error: string | null }
}

function TrafficGuardHelp({ ports }: { ports: string }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Для чего нужна блокировка трафика мимо прокси"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex rounded-full align-middle outline-none focus-visible:ring-3"
          />
        }
      >
        <IconHelpCircle className="size-4" />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-80 gap-2 text-[13px] leading-relaxed">
        <p>
          Устройства из политики доступа XKeen ходят на проксируемые порты ({ports}) через Xray. Если XKeen остановлен, ядро упало или
          роутер ещё загружается, перехвата нет, и этот трафик уходит в интернет напрямую через провайдера.
        </p>
        <p>С этой опцией такой трафик отбрасывается: без работающего прокси сайты не откроются, но и ваш реальный IP не утечёт.</p>
        <p className="text-muted-foreground">
          Не затрагивает: остальные порты этих устройств, устройства вне политики XKeen, локальную сеть, адреса из исключений XKeen и
          запросы самого роутера. Пока прокси работает, правило ничего не блокирует.
        </p>
      </PopoverContent>
    </Popover>
  )
}

function TrafficGuardField({ showToast }: { showToast: (msg: string, type?: 'success' | 'error') => void }) {
  const [status, setStatus] = useState<TrafficGuardStatus | null>(null)
  const requestId = useRef(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      const id = ++requestId.current
      return apiCall<TrafficGuardStatus>('GET', 'traffic-guard')
        .then((result) => {
          if (cancelled || id !== requestId.current) return
          if (result.success) {
            setStatus(result)
            setLoadError(result.error ?? null)
          } else setLoadError(result.error ?? 'Не удалось получить состояние')
        })
        .catch((e: Error) => {
          if (!cancelled && id === requestId.current) setLoadError(e.message)
        })
    }
    void load()
    const interval = setInterval(() => {
      if (!document.hidden) void load()
    }, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const toggle = useCallback(
    async (enabled: boolean, mode = status?.mode ?? 'proxy', target = status?.target ?? '') => {
      setPending(true)
      ++requestId.current
      try {
        const result = await apiCall<TrafficGuardStatus>('PUT', 'traffic-guard', { enabled, mode, target }, { timeoutMs: 30000 })
        if (!result.success) {
          showToast('Ошибка: ' + result.error, 'error')
          return
        }
        ++requestId.current
        setStatus(result)
        setLoadError(null)
        showToast(enabled ? 'Блокировка трафика мимо прокси включена' : 'Блокировка трафика мимо прокси выключена', 'success')
      } catch (e) {
        showToast((e as Error).message, 'error')
      } finally {
        setPending(false)
      }
    },
    [showToast, status?.mode, status?.target]
  )

  const ports = status?.ports ?? '80, 443'
  let state: ReactNode = null
  if (loadError) state = <FieldError>{loadError}</FieldError>
  else if (status && !status.supported && status.reason) state = <WarningAlert>{status.reason}</WarningAlert>
  else if (status?.enabled && !status.active)
    state = <WarningAlert>Хук установлен, но действие правил не подтверждено. Защиту нельзя считать работающей.</WarningAlert>

  return (
    <SettingsGroup>
      <SettingRow
        label="Блокировать трафик мимо прокси"
        labelAddon={<TrafficGuardHelp ports={ports} />}
        htmlFor="traffic-guard"
        description={
          status?.mode === 'strict'
            ? 'Блокировать весь интернет устройств политики XKeen, когда VPN недоступен'
            : `Если XKeen не работает, устройства из его политики не выйдут в интернет напрямую на портах ${ports}`
        }
      >
        <Switch
          id="traffic-guard"
          checked={status?.enabled ?? false}
          disabled={pending || !status || (!status.supported && !status.enabled)}
          onCheckedChange={(enabled) => void toggle(enabled)}
          aria-label="Блокировать трафик мимо прокси"
        />
      </SettingRow>
      <SettingRow
        label="Режим защиты"
        htmlFor="traffic-guard-mode"
        description={
          status?.mode === 'strict'
            ? 'При недоступном VPN блокируется весь интернет устройств политики XKeen, включая direct и любые порты. Локальная сеть и панель доступны. Проверка каждые 5 секунд; блокировка включается после неуспешной проверки, снимается после успешной.'
            : 'Блокирует обход перехвата XKeen на проксируемых портах. Маршруты direct при работающем ядре доступны.'
        }
        layout="responsive"
      >
        <OptionSelect
          id="traffic-guard-mode"
          disabled={pending || !status}
          value={status?.mode ?? 'proxy'}
          options={[
            { value: 'proxy', label: 'Защита от обхода' },
            { value: 'strict', label: 'Весь интернет только при доступном VPN' },
          ]}
          onValueChange={(mode) => {
            if (!pending && status) void toggle(status.enabled, mode as 'proxy' | 'strict')
          }}
        />
      </SettingRow>
      {status?.mode === 'strict' && status.core === 'mihomo' && (
        <SettingRow
          label="Проверяемый VPN"
          htmlFor="traffic-guard-target"
          description="Выберите сервер или группу. Прямой выход не считается работающим VPN."
          layout="responsive"
        >
          <OptionSelect
            id="traffic-guard-target"
            disabled={pending}
            value={status.target || '__none__'}
            options={[
              { value: '__none__', label: 'Выберите VPN' },
              ...(status.targets ?? []).map((name) => ({ value: name, label: name })),
            ]}
            onValueChange={(target) => {
              if (!pending) void toggle(status.enabled, 'strict', target === '__none__' ? '' : target)
            }}
          />
        </SettingRow>
      )}
      {status?.enabled && status.mode === 'strict' && (
        <div className="px-4 py-3.5">
          <WarningAlert>
            {status.health?.blocked !== false
              ? `Интернет заблокирован: ${status.health?.error ?? 'ожидание проверки VPN'}`
              : `VPN доступен: ${status.health.vpn}. Интернет разрешён.`}
          </WarningAlert>
        </div>
      )}
      {state && <div className="px-4 py-3.5">{state}</div>}
    </SettingsGroup>
  )
}

/* ─── Modal ─────────────────────────────────────────────────────────────────── */

export function SettingsPage() {
  const { state, dispatch, showToast } = useAppContext({ includeSettings: true })
  const { settings } = state
  const [section, setSection] = useState<SectionId>('appearance')

  const saveSetting = useCallback(
    async (path: string, value: unknown) => {
      const [section, key] = path.split('.')
      try {
        const body: Record<string, unknown> = {}
        if (['gui', 'updater', 'log', 'auth', 'clash_api', 'ui', 'config_history'].includes(section))
          body[section] = key ? { [key]: value } : value
        const result = await apiCall<any>('PATCH', 'settings', body, { timeoutMs: 15000 })
        if (!result.success) {
          showToast('Ошибка: ' + result.error, 'error')
          return false
        }
        return true
      } catch (e: any) {
        showToast(e.message, 'error')
        return false
      }
    },
    [showToast]
  )

  const toggleSetting = useCallback(
    async (item: ToggleSetting, value: boolean) => {
      const ok = await saveSetting(item.path, value)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { [item.key]: value } as Partial<AppSettings> })
    },
    [dispatch, saveSetting]
  )

  const setCheckInterval = useCallback(
    async (item: IntervalSetting, value: number) => {
      const hours = Math.max(0, Math.min(24, value))
      if (hours === settings[item.key]) return
      const ok = await saveSetting(item.path, hours)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { [item.key]: hours } })
    },
    [dispatch, saveSetting, settings]
  )

  const setTheme = useCallback(
    (value: string) => {
      dispatch({ type: 'SET_SETTINGS', settings: { theme: value as ThemeMode } })
    },
    [dispatch]
  )

  const toggleAuth = useCallback(
    async (value: boolean) => {
      const ok = await saveSetting('auth.enabled', value)
      if (ok) {
        dispatch({ type: 'SET_SETTINGS', settings: { authEnabled: value } })
        if (value) window.location.reload()
      }
    },
    [dispatch, saveSetting]
  )

  const setConfigHistoryMaxSnapshots = useCallback(
    async (value: number) => {
      const count = Math.max(0, Math.min(100, Math.trunc(value)))
      if (count === settings.configHistoryMaxSnapshots) return true
      const ok = await saveSetting('config_history.max_snapshots', count)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { configHistoryMaxSnapshots: count } })
      return ok
    },
    [dispatch, saveSetting, settings.configHistoryMaxSnapshots]
  )

  const setEmojiFont = useCallback(
    (value: string) => {
      applyEmojiFont(value as EmojiFont)
      dispatch({ type: 'SET_SETTINGS', settings: { emojiFont: value as EmojiFont } })
    },
    [dispatch]
  )

  const setProxyLabelStyle = useCallback(
    (value: string) => {
      if (value !== 'plain' && value !== 'outlined') return
      saveProxyLabelStyle(value)
      dispatch({ type: 'SET_SETTINGS', settings: { proxyLabelStyle: value } })
    },
    [dispatch]
  )

  const addProxy = useCallback(
    async (rawUrl: string) => {
      let url = rawUrl.trim().replace(/\/+$/, '')
      if (!url) return false
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url
      if (settings.githubProxies.includes(url)) {
        showToast('Уже добавлен', 'error')
        return false
      }
      const next = [...settings.githubProxies, url]
      const ok = await saveSetting('updater.github_proxy', next)
      if (ok) {
        dispatch({ type: 'SET_SETTINGS', settings: { githubProxies: next } })
        return true
      }
      return false
    },
    [dispatch, saveSetting, settings.githubProxies, showToast]
  )

  const removeProxy = useCallback(
    async (index: number) => {
      const next = settings.githubProxies.filter((_, i) => i !== index)
      const ok = await saveSetting('updater.github_proxy', next)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { githubProxies: next } })
    },
    [dispatch, saveSetting, settings.githubProxies]
  )

  const removeHiddenFile = useCallback(
    async (index: number) => {
      const next = settings.hiddenConfigFiles.filter((_, i) => i !== index)
      const ok = await saveSetting('ui', { hidden_files: next })
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { hiddenConfigFiles: next } })
    },
    [dispatch, saveSetting, settings.hiddenConfigFiles]
  )

  const saveRepoSource = useCallback(
    async (key: RepoSourceKey, url: string) => {
      const ok = await saveSetting(key === 'xrayRepo' ? 'updater.xray_repo' : 'updater.mihomo_repo', url)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { [key]: url } })
      return ok
    },
    [dispatch, saveSetting]
  )

  const setTimezone = useCallback(
    async (value: string) => {
      const offset = parseInt(value, 10)
      const ok = await saveSetting('log.timezone', offset)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { timezone: offset } })
    },
    [dispatch, saveSetting]
  )

  const savePingTestSettings = useCallback(
    async (url: string, timeout: number) => {
      const ok = await saveSetting('clash_api', { ping_url: url, ping_timeout: timeout })
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { pingTestUrl: url, pingTestTimeout: timeout } })
      return ok
    },
    [dispatch, saveSetting]
  )

  const toggleHideUnavailable = useCallback(
    async (value: boolean) => {
      const ok = await saveSetting('clash_api', { hide_unavailable_proxies: value })
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { hideUnavailableProxies: value } })
    },
    [dispatch, saveSetting]
  )

  const setPingMode = useCallback(
    async (value: string) => {
      const ok = await saveSetting('clash_api', { ping_mode: value })
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { pingMode: value as PingMode } })
    },
    [dispatch, saveSetting]
  )

  const setProxySortOrder = useCallback(
    async (value: string) => {
      const ok = await saveSetting('clash_api', { proxy_sort_order: value })
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { proxySortOrder: value as ProxySortOrder } })
    },
    [dispatch, saveSetting]
  )

  const setHideCounter = useCallback(
    async (value: number) => {
      const v = Math.max(1, Math.min(10, value))
      if (v === settings.hideUnavailableProxiesCounter) return
      const ok = await saveSetting('clash_api', { hide_unavailable_proxies_counter: v })
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { hideUnavailableProxiesCounter: v } })
    },
    [dispatch, saveSetting, settings.hideUnavailableProxiesCounter]
  )

  const setAutoDns = useCallback(
    (value: string) => {
      void saveSetting('clash_api', { auto_dns: value }).then((ok) => {
        if (ok) dispatch({ type: 'SET_SETTINGS', settings: { autoDns: value as AutoDnsMode } })
      })
    },
    [dispatch, saveSetting]
  )

  const activeSection = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]

  const renderSection = () => {
    switch (section) {
      case 'appearance':
        return (
          <SettingsGroup>
            <SettingRow layout="responsive" label="Тема" htmlFor="theme" description="Выберите оформление или следуйте настройке системы">
              <OptionSelect id="theme" value={settings.theme} options={themeOptions} onValueChange={setTheme} />
            </SettingRow>
            <SettingRow
              layout="responsive"
              label="Шрифт эмодзи"
              htmlFor="emoji-font"
              description="Используется для флагов и других эмодзи. Шрифты, кроме Twemoji, должны быть установлены в системе"
            >
              <OptionSelect id="emoji-font" value={settings.emojiFont} options={emojiFontOptions} onValueChange={setEmojiFont} />
            </SettingRow>
          </SettingsGroup>
        )

      case 'editor':
        return (
          <>
            <SettingsGroup title="Визуальный редактор Xray">
              <div className="px-4 py-3.5">
                <WarningAlert>
                  При включении визуального редактора комментарии в JSON будут потеряны. Перед включением создайте резервную копию.
                </WarningAlert>
              </div>
              {guiSettings.map((item) => (
                <SwitchSettingField key={item.id} item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
              ))}
            </SettingsGroup>
            <SettingsGroup title="Файлы и история">
              <HiddenFilesField hiddenFiles={settings.hiddenConfigFiles} onRemoveFile={removeHiddenFile} />
              <ConfigHistorySnapshotsField value={settings.configHistoryMaxSnapshots} onSave={setConfigHistoryMaxSnapshots} />
            </SettingsGroup>
            <SettingsGroup title="Журнал">
              <SettingRow layout="responsive" label="Часовой пояс" htmlFor="timezone" description="Сдвиг времени для записей в журнале">
                <OptionSelect id="timezone" value={String(settings.timezone)} options={timezoneOptions} onValueChange={setTimezone} />
              </SettingRow>
            </SettingsGroup>
          </>
        )

      case 'access':
        return <AuthSettingsField authEnabled={settings.authEnabled} onToggle={toggleAuth} />

      case 'protection':
        return <TrafficGuardField showToast={showToast} />

      case 'ping':
        return (
          <SettingsGroup>
            <PingTestSettingsField
              key={`${settings.pingTestUrl}\x00${settings.pingTestTimeout}`}
              pingUrl={settings.pingTestUrl}
              pingTimeout={settings.pingTestTimeout}
              onSave={savePingTestSettings}
              showToast={showToast}
            />
            <SettingRow
              layout="responsive"
              label="Режим проверки"
              htmlFor="ping-mode"
              description={
                'Только для проверок через Xray.\nДвойной: первый запрос прогревает DNS и MUX, второй измеряется.\nKeepAlive: второй запрос идёт по тому же соединению.'
              }
            >
              <OptionSelect id="ping-mode" value={settings.pingMode} options={pingModeOptions} onValueChange={setPingMode} />
            </SettingRow>
          </SettingsGroup>
        )

      case 'mihomo':
        return (
          <>
            <SettingsGroup title="Селекторы">
              <SettingRow
                layout="responsive"
                label="Теги подключений"
                htmlFor="proxy-label-style"
                description="Как показывать теги подключений"
              >
                <OptionSelect
                  id="proxy-label-style"
                  value={settings.proxyLabelStyle}
                  options={proxyLabelStyleOptions}
                  onValueChange={setProxyLabelStyle}
                />
              </SettingRow>
              <SettingRow
                label="Скрывать недоступные"
                htmlFor="hide-unavailable"
                description="Скрывать подключения, у которых несколько проверок подряд закончились таймаутом"
              >
                <Switch
                  id="hide-unavailable"
                  checked={settings.hideUnavailableProxies}
                  onCheckedChange={toggleHideUnavailable}
                  aria-label="Скрывать недоступные подключения"
                />
              </SettingRow>
              <SettingRow
                label="Порог таймаутов"
                htmlFor="hide-counter"
                description="Сколько таймаутов подряд нужно для скрытия, от 1 до 10"
              >
                <NumberStepperInput
                  id="hide-counter"
                  value={settings.hideUnavailableProxiesCounter}
                  min={1}
                  max={10}
                  onCommit={setHideCounter}
                  className="w-20 shrink-0"
                  inputClassName="px-2"
                />
              </SettingRow>
              <SettingRow
                layout="responsive"
                label="Сортировка"
                htmlFor="proxy-sort"
                description="Порядок подключений в списке. Не влияет на логику fallback"
              >
                <OptionSelect
                  id="proxy-sort"
                  value={settings.proxySortOrder}
                  options={sortOrderOptions}
                  onValueChange={setProxySortOrder}
                />
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title="Соединения">
              {clashApiSettings.map((item) => (
                <SwitchSettingField key={item.id} item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
              ))}
            </SettingsGroup>
            <SettingsGroup title="DNS">
              <SettingRow
                layout="responsive"
                label="Управление DNS при запуске"
                htmlFor="auto-dns"
                description="Автоматически включать управление DNS при ручном запуске сервиса"
              >
                <OptionSelect id="auto-dns" value={settings.autoDns} options={autoDnsOptions} onValueChange={setAutoDns} />
              </SettingRow>
            </SettingsGroup>
          </>
        )

      case 'updates':
        return (
          <>
            <SettingsGroup title="Автоматическая проверка">
              {checkIntervalSettings.map((item) => (
                <IntervalSettingField key={item.id} item={item} value={settings[item.key]} onChangeInterval={setCheckInterval} />
              ))}
              {updateSettings.map((item) => (
                <SwitchSettingField key={item.id} item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
              ))}
            </SettingsGroup>
            <SettingsGroup title="Источники обновлений">
              <RepoSourceField
                repoKey="xrayRepo"
                label="Репозиторий Xray"
                description="Репозиторий GitHub, из которого проверяются и загружаются обновления Xray"
                value={settings.xrayRepo}
                onSave={saveRepoSource}
                showToast={showToast}
              />
              <RepoSourceField
                repoKey="mihomoRepo"
                label="Репозиторий Mihomo"
                description="Репозиторий GitHub, из которого проверяются и загружаются обновления Mihomo"
                value={settings.mihomoRepo}
                onSave={saveRepoSource}
                showToast={showToast}
              />
              <ProxySettingsField githubProxies={settings.githubProxies} onAddProxy={addProxy} onRemoveProxy={removeProxy} />
            </SettingsGroup>
          </>
        )
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-wider uppercase">Настройки панели</h1>
        <p className="text-muted-foreground text-sm">Внешний вид, доступ и параметры панели. Изменения сохраняются автоматически.</p>
      </header>
      <div className="bg-card flex min-h-[32rem] flex-col overflow-hidden rounded-lg border md:flex-row">
        <nav aria-label="Разделы настроек" className="hidden w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-3 md:flex">
          {SECTIONS.map(({ id, label, icon: SectionIcon }) => {
            const active = id === section
            return (
              <button
                key={id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => setSection(id)}
                className={cn(
                  'focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors outline-none focus-visible:ring-[3px]',
                  active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <SectionIcon className="size-4 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            )
          })}
        </nav>

        <div className="border-b px-5 py-3 md:hidden">
          <Select value={section} items={sectionItems} onValueChange={(value) => setSection(value as SectionId)}>
            <SelectTrigger className="w-full" aria-label="Раздел настроек">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {SECTIONS.map(({ id, label }) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div key={section} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="flex min-w-0 flex-col gap-6">
            <header className="flex flex-col gap-1">
              <h3 className="text-[15px] font-bold tracking-wider uppercase">{activeSection.label}</h3>
              <p className="text-muted-foreground text-sm">{activeSection.description}</p>
            </header>
            {renderSection()}
          </div>
        </div>
      </div>
    </div>
  )
}
