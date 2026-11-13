import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ClearIcon } from '@/components/ui/clear-icon'
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@/components/ui/combobox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, copyText } from '@/lib/utils'
import { IconCheck, IconCopy, IconFlag, IconInfoCircle, IconPlus, IconRefresh, IconReplace, IconSearch } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import {
  listMihomoProviders,
  listMihomoProxies,
  providerEntryName,
  proxyItemName,
  withProviderName,
  withProxyName,
} from '../../lib/mihomoReplace'
import { useAppContext, useModalContext } from '../../lib/store'

const USER_AGENTS = [
  'ClashMeta/1.19.30; mihomo/1.19.30',
  'ClashMetaForAndroid/2.11.33.Meta',
  'Happ/5.6.0/ios/2608171408651',
  'v2rayN/7.24.8',
  'v2rayNG/2.2.6',
]

const CLIENT_FINGERPRINTS = ['chrome', 'firefox', 'safari', 'iOS', 'android', 'edge', '360', 'qq', 'random']

const FLAG_OPTIONS: { emoji: string; label: string; en: string }[] = [
  { emoji: '🇷🇺', label: 'Россия', en: 'Russia' },
  { emoji: '🇺🇦', label: 'Украина', en: 'Ukraine' },
  { emoji: '🇧🇾', label: 'Беларусь', en: 'Belarus' },
  { emoji: '🇰🇿', label: 'Казахстан', en: 'Kazakhstan' },
  { emoji: '🇺🇿', label: 'Узбекистан', en: 'Uzbekistan' },
  { emoji: '🇬🇪', label: 'Грузия', en: 'Georgia' },
  { emoji: '🇦🇲', label: 'Армения', en: 'Armenia' },
  { emoji: '🇦🇿', label: 'Азербайджан', en: 'Azerbaijan' },
  { emoji: '🇫🇮', label: 'Финляндия', en: 'Finland' },
  { emoji: '🇸🇪', label: 'Швеция', en: 'Sweden' },
  { emoji: '🇳🇴', label: 'Норвегия', en: 'Norway' },
  { emoji: '🇩🇰', label: 'Дания', en: 'Denmark' },
  { emoji: '🇮🇸', label: 'Исландия', en: 'Iceland' },
  { emoji: '🇩🇪', label: 'Германия', en: 'Germany' },
  { emoji: '🇫🇷', label: 'Франция', en: 'France' },
  { emoji: '🇳🇱', label: 'Нидерланды', en: 'Netherlands' },
  { emoji: '🇧🇪', label: 'Бельгия', en: 'Belgium' },
  { emoji: '🇨🇭', label: 'Швейцария', en: 'Switzerland' },
  { emoji: '🇦🇹', label: 'Австрия', en: 'Austria' },
  { emoji: '🇵🇱', label: 'Польша', en: 'Poland' },
  { emoji: '🇨🇿', label: 'Чехия', en: 'Czechia' },
  { emoji: '🇸🇰', label: 'Словакия', en: 'Slovakia' },
  { emoji: '🇭🇺', label: 'Венгрия', en: 'Hungary' },
  { emoji: '🇷🇴', label: 'Румыния', en: 'Romania' },
  { emoji: '🇧🇬', label: 'Болгария', en: 'Bulgaria' },
  { emoji: '🇬🇷', label: 'Греция', en: 'Greece' },
  { emoji: '🇷🇸', label: 'Сербия', en: 'Serbia' },
  { emoji: '🇭🇷', label: 'Хорватия', en: 'Croatia' },
  { emoji: '🇸🇮', label: 'Словения', en: 'Slovenia' },
  { emoji: '🇮🇹', label: 'Италия', en: 'Italy' },
  { emoji: '🇪🇸', label: 'Испания', en: 'Spain' },
  { emoji: '🇵🇹', label: 'Португалия', en: 'Portugal' },
  { emoji: '🇮🇪', label: 'Ирландия', en: 'Ireland' },
  { emoji: '🇬🇧', label: 'Великобритания', en: 'United Kingdom' },
  { emoji: '🇪🇪', label: 'Эстония', en: 'Estonia' },
  { emoji: '🇱🇻', label: 'Латвия', en: 'Latvia' },
  { emoji: '🇱🇹', label: 'Литва', en: 'Lithuania' },
  { emoji: '🇺🇸', label: 'США', en: 'United States' },
  { emoji: '🇨🇦', label: 'Канада', en: 'Canada' },
  { emoji: '🇧🇷', label: 'Бразилия', en: 'Brazil' },
  { emoji: '🇦🇷', label: 'Аргентина', en: 'Argentina' },
  { emoji: '🇯🇵', label: 'Япония', en: 'Japan' },
  { emoji: '🇰🇷', label: 'Южная Корея', en: 'South Korea' },
  { emoji: '🇨🇳', label: 'Китай', en: 'China' },
  { emoji: '🇸🇬', label: 'Сингапур', en: 'Singapore' },
  { emoji: '🇭🇰', label: 'Гонконг', en: 'Hong Kong' },
  { emoji: '🇹🇼', label: 'Тайвань', en: 'Taiwan' },
  { emoji: '🇹🇷', label: 'Турция', en: 'Turkey' },
  { emoji: '🇮🇱', label: 'Израиль', en: 'Israel' },
  { emoji: '🇦🇪', label: 'ОАЭ', en: 'UAE' },
  { emoji: '🇮🇳', label: 'Индия', en: 'India' },
  { emoji: '🇦🇺', label: 'Австралия', en: 'Australia' },
  { emoji: '🇳🇿', label: 'Новая Зеландия', en: 'New Zealand' },
  { emoji: '🇿🇦', label: 'ЮАР', en: 'South Africa' },
]

function appendFlags(value: string, flags: string[]): string {
  const next = flags.filter((flag) => !value.includes(flag))
  if (!next.length) return value
  const joined = next.join('|')
  if (!value.trim()) return joined
  return value.endsWith('|') ? value + joined : `${value}|${joined}`
}

function FlagPicker({ value, onAdd }: { value: string; onAdd: (next: string) => void }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')

  const search = query.trim().toLowerCase()
  const visibleFlags = search
    ? FLAG_OPTIONS.filter((flag) => flag.label.toLowerCase().includes(search) || flag.en.toLowerCase().includes(search))
    : FLAG_OPTIONS

  function toggleFlag(flag: string) {
    setSelected((prev) => (prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag]))
  }

  function confirm() {
    onAdd(appendFlags(value, selected))
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSelected(FLAG_OPTIONS.filter((flag) => value.includes(flag.emoji)).map((flag) => flag.emoji))
          setQuery('')
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Добавить флаги"
          >
            <IconFlag className="size-4" />
          </Button>
        }
      />
      <PopoverContent align="end" sideOffset={6} className="w-64">
        <InputGroup className="h-8">
          <InputGroupAddon align="inline-start">
            <IconSearch />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск: Россия / Russia"
            className="text-xs"
          />
        </InputGroup>
        <div className="grid max-h-52 grid-cols-6 gap-1 overflow-y-auto pr-1">
          {visibleFlags.map(({ emoji, label, en }) => (
            <button
              key={emoji}
              type="button"
              title={`${label} / ${en}`}
              aria-label={label}
              aria-pressed={selected.includes(emoji)}
              onClick={() => toggleFlag(emoji)}
              className={cn(
                'flex size-8 items-center justify-center rounded-md border border-transparent text-base transition-colors active:translate-y-0',
                selected.includes(emoji) ? 'border-primary bg-primary/15' : 'hover:bg-muted'
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
        {visibleFlags.length === 0 && <p className="text-muted-foreground text-xs">Ничего не найдено</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">{selected.length} выбрано</span>
          <Button size="sm" disabled={!selected.length} onClick={confirm}>
            Добавить
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

const X25519_OPTIONS: { value: 'inherit' | 'enable' | 'disable'; label: string }[] = [
  { value: 'enable', label: 'Включить принудительно' },
  { value: 'disable', label: 'Выключить принудительно' },
  { value: 'inherit', label: 'Наследовать от провайдера' },
]

function randomHwid(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => n.toString(16).padStart(2, '0').toUpperCase()).join('')
}

function toYaml(obj: Record<string, any>, indent = 0): string {
  const padding = ' '.repeat(indent)
  return Object.entries(obj).reduce((result, [key, value]) => {
    if (value == null || value === '') return result
    if (Array.isArray(value))
      return value.length ? result + `${padding}${key}:\n` + value.map((item) => `${padding}  - ${item}`).join('\n') + '\n' : result
    if (typeof value === 'object') return result + `${padding}${key}:\n${toYaml(value, indent + 2)}`
    return result + `${padding}${key}: ${value}\n`
  }, '')
}

function highlightYaml(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return `<span style="color:#565f89">${line}</span>`

      const kvMatch = line.match(/^(\s*)(-\s)?([a-zA-Z_][\w.-]*)(\s*:)(.*)?$/)
      if (kvMatch) {
        const [, indent, dash = '', key, colon, rest = ''] = kvMatch
        const marker = dash ? `<span style="color:#89ddff">${dash}</span>` : ''
        return `${indent}${marker}<span style="color:#7aa2f7">${key}</span>${colon}${highlightYamlValue(rest)}`
      }

      const listMatch = line.match(/^(\s*-\s)(.*)$/)
      if (listMatch) {
        const [, marker, rest] = listMatch
        return `<span style="color:#89ddff">${marker}</span>${highlightYamlValue(rest)}`
      }

      return line
    })
    .join('\n')
}

function highlightYamlValue(value: string): string {
  if (!value.trim()) return value
  const trimmed = value.trim()
  const commentIdx = value.search(/\s+#/)
  if (commentIdx !== -1) {
    const main = value.slice(0, commentIdx)
    const comment = value.slice(commentIdx)
    return highlightYamlValue(main) + `<span style="color:#565f89">${comment}</span>`
  }

  if (/^-?\d+\.?\d*$/.test(trimmed)) return value.replace(trimmed, `<span style="color:#ff9e64">${trimmed}</span>`)
  if (/^(true|false|null|~)$/.test(trimmed)) return value.replace(trimmed, `<span style="color:#bb9af7">${trimmed}</span>`)
  if (/^["']/.test(trimmed)) return value.replace(trimmed, `<span style="color:#9ece6a">${trimmed}</span>`)
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return highlightInlineYaml(value)
  if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('*') && !trimmed.startsWith('&'))
    return value.replace(trimmed, `<span style="color:#9ece6a">${trimmed}</span>`)

  return value
}

function highlightInlineYaml(value: string): string {
  let result = ''
  let i = 0
  while (i < value.length) {
    const char = value[i]
    if (char === '"' || char === "'") {
      const quote = char
      let end = i + 1
      while (end < value.length && value[end] !== quote) end++
      result += `<span style="color:#9ece6a">${value.slice(i, Math.min(end + 1, value.length))}</span>`
      i = end + 1
    } else {
      result += /[[\]{}]/.test(char) ? `<span style="color:#89ddff">${char}</span>` : char
      i++
    }
  }
  return result
}

function highlightJson(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([[\]{}])/g, '<span style="color:#89ddff">$1</span>')
    .replace(/"([^"]+)"(\s*:)/g, '<span style="color:#7aa2f7">"$1"</span>$2')
    .replace(/:\s*"([^"]*)"/g, ': <span style="color:#9ece6a">"$1"</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:#ff9e64">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span style="color:#bb9af7">$1</span>')
}

function highlightCode(code: string): string {
  return code.trimStart().startsWith('{') ? highlightJson(code) : highlightYaml(code)
}

const SUPPORTED_PROTOCOLS = ['ss://', 'vless://', 'vmess://', 'hysteria2://', 'hy2://', 'http://', 'https://', 'trojan://']

interface SubscriptionForm {
  name: string
  url: string
  interval: number
  hcEnable: boolean
  hcUrl: string
  hcInterval: number
  hcExpectedStatus: number
  headerEnable: boolean
  userAgent: string
  hwid: string
  filterEnable: boolean
  filter: string
  excludeFilter: string
  excludeType: string
  fingerprint: string
  x25519: 'inherit' | 'enable' | 'disable'
}

function generateSubYaml(form: SubscriptionForm): string {
  const sub: Record<string, any> = {
    type: 'http',
    url: form.url,
    interval: form.interval,
    override: { udp: true },
  }

  const overrideExpr: string[] = []
  if (form.fingerprint) overrideExpr.push(`'.["client-fingerprint"] = "${form.fingerprint}"'`)
  if (form.x25519 !== 'inherit')
    overrideExpr.push(
      `'(select(.type == "vless" and .["reality-opts"] != null) | .["reality-opts"]["support-x25519mlkem768"]) = ${form.x25519 === 'enable'}'`
    )
  if (overrideExpr.length) sub.override['override-expr'] = overrideExpr

  if (form.hcEnable) {
    sub['health-check'] = {
      enable: true,
      url: form.hcUrl,
      interval: form.hcInterval,
      'expected-status': form.hcExpectedStatus,
    }
  }

  if (form.headerEnable) {
    sub.header = {
      'User-Agent': `["${form.userAgent}"]`,
      'x-hwid': `["${form.hwid}"]`,
    }
  }

  if (form.filterEnable) {
    if (form.filter) sub.filter = form.filter
    if (form.excludeFilter) sub['exclude-filter'] = form.excludeFilter
    if (form.excludeType) sub['exclude-type'] = form.excludeType
  }

  return toYaml({ [form.name.trim()]: sub }, 2).trimEnd() + '\n'
}

function createDefaultForm(url: string, existingConfig: string): SubscriptionForm {
  let idx = 1
  while (existingConfig.includes(`subscription_${idx}`)) idx++
  return {
    name: `subscription_${idx}`,
    url,
    interval: 43200,
    hcEnable: true,
    hcUrl: 'https://www.gstatic.com/generate_204',
    hcInterval: 300,
    hcExpectedStatus: 204,
    headerEnable: true,
    userAgent: USER_AGENTS[0],
    hwid: randomHwid(),
    filterEnable: false,
    filter: '',
    excludeFilter: '',
    excludeType: '',
    fingerprint: '',
    x25519: 'enable',
  }
}

interface ReplacePanelProps {
  label: string
  items: string[]
  value: string | null
  onValueChange: (v: string | null) => void
  placeholder: string
  emptyHint: string
  renameRefs: boolean
  onRenameRefsChange: (v: boolean) => void
  description: string | null
  extraHint: string | null
}

function ReplacePanel({
  label,
  items,
  value,
  onValueChange,
  placeholder,
  emptyHint,
  renameRefs,
  onRenameRefsChange,
  description,
  extraHint,
}: ReplacePanelProps) {
  return (
    <section aria-labelledby="replace-title" className="bg-muted/30 flex flex-col gap-4 rounded-lg border p-4">
      <h3 id="replace-title" className="text-sm font-bold tracking-wider uppercase">
        Замена в конфиге
      </h3>
      <Field>
        <FieldLabel>{label}</FieldLabel>
        <Combobox
          items={items}
          value={value}
          itemToStringLabel={(item) => item}
          itemToStringValue={(item) => item}
          onValueChange={onValueChange}
          autoHighlight
        >
          <ComboboxInput fullWidth placeholder={placeholder} disabled={items.length === 0} />
          <ComboboxContent>
            <ComboboxEmpty>Ничего не найдено</ComboboxEmpty>
            <ComboboxList>
              {(item: string) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        {items.length === 0 && <FieldDescription>{emptyHint}</FieldDescription>}
      </Field>

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="replace-rename-refs">Переименовать ссылки во всём конфиге</FieldLabel>
          {description && <FieldDescription>{description}</FieldDescription>}
          {extraHint && <FieldError>{extraHint}</FieldError>}
        </FieldContent>
        <Switch id="replace-rename-refs" checked={renameRefs} onCheckedChange={onRenameRefsChange} />
      </Field>
    </section>
  )
}

interface Props {
  onGenerate: (uri: string, excludeName?: string) => { content: string; type: string } | null
  onAddToConfig: (content: string, type: string, position: 'start' | 'end') => void
  onReplace: (kind: 'proxy' | 'provider', content: string, oldName: string, renameRefs: boolean) => void
}

export function ImportModal({ onGenerate, onAddToConfig, onReplace }: Props) {
  const { showToast, state } = useAppContext({ includeConfigs: true })
  const { modals, dispatch } = useModalContext()
  const [uri, setUri] = useState('')
  const [result, setResult] = useState<{ content: string; type: string; protocol: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [subForm, setSubForm] = useState<SubscriptionForm | null>(null)
  const [subTab, setSubTab] = useState('form')
  const [isCustomUA, setIsCustomUA] = useState(false)
  const [customUA, setCustomUA] = useState('')
  const [resultUri, setResultUri] = useState<string | null>(null)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null)
  const [renameRefs, setRenameRefs] = useState(true)
  const [subDefaultName, setSubDefaultName] = useState<string | null>(null)
  const [providerNameAutoSet, setProviderNameAutoSet] = useState(false)

  const isValidUri = SUPPORTED_PROTOCOLS.some((p) => {
    if (state.currentCore !== 'mihomo' && (p === 'http://' || p === 'https://')) return false
    return uri.toLowerCase().startsWith(p)
  })

  function close() {
    dispatch({ type: 'SHOW_MODAL', modal: 'showImportModal', show: false })
    setTimeout(() => {
      setUri('')
      setResult(null)
      setResultUri(null)
      setSubForm(null)
      setSubDefaultName(null)
      setIsCustomUA(false)
      setCustomUA('')
      setReplaceOpen(false)
      setReplaceTarget(null)
      setRenameRefs(true)
      setProviderNameAutoSet(false)
    }, 300)
  }

  function generate() {
    if (!uri.trim()) return
    const trimmed = uri.trim()
    setReplaceOpen(false)
    setReplaceTarget(null)
    setRenameRefs(true)
    setProviderNameAutoSet(false)

    if (/^https?:\/\//i.test(trimmed)) {
      const existingContent = state.configs.find((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')?.content ?? ''
      const form = createDefaultForm(trimmed, existingContent)
      setSubForm(form)
      setSubDefaultName(form.name)
      setResult({ content: '', type: 'proxy-provider', protocol: 'HTTP' })
      setResultUri(null)
      setSubTab('form')
      return
    }

    try {
      const generated = onGenerate(trimmed)
      if (generated) {
        const protocol = trimmed.match(/^([a-zA-Z0-9+\-.]+):\/\//)?.[1]?.toUpperCase() ?? ''
        setResult({ ...generated, protocol })
        setResultUri(trimmed)
        setSubForm(null)
        setSubDefaultName(null)
      } else {
        setResult(null)
        setResultUri(null)
        setSubForm(null)
        setSubDefaultName(null)
      }
    } catch (e: any) {
      showToast(e.message, 'error')
    }
  }

  function regenerateResult(excludeName?: string) {
    if (!resultUri) return
    try {
      const next = onGenerate(resultUri, excludeName)
      if (next) setResult((prev) => ({ ...next, protocol: prev?.protocol ?? '' }))
    } catch (e: any) {
      showToast(e.message, 'error')
    }
  }

  function toggleReplace() {
    const next = !replaceOpen
    setReplaceOpen(next)
    if (next) return
    if (replaceTarget) {
      setReplaceTarget(null)
      if (isMihomoProxyFlow) regenerateResult()
    }
    if (isMihomoProviderFlow && providerNameAutoSet && subDefaultName) {
      updateSubField('name', subDefaultName)
      setProviderNameAutoSet(false)
    }
  }

  function selectReplaceTarget(target: string | null) {
    setReplaceTarget(target)
    if (isMihomoProxyFlow) {
      regenerateResult(target ?? undefined)
      return
    }
    if (isMihomoProviderFlow && subForm && target && (providerNameAutoSet || subForm.name === subDefaultName)) {
      updateSubField('name', target)
      setProviderNameAutoSet(true)
    }
  }

  function confirmReplace() {
    if (isMihomoProxyFlow) {
      if (!result || !replaceTarget || (renameRefs && !newProxyName)) return
      onReplace('proxy', previewContent, replaceTarget, renameRefs)
      close()
      return
    }
    if (isMihomoProviderFlow) {
      if (!subForm || !replaceTarget || providerReplaceDisabled) return
      onReplace('provider', finalProviderContent, replaceTarget, renameRefs)
      close()
    }
  }

  function updateSubField<K extends keyof SubscriptionForm>(key: K, value: SubscriptionForm[K]) {
    setSubForm((prev) => (prev ? { ...prev, [key]: value } : null))
  }

  function regenerateHwid() {
    updateSubField('hwid', randomHwid())
  }

  function addSubToConfig(position: 'start' | 'end') {
    if (!subForm) return
    const content = generateSubYaml(subForm)
    onAddToConfig(content, 'proxy-provider', position)
    close()
  }

  async function copySub() {
    if (!subForm) return
    const ok = await copyText(finalProviderContent)
    if (!ok) {
      showToast('Ошибка копирования', 'error')
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function copy() {
    if (!result) return
    const ok = await copyText(result.content)
    if (!ok) {
      showToast('Ошибка копирования', 'error')
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function addToConfig(position: 'start' | 'end') {
    if (!result) return
    onAddToConfig(result.content, result.type, position)
    close()
  }

  const showSubForm = subForm && result
  const isMihomoProxyFlow = state.currentCore === 'mihomo' && result?.type === 'proxy'
  const isMihomoProviderFlow = state.currentCore === 'mihomo' && Boolean(showSubForm)
  const configYamlContent = state.configs.find((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')?.content ?? ''
  const mihomoProxies = useMemo(
    () => (isMihomoProxyFlow ? listMihomoProxies(configYamlContent) : []),
    [isMihomoProxyFlow, configYamlContent]
  )
  const providerNames = useMemo(
    () => (isMihomoProviderFlow ? listMihomoProviders(configYamlContent) : []),
    [isMihomoProviderFlow, configYamlContent]
  )
  const newProxyName = result ? proxyItemName(result.content) : null
  const previewContent =
    result && replaceTarget ? (renameRefs ? result.content : withProxyName(result.content, replaceTarget)) : (result?.content ?? '')

  const providerEntry = isMihomoProviderFlow && subForm ? generateSubYaml(subForm) : ''
  const newProviderName = providerEntry ? providerEntryName(providerEntry) : null
  const finalProviderContent =
    providerEntry && replaceTarget ? (renameRefs ? providerEntry : withProviderName(providerEntry, replaceTarget)) : providerEntry
  const trimmedSubName = subForm?.name.trim() ?? ''
  const providerNameConflict = Boolean(
    isMihomoProviderFlow &&
    renameRefs &&
    replaceTarget !== null &&
    subForm !== null &&
    trimmedSubName !== replaceTarget &&
    providerNames.includes(trimmedSubName)
  )
  const providerReplaceDisabled = !replaceTarget || newProviderName === null || providerNameConflict || !trimmedSubName

  const replaceConfirmDisabled = isMihomoProxyFlow ? !replaceTarget || (renameRefs && !newProxyName) : providerReplaceDisabled

  function clearUri() {
    setUri('')
    setResult(null)
    setResultUri(null)
    setSubForm(null)
    setSubDefaultName(null)
    setReplaceOpen(false)
    setReplaceTarget(null)
    setRenameRefs(true)
    setProviderNameAutoSet(false)
  }

  const copyButton = (
    <Button variant="ghost" size="sm" onClick={subForm ? copySub : copy}>
      {copied ? <IconCheck data-icon="inline-start" className="text-emerald-500" /> : <IconCopy data-icon="inline-start" />}
      {copied ? 'Скопировано' : 'Копировать'}
    </Button>
  )

  return (
    <TooltipProvider delayDuration={500}>
      <Dialog open={modals.showImportModal} onOpenChange={(open) => !open && close()}>
        <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
          <DialogHeader className="border-b px-5 py-4 pr-14">
            <DialogTitle className="text-[15px] font-bold tracking-wider uppercase">Добавить подключение</DialogTitle>
            <DialogDescription>
              {state.currentCore === 'mihomo'
                ? 'Вставьте ссылку на сервер или адрес подписки — получится готовый блок для конфига'
                : 'Вставьте ссылку на сервер — получится готовый outbound для конфига'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
            <Field data-invalid={(!!uri.trim() && !isValidUri) || undefined}>
              <FieldLabel htmlFor="import-uri">Ссылка</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="import-uri"
                  value={uri}
                  onChange={(e) => setUri(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && isValidUri && generate()}
                  placeholder={state.currentCore === 'mihomo' ? 'vless://… или https://…' : 'vless://…'}
                  aria-invalid={(!!uri.trim() && !isValidUri) || undefined}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  className="font-mono text-[13px]"
                />
                <InputGroupAddon align="inline-end" className="gap-0.5">
                  {uri && (
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="Очистить"
                      onClick={clearUri}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <ClearIcon size={13} />
                    </InputGroupButton>
                  )}
                  {result && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <InputGroupButton size="icon-xs" aria-label="Сгенерировать заново" onClick={generate} disabled={!isValidUri}>
                            <IconRefresh />
                          </InputGroupButton>
                        }
                      />
                      <TooltipContent side="top">Сгенерировать заново</TooltipContent>
                    </Tooltip>
                  )}
                </InputGroupAddon>
              </InputGroup>
              {uri.trim() && !isValidUri ? (
                <FieldError>Ссылка не поддерживается</FieldError>
              ) : (
                <FieldDescription>
                  Поддерживаются vless, vmess, trojan, ss, hysteria2{state.currentCore === 'mihomo' && ', http(s)-подписки'}
                </FieldDescription>
              )}
            </Field>

            {showSubForm && (
              <Tabs value={subTab} onValueChange={setSubTab} className="gap-4">
                <div className="flex items-center justify-between gap-2">
                  <TabsList>
                    <TabsTrigger value="form">Настройки</TabsTrigger>
                    <TabsTrigger value="raw">YAML</TabsTrigger>
                  </TabsList>
                  {copyButton}
                </div>

                <TabsContent value="form" className="flex flex-col divide-y rounded-lg border">
                  <section className="flex flex-col gap-4 p-4">
                    <h3 className="text-sm font-bold tracking-wider uppercase">Подписка</h3>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="sub-name">Название провайдера</FieldLabel>
                        <Input
                          id="sub-name"
                          value={subForm.name}
                          onChange={(e) => {
                            updateSubField('name', e.target.value)
                            setProviderNameAutoSet(false)
                          }}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="sub-interval">Интервал обновления</FieldLabel>
                        <InputGroup>
                          <InputGroupInput
                            id="sub-interval"
                            type="number"
                            min={60}
                            inputMode="numeric"
                            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            value={subForm.interval}
                            onChange={(e) => updateSubField('interval', +e.target.value)}
                          />
                          <InputGroupAddon align="inline-end">
                            <InputGroupText>сек</InputGroupText>
                          </InputGroupAddon>
                        </InputGroup>
                      </Field>
                    </div>

                    <Field>
                      <FieldLabel htmlFor="sub-url">URL подписки</FieldLabel>
                      <Input
                        id="sub-url"
                        value={subForm.url}
                        onChange={(e) => updateSubField('url', e.target.value)}
                        spellCheck={false}
                        className="font-mono text-[13px]"
                      />
                    </Field>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="sub-fingerprint">Client Fingerprint *</FieldLabel>
                        <Select
                          value={subForm.fingerprint || '__inherit__'}
                          items={{
                            __inherit__: 'Как у провайдера',
                            ...Object.fromEntries(CLIENT_FINGERPRINTS.map((fp) => [fp, fp])),
                          }}
                          onValueChange={(v) => updateSubField('fingerprint', v === '__inherit__' ? '' : v)}
                        >
                          <SelectTrigger id="sub-fingerprint" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="__inherit__">Как у провайдера</SelectItem>
                              {CLIENT_FINGERPRINTS.map((fp) => (
                                <SelectItem key={fp} value={fp}>
                                  {fp}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <div className="flex items-center gap-1">
                          <FieldLabel htmlFor="sub-x25519">X25519MLKEM768 *</FieldLabel>
                          <Tooltip>
                            <TooltipTrigger
                              render={<span className="text-muted-foreground inline-flex cursor-help" />}
                              aria-label="Подробнее: X25519MLKEM768"
                            >
                              <IconInfoCircle className="size-4" />
                            </TooltipTrigger>
                            <TooltipContent side="top" sideOffset={8} className="max-w-xs">
                              Принудительное включение X25519MLKEM768 работает не со всеми вариантами client-fingerprint. В остальных
                              случаях оно не даст эффекта.
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        <Select
                          value={subForm.x25519}
                          items={Object.fromEntries(X25519_OPTIONS.map((opt) => [opt.value, opt.label]))}
                          onValueChange={(v) => updateSubField('x25519', v as SubscriptionForm['x25519'])}
                        >
                          <SelectTrigger id="sub-x25519" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {X25519_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                    <FieldDescription>* Нужен Mihomo v1.19.29 или новее</FieldDescription>
                  </section>

                  <section className="flex flex-col gap-4 p-4">
                    <SectionHeading
                      id="sub-hc"
                      title="Проверка работоспособности"
                      checked={subForm.hcEnable}
                      onCheckedChange={(v) => updateSubField('hcEnable', v)}
                    />
                    {subForm.hcEnable && (
                      <>
                        <Field>
                          <FieldLabel htmlFor="sub-hc-url">URL проверки</FieldLabel>
                          <Input
                            id="sub-hc-url"
                            value={subForm.hcUrl}
                            onChange={(e) => updateSubField('hcUrl', e.target.value)}
                            spellCheck={false}
                            className="font-mono text-[13px]"
                          />
                        </Field>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <Field>
                            <FieldLabel htmlFor="sub-hc-interval">Интервал проверок</FieldLabel>
                            <InputGroup>
                              <InputGroupInput
                                id="sub-hc-interval"
                                type="number"
                                min={30}
                                inputMode="numeric"
                                className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                value={subForm.hcInterval}
                                onChange={(e) => updateSubField('hcInterval', +e.target.value)}
                              />
                              <InputGroupAddon align="inline-end">
                                <InputGroupText>сек</InputGroupText>
                              </InputGroupAddon>
                            </InputGroup>
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="sub-hc-status">Ожидаемый код ответа</FieldLabel>
                            <Input
                              id="sub-hc-status"
                              type="number"
                              min={100}
                              max={599}
                              inputMode="numeric"
                              className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                              value={subForm.hcExpectedStatus}
                              onChange={(e) => updateSubField('hcExpectedStatus', +e.target.value)}
                            />
                          </Field>
                        </div>
                      </>
                    )}
                  </section>

                  <section className="flex flex-col gap-4 p-4">
                    <SectionHeading
                      id="sub-headers"
                      title="Заголовки запроса"
                      checked={subForm.headerEnable}
                      onCheckedChange={(v) => updateSubField('headerEnable', v)}
                    />
                    {subForm.headerEnable && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field>
                          <FieldLabel htmlFor="sub-ua">User-Agent</FieldLabel>
                          <Select
                            value={isCustomUA ? '__custom__' : subForm.userAgent}
                            onValueChange={(v) => {
                              if (v === '__custom__') {
                                setIsCustomUA(true)
                                updateSubField('userAgent', customUA || '')
                              } else {
                                setIsCustomUA(false)
                                updateSubField('userAgent', v)
                              }
                            }}
                          >
                            <SelectTrigger id="sub-ua" className="w-full min-w-0">
                              {isCustomUA ? <span className="text-muted-foreground">Свой User-Agent</span> : <SelectValue />}
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {USER_AGENTS.map((ua) => (
                                  <SelectItem key={ua} value={ua}>
                                    {ua}
                                  </SelectItem>
                                ))}
                                <SelectItem value="__custom__">
                                  <span className="text-muted-foreground">Свой User-Agent</span>
                                </SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          {isCustomUA && (
                            <Input
                              value={customUA}
                              onChange={(e) => {
                                setCustomUA(e.target.value)
                                updateSubField('userAgent', e.target.value)
                              }}
                              placeholder="Введите User-Agent"
                              aria-label="Свой User-Agent"
                            />
                          )}
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="sub-hwid">x-hwid</FieldLabel>
                          <InputGroup>
                            <InputGroupInput
                              id="sub-hwid"
                              value={subForm.hwid}
                              onChange={(e) => updateSubField('hwid', e.target.value)}
                              spellCheck={false}
                              className="font-mono text-[13px]"
                            />
                            <InputGroupAddon align="inline-end">
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <InputGroupButton size="icon-xs" aria-label="Сгенерировать новый x-hwid" onClick={regenerateHwid}>
                                      <IconRefresh />
                                    </InputGroupButton>
                                  }
                                />
                                <TooltipContent side="top">Сгенерировать новый</TooltipContent>
                              </Tooltip>
                            </InputGroupAddon>
                          </InputGroup>
                        </Field>
                      </div>
                    )}
                  </section>

                  <section className="flex flex-col gap-4 p-4">
                    <SectionHeading
                      id="sub-filter"
                      title="Фильтр подключений"
                      checked={subForm.filterEnable}
                      onCheckedChange={(v) => updateSubField('filterEnable', v)}
                    />
                    {subForm.filterEnable && (
                      <>
                        <Field>
                          <FieldLabel htmlFor="sub-filter-include">Включить по названию</FieldLabel>
                          <InputGroup>
                            <InputGroupInput
                              id="sub-filter-include"
                              value={subForm.filter}
                              onChange={(e) => updateSubField('filter', e.target.value)}
                              placeholder="my-good-proxy"
                              spellCheck={false}
                            />
                            <InputGroupAddon align="inline-end" className="gap-1">
                              <InputGroupText className="text-xs">regex</InputGroupText>
                              <FlagPicker value={subForm.filter} onAdd={(next) => updateSubField('filter', next)} />
                            </InputGroupAddon>
                          </InputGroup>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="sub-filter-exclude">Исключить по названию</FieldLabel>
                          <InputGroup>
                            <InputGroupInput
                              id="sub-filter-exclude"
                              value={subForm.excludeFilter}
                              onChange={(e) => updateSubField('excludeFilter', e.target.value)}
                              placeholder="my-bad-proxy"
                              spellCheck={false}
                            />
                            <InputGroupAddon align="inline-end" className="gap-1">
                              <InputGroupText className="text-xs">regex</InputGroupText>
                              <FlagPicker value={subForm.excludeFilter} onAdd={(next) => updateSubField('excludeFilter', next)} />
                            </InputGroupAddon>
                          </InputGroup>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="sub-filter-type">Исключить по типу</FieldLabel>
                          <Input
                            id="sub-filter-type"
                            value={subForm.excludeType}
                            onChange={(e) => updateSubField('excludeType', e.target.value)}
                            placeholder="trojan|vmess"
                            spellCheck={false}
                          />
                        </Field>
                      </>
                    )}
                  </section>
                </TabsContent>

                <TabsContent value="raw">
                  <CodePreview code={subForm ? finalProviderContent : ''} />
                </TabsContent>
              </Tabs>
            )}

            {result && !subForm && (
              <section aria-label="Результат" className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold tracking-wider uppercase">Результат</h3>
                    {result.protocol && <Badge variant="sky">{result.protocol}</Badge>}
                  </div>
                  {copyButton}
                </div>
                <CodePreview code={previewContent} />
              </section>
            )}

            {isMihomoProviderFlow && replaceOpen && (
              <ReplacePanel
                label="Провайдер для замены"
                items={providerNames}
                value={replaceTarget}
                onValueChange={selectReplaceTarget}
                placeholder="Выберите провайдера"
                emptyHint="В конфиге нет раздела proxy-providers"
                renameRefs={renameRefs}
                onRenameRefsChange={setRenameRefs}
                description={
                  replaceTarget
                    ? renameRefs
                      ? newProviderName
                        ? `Ссылки на «${replaceTarget}» в proxy-groups (use) станут «${newProviderName}»`
                        : null
                      : `Новый провайдер получит имя «${replaceTarget}», ссылки не изменятся`
                    : null
                }
                extraHint={
                  replaceTarget
                    ? newProviderName === null
                      ? 'Не удалось определить имя провайдера'
                      : providerNameConflict
                        ? `Имя «${trimmedSubName}» уже используется`
                        : null
                    : null
                }
              />
            )}

            {isMihomoProxyFlow && replaceOpen && (
              <ReplacePanel
                label="Прокси для замены"
                items={mihomoProxies}
                value={replaceTarget}
                onValueChange={selectReplaceTarget}
                placeholder="Выберите прокси"
                emptyHint="В конфиге нет раздела proxies"
                renameRefs={renameRefs}
                onRenameRefsChange={setRenameRefs}
                description={
                  replaceTarget
                    ? renameRefs
                      ? newProxyName
                        ? `Ссылки на «${replaceTarget}» в группах, правилах, dialer-proxy и DNS станут «${newProxyName}»`
                        : 'Не удалось определить имя нового прокси'
                      : `Новый прокси получит имя «${replaceTarget}», ссылки не изменятся`
                    : null
                }
                extraHint={null}
              />
            )}
          </div>

          <DialogFooter className="border-t px-5 py-3">
            {!result ? (
              <>
                <Button variant="outline" onClick={close}>
                  Отмена
                </Button>
                <Button onClick={generate} disabled={!isValidUri}>
                  Сгенерировать
                </Button>
              </>
            ) : replaceOpen ? (
              <>
                <Button variant="outline" onClick={toggleReplace}>
                  Отмена
                </Button>
                <Button onClick={confirmReplace} disabled={replaceConfirmDisabled}>
                  <IconReplace data-icon="inline-start" />
                  Заменить
                </Button>
              </>
            ) : (
              <>
                {(isMihomoProxyFlow || isMihomoProviderFlow) && (
                  <Button variant="ghost" className="sm:mr-auto" onClick={toggleReplace}>
                    <IconReplace data-icon="inline-start" />
                    Заменить существующий
                  </Button>
                )}
                <Button variant="outline" onClick={() => (subForm ? addSubToConfig('start') : addToConfig('start'))}>
                  <IconPlus data-icon="inline-start" />В начало
                </Button>
                <Button onClick={() => (subForm ? addSubToConfig('end') : addToConfig('end'))}>
                  <IconPlus data-icon="inline-start" />В конец конфига
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

function SectionHeading({
  id,
  title,
  checked,
  onCheckedChange,
}: {
  id: string
  title: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="cursor-pointer text-sm font-bold tracking-wider uppercase">
        {title}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function CodePreview({ code }: { code: string }) {
  return (
    <pre
      className="bg-input-background m-0 max-h-[50dvh] overflow-auto rounded-lg border p-4 font-mono text-[13px]"
      dangerouslySetInnerHTML={{ __html: highlightCode(code) }}
    />
  )
}
