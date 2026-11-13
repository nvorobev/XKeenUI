import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { IconChevronDown } from '@tabler/icons-react'
import { useState } from 'react'
import { checkIntervalSecs, type Settings } from './model'

type NumberKey = 'interval_secs' | 'failure_threshold' | 'timeout_ms'
const numberFields: { key: NumberKey; label: string; min: number; max: number; hint: string }[] = [
  {
    key: 'interval_secs',
    label: 'Интервал проверки, с',
    min: 1,
    max: 3600,
    hint: 'Пауза после завершения проверки, от 1 с. Проверки не накладываются друг на друга.',
  },
  {
    key: 'failure_threshold',
    label: 'Отказов подряд',
    min: 1,
    max: 10,
    hint: 'Сколько неудачных проверок подряд нужно, чтобы уйти с текущего сервера.',
  },
  { key: 'timeout_ms', label: 'Таймаут, мс', min: 500, max: 30000, hint: 'Сколько ждать ответа; дольше — считается отказом.' },
]

export function FailoverSettings({
  draft,
  disabled,
  error,
  onChange,
}: {
  draft: Settings
  disabled: boolean
  error: string
  onChange: (next: Settings) => void
}) {
  const [open, setOpen] = useState(false)
  const summary = draft.auto
    ? `каждые ${checkIntervalSecs(draft)} с · ${draft.failure_threshold} отказа · ${draft.timeout_ms} мс`
    : 'выключено — сервер меняется только вручную'
  return (
    <Collapsible open={open || !!error} onOpenChange={setOpen} className="rounded-xl border">
      <div className="flex items-center gap-3 p-3">
        <Switch
          id="xray-auto"
          checked={draft.auto}
          disabled={disabled}
          onCheckedChange={(auto) => onChange({ ...draft, auto })}
          aria-label="Автопереключение при отказе"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <label htmlFor="xray-auto" className="text-sm font-medium">
            Автопереключение при отказе
          </label>
          <span className="text-muted-foreground text-xs">{summary}</span>
        </div>
        <CollapsibleTrigger
          render={
            <Button variant="ghost" size="sm" aria-label="Параметры проверки">
              <span className="hidden sm:inline">Параметры</span>
              <IconChevronDown
                data-icon="inline-end"
                className={open || error ? 'rotate-180 transition-transform' : 'transition-transform'}
              />
            </Button>
          }
        />
      </div>
      <CollapsibleContent className="border-t p-3">
        <FieldGroup>
          <p className="text-muted-foreground text-sm">
            Пока текущий сервер отвечает, он сохраняется, даже если другой быстрее. После подтверждённого отказа панель переключится на
            самый быстрый доступный сервер из пула.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {numberFields.map((field) => (
              <Field key={field.key}>
                <FieldLabel htmlFor={`xray-${field.key}`}>{field.label}</FieldLabel>
                <Input
                  id={`xray-${field.key}`}
                  type="number"
                  inputMode="numeric"
                  min={field.min}
                  max={field.max}
                  value={
                    Number.isNaN(field.key === 'interval_secs' ? checkIntervalSecs(draft) : draft[field.key])
                      ? ''
                      : field.key === 'interval_secs'
                        ? checkIntervalSecs(draft)
                        : draft[field.key]
                  }
                  disabled={disabled}
                  onChange={(e) => {
                    const value = e.target.value === '' ? NaN : Number(e.target.value)
                    // The interval is shown in seconds; the backend keeps it in milliseconds.
                    onChange(
                      field.key === 'interval_secs'
                        ? { ...draft, interval_secs: value, interval_ms: value * 1000 }
                        : { ...draft, [field.key]: value }
                    )
                  }}
                />
                <FieldDescription>{field.hint}</FieldDescription>
              </Field>
            ))}
          </div>
          <Field>
            <FieldLabel htmlFor="xray-probe-url">URL проверки</FieldLabel>
            <Input
              id="xray-probe-url"
              type="url"
              value={draft.probe_url}
              disabled={disabled}
              onChange={(e) => onChange({ ...draft, probe_url: e.target.value })}
            />
            <FieldDescription>Адрес, который открывается через каждый сервер для проверки.</FieldDescription>
          </Field>
          {error && <FieldDescription className="text-destructive">{error}</FieldDescription>}
        </FieldGroup>
      </CollapsibleContent>
    </Collapsible>
  )
}
