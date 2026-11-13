import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { parse as parseJsonc } from 'jsonc-parser'
import { useCallback, useState } from 'react'
import { apiCall } from '../../../lib/api'
import { softRestartAfterSave } from '../../../lib/soft-restart'
import { useAppActions, useCoreRuntimeState, useSettings } from '../../../lib/store'
import type { Config } from '../../../lib/types'
import { cn } from '../../../lib/utils'
import type { CodeMirrorRef } from '../CodeMirror'

const LOG_LEVELS = ['none', 'error', 'warning', 'info', 'debug'] as const
type LogLevel = (typeof LOG_LEVELS)[number]

const LEVEL_DESCRIPTION: Record<LogLevel, string> = {
  none: 'Журнал отключён',
  error: 'Только ошибки',
  warning: 'Ошибки и предупреждения',
  info: 'Подробные сведения о работе',
  debug: 'Максимально подробно, для отладки',
}

const ACCESS_PATH = '/opt/var/log/xray/access.log'
const ERROR_PATH = '/opt/var/log/xray/error.log'

interface LogConfig {
  access: string
  error: string
  loglevel: LogLevel
  dnsLog: boolean
}

function parseLogConfig(content: string): LogConfig | null {
  try {
    const json = parseJsonc(content)
    if (!json?.log) return null
    return {
      access: json.log.access ?? '',
      error: json.log.error ?? '',
      loglevel: (LOG_LEVELS.includes(json.log.loglevel) ? json.log.loglevel : 'warning') as LogLevel,
      dnsLog: json.log.dnsLog ?? false,
    }
  } catch {
    return null
  }
}

interface Props {
  editorRef: React.RefObject<CodeMirrorRef | null>
  configs: Config[]
  activeConfigIndex: number
}

export function GuiLog({ editorRef, configs, activeConfigIndex }: Props) {
  const { showToast, dispatch } = useAppActions()
  const { serviceStatus, currentCore } = useCoreRuntimeState()
  const autoApply = useSettings((s) => s.autoApply)
  const [cfg, setCfg] = useState<LogConfig>(() => {
    const content = configs[activeConfigIndex]?.content ?? ''
    return (
      parseLogConfig(content) ?? {
        access: '',
        error: '',
        loglevel: 'warning',
        dnsLog: false,
      }
    )
  })

  const [prevIndex, setPrevIndex] = useState(activeConfigIndex)
  if (prevIndex !== activeConfigIndex) {
    setPrevIndex(activeConfigIndex)
    const content = configs[activeConfigIndex]?.content ?? ''
    const parsed = parseLogConfig(content)
    if (parsed) setCfg(parsed)
  }

  const syncToEditor = useCallback(
    async (newCfg: LogConfig, triggerRestart = false) => {
      const wrapper = editorRef.current
      if (!wrapper) return
      try {
        const json = parseJsonc(wrapper.getValue())
        json.log = {
          access: newCfg.access || 'none',
          error: newCfg.error || 'none',
          loglevel: newCfg.loglevel,
          dnsLog: newCfg.dnsLog,
        }
        let text = JSON.stringify(json, null, 2)
        try {
          const [prettier, prettierBabel] = await Promise.all([import('prettier'), import('prettier/plugins/babel')])
          const formatted = await prettier.format(text, {
            parser: 'json',
            plugins: [prettierBabel],
            semi: false,
            trailingComma: 'none',
            printWidth: 120,
            endOfLine: 'lf',
          })
          text = formatted
            .replace(/\n{3,}/g, '\n\n')
            .replace(/\s+$/gm, '')
            .replace(/\n$/, '')
        } catch {
          /* */
        }
        wrapper.replaceAll(text)

        if (triggerRestart && autoApply && serviceStatus === 'running') {
          const activeConfig = configs[activeConfigIndex]
          if (activeConfig) {
            const content = wrapper.getValue()
            const saved = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs', { file: activeConfig.file, content })
            if (!saved?.success) throw new Error(saved?.error || 'Не удалось сохранить конфигурацию')
            dispatch({
              type: 'SAVE_CONFIG',
              index: activeConfigIndex,
              content,
            })
            await softRestartAfterSave(currentCore, dispatch, showToast)
          }
        }
      } catch (e: any) {
        showToast(`Ошибка синхронизации: ${e.message}`, 'error')
      }
    },
    [editorRef, showToast, autoApply, serviceStatus, currentCore, configs, activeConfigIndex, dispatch]
  )

  function update(partial: Partial<LogConfig>, triggerRestart = false) {
    const next = { ...cfg, ...partial }
    setCfg(next)
    syncToEditor(next, triggerRestart)
  }

  const accessEnabled = !!cfg.access && cfg.access !== 'none'
  const errorEnabled = !!cfg.error && cfg.error !== 'none'

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="divide-y">
        <SettingRow
          id="gui-log-access"
          title="Журнал доступа"
          description={accessEnabled ? cfg.access : 'Не записывается'}
          descriptionClassName={accessEnabled ? 'font-mono text-xs' : undefined}
        >
          <Switch id="gui-log-access" checked={accessEnabled} onCheckedChange={(v) => update({ access: v ? ACCESS_PATH : 'none' }, true)} />
        </SettingRow>
        <SettingRow
          id="gui-log-error"
          title="Журнал ошибок"
          description={errorEnabled ? cfg.error : 'Не записывается'}
          descriptionClassName={errorEnabled ? 'font-mono text-xs' : undefined}
        >
          <Switch id="gui-log-error" checked={errorEnabled} onCheckedChange={(v) => update({ error: v ? ERROR_PATH : 'none' }, true)} />
        </SettingRow>
        <SettingRow id="gui-log-level" title="Уровень журнала" description={LEVEL_DESCRIPTION[cfg.loglevel]}>
          <Select
            value={cfg.loglevel}
            items={Object.fromEntries(LOG_LEVELS.map((l) => [l, l]))}
            onValueChange={(value) => value && update({ loglevel: value as LogLevel }, true)}
          >
            <SelectTrigger id="gui-log-level" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {LOG_LEVELS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow id="gui-log-dns" title="Журнал DNS" description="Записывать DNS-запросы в журнал доступа">
          <Switch id="gui-log-dns" checked={cfg.dnsLog} onCheckedChange={(v) => update({ dnsLog: v }, true)} />
        </SettingRow>
      </div>
    </div>
  )
}

function SettingRow({
  id,
  title,
  description,
  descriptionClassName,
  children,
}: {
  id: string
  title: string
  description: string
  descriptionClassName?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          {title}
        </label>
        <span className={cn('text-muted-foreground truncate text-sm', descriptionClassName)}>{description}</span>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
