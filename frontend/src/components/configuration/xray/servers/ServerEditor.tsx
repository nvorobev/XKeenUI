import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useMemo, useRef, useState } from 'react'
import { ProviderEditor } from '../../editor/ProviderEditor'
import { endpoint, extractMeta } from '../outboundMeta'
import { errorText, jsonToOutbound, linkToOutbound, type Outbound, type Server } from './model'

export type EditorTarget = { id: string; name: string; outbound: Outbound | null }
type Mode = 'link' | 'json'

export function ServerEditor({
  target,
  servers,
  isActive,
  onSave,
  onClose,
}: {
  target: EditorTarget
  servers: Server[]
  isActive: boolean
  onSave: (server: Server) => Promise<void>
  onClose: () => void
}) {
  const isNew = target.outbound === null
  const [mode, setMode] = useState<Mode>(isNew ? 'link' : 'json')
  const [name, setName] = useState(target.name)
  const [link, setLink] = useState('')
  const [json, setJson] = useState(target.outbound ? JSON.stringify(target.outbound, null, 2) : '')
  const [jsonError, setJsonError] = useState<string>()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const others = useMemo(() => servers.filter((s) => s.id !== target.id), [servers, target.id])

  const parsed = useMemo((): { outbound?: Outbound; error?: string } => {
    const text = mode === 'link' ? link.trim() : json.trim()
    if (!text) return {}
    try {
      return { outbound: mode === 'link' ? linkToOutbound(text, others) : jsonToOutbound(text) }
    } catch (reason) {
      return { error: errorText(reason, 'Не удалось разобрать сервер') }
    }
  }, [mode, link, json, others])

  function switchMode(next: Mode) {
    // Carry a pasted link over to the JSON editor so it can be fine-tuned.
    if (next === 'json' && parsed.outbound) setJson(JSON.stringify(parsed.outbound, null, 2))
    setMode(next)
    setError('')
  }

  async function save() {
    if (savingRef.current) return
    if (!parsed.outbound) return setError(parsed.error ?? 'Вставьте ссылку или JSON outbound')
    if (mode === 'json' && jsonError) return setError(jsonError)
    const tag = typeof parsed.outbound.tag === 'string' ? parsed.outbound.tag : ''
    const serverName = name.trim() || tag
    if (!serverName) return setError('Укажите название сервера')
    if (Array.from(serverName).length > 100) return setError('Название — до 100 символов')
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      await onSave({ id: target.id, name: serverName, outbound: parsed.outbound })
    } catch (reason) {
      setError(errorText(reason, 'Не удалось сохранить сервер'))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const meta = parsed.outbound ? extractMeta(parsed.outbound) : null
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !savingRef.current) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!saving}
        className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <DialogHeader className="border-b px-5 py-4 pr-14">
          <DialogTitle className="truncate text-[15px] font-bold tracking-wider uppercase">
            {isNew ? (
              'Новый сервер'
            ) : (
              <>
                Конфиг сервера <span className="normal-case">«{target.name}»</span>
              </>
            )}
          </DialogTitle>
          <DialogDescription>Вставьте ссылку подключения или отредактируйте JSON одного Xray outbound.</DialogDescription>
        </DialogHeader>
        <FieldGroup className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Field>
            <FieldLabel htmlFor="xray-server-name">Название</FieldLabel>
            <Input
              id="xray-server-name"
              value={name}
              maxLength={100}
              placeholder={typeof parsed.outbound?.tag === 'string' ? parsed.outbound.tag : 'Например, Нидерланды'}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Tabs value={mode} onValueChange={(value) => switchMode(value as Mode)}>
            <TabsList>
              <TabsTrigger value="link">Ссылка</TabsTrigger>
              <TabsTrigger value="json">JSON</TabsTrigger>
            </TabsList>
            <TabsContent value="link">
              <Field>
                <FieldLabel htmlFor="xray-server-link" className="sr-only">
                  Ссылка подключения
                </FieldLabel>
                <Textarea
                  id="xray-server-link"
                  rows={4}
                  className="font-mono"
                  placeholder="vless://… · vmess://… · trojan://… · ss://… · hysteria2://…"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                />
              </Field>
            </TabsContent>
            <TabsContent value="json">
              <div className="bg-input-background relative h-[50dvh] overflow-hidden rounded-xl border md:h-[40dvh]">
                <ProviderEditor
                  content={json}
                  language="json"
                  lineWrap={false}
                  onChange={setJson}
                  onSave={save}
                  onValidationChange={setJsonError}
                />
              </div>
            </TabsContent>
          </Tabs>
          {meta && (
            <div className="bg-muted/40 flex flex-wrap items-center gap-1.5 rounded-lg p-3 text-sm">
              <Badge variant="sky">{meta.protocolLabel ?? meta.protocol}</Badge>
              <Badge variant="outline">{endpoint(meta)}</Badge>
              <Badge variant="outline">{meta.network ?? 'tcp'}</Badge>
              {meta.security && meta.security !== 'none' && <Badge variant="outline">{meta.security}</Badge>}
              {meta.sni && <Badge variant="outline">SNI {meta.sni}</Badge>}
              {meta.flow && <Badge variant="outline">{meta.flow}</Badge>}
            </div>
          )}
          {(error || parsed.error) && <FieldDescription className="text-destructive">{error || parsed.error}</FieldDescription>}
          {isActive && (
            <Alert>
              <AlertDescription>
                Это активный сервер. Перед применением панель проверит, что новый конфиг отвечает, затем перезапустит Xray — открытые
                соединения прервутся.
              </AlertDescription>
            </Alert>
          )}
        </FieldGroup>
        <DialogFooter className="flex-col gap-3 border-t px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-xs">
            Сервер сразу сохранится на роутере. Изменения сервера в работающем пуле применяются отдельно.
          </p>
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="outline" disabled={saving} onClick={onClose}>
              Отмена
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              {saving && <Spinner data-icon="inline-start" />}
              {isNew ? 'Добавить сервер' : 'Сохранить'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
