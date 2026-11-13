// Types and pure helpers of the Xray server pool dialog.
export type Outbound = Record<string, unknown>
export type Server = { id: string; name: string; outbound: Outbound }
export type Settings = {
  target_tag: string
  servers: Server[]
  selected_id: string
  auto: boolean
  interval_secs: number
  interval_ms?: number
  failure_threshold: number
  probe_url: string
  timeout_ms: number
}
export type Probe = { id: string; latency_ms: number | null; error: string | null }
export type Snapshot = {
  success: boolean
  error: string | null
  settings: Settings | null
  servers: Server[]
  active_id?: string | null
  active_since?: string | null
  probes: Probe[]
  failures: number
  ready: boolean
  managed_present: boolean
  last_check: string | null
  last_switch: string | null
}
export type Candidates = {
  success: boolean
  error?: string
  outbounds?: Outbound[]
  default_tag?: string | null
  routed_tags?: string[]
}
export type Reply = { success: boolean; error?: string }
export type DraftStatus = 'new' | 'changed' | null
export type Health = 'ok' | 'failing' | 'down' | 'unknown'

export const MAX_SERVERS = 32
export const defaults: Settings = {
  target_tag: '',
  servers: [],
  selected_id: '',
  auto: false,
  interval_secs: 60,
  interval_ms: 60000,
  failure_threshold: 3,
  probe_url: 'https://yahoo.com',
  timeout_ms: 5000,
}

/** Saved server edits survive reload; pool membership and switching settings stay separate. */
export function draftFromSnapshot(snapshot: Snapshot | null): Settings {
  if (!snapshot?.settings) return defaults
  return {
    ...snapshot.settings,
    servers: snapshot.settings.servers.map((server) => snapshot.servers.find((s) => s.id === server.id) ?? server),
  }
}

export function newServerId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function asOutbound(value: unknown): Outbound {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Нужен JSON одного outbound')
  const outbound = value as Outbound
  if (typeof outbound.protocol !== 'string' || !outbound.protocol)
    throw new Error('В JSON нет protocol; вставьте один outbound, а не полный конфиг')
  return outbound
}

/** Converts a share link with the app-wide generator (loaded by the config panel). */
export function linkToOutbound(link: string, servers: Server[]): Outbound {
  const generator = (
    window as unknown as {
      generateConfigForCore?: (uri: string, core: string, config: string) => { content: string }
    }
  ).generateConfigForCore
  if (!generator) throw new Error('Генератор ссылок ещё не готов, попробуйте через пару секунд')
  const result = generator(link.trim(), 'xray', JSON.stringify({ outbounds: servers.map((s) => s.outbound) }))
  return asOutbound(JSON.parse(result.content))
}

export function jsonToOutbound(text: string): Outbound {
  return asOutbound(JSON.parse(text))
}

export function checkIntervalMs(settings: Settings): number {
  return settings.interval_ms ?? settings.interval_secs * 1000
}

/** The check interval in seconds, as the settings show it. */
export function checkIntervalSecs(settings: Settings): number {
  return checkIntervalMs(settings) / 1000
}

export function rangeError(settings: Settings): string {
  const inRange = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max
  if (!inRange(checkIntervalSecs(settings), 1, 3600)) return 'Интервал: целое число секунд от 1 до 3600'
  if (!inRange(settings.failure_threshold, 1, 10)) return 'Отказов подряд: целое число от 1 до 10'
  if (!inRange(settings.timeout_ms, 500, 30000)) return 'Таймаут: целое число от 500 до 30000 мс'
  return ''
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function draftStatus(server: Server, saved: Settings | null): DraftStatus {
  if (!saved) return null
  const old = saved.servers.find((s) => s.id === server.id)
  if (!old) return 'new'
  return old.name !== server.name || !same(old.outbound, server.outbound) ? 'changed' : null
}

/** Mirrors the backend: Xray restarts when the set of outbounds (or their order) changes. */
export function needsRestart(draft: Settings, saved: Settings | null): boolean {
  if (!saved) return true
  const pairs = (s: Settings) => s.servers.map((v) => [v.id, v.outbound])
  return !same(pairs(draft), pairs(saved))
}

/** `failing` = the active server missed probes but has not reached the failover threshold yet. */
export function health(probe: Probe | undefined, failures = 0, threshold = 0): Health {
  if (!probe) return 'unknown'
  if (probe.latency_ms !== null) return 'ok'
  return failures > 0 && failures < threshold ? 'failing' : 'down'
}

export function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 10) return 'только что'
  if (seconds < 60) return `${seconds} с назад`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`
  return new Date(iso).toLocaleString()
}

export function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback
}

/** Latest known health of a row: background pool probe or ping history, whichever is newer. */
export type Sample = { latency_ms: number | null; error: string | null; time: string | null }

export function latestSample(
  history: { time: string; delay: number; error?: string }[] | undefined,
  probe?: Probe,
  probeTime?: string | null
): Sample | undefined {
  const last = history?.[history.length - 1]
  const fromHistory = last && { latency_ms: last.delay > 0 ? last.delay : null, error: last.error ?? null, time: last.time }
  const fromProbe = probe && { latency_ms: probe.latency_ms, error: probe.error, time: probeTime ?? null }
  if (fromHistory && fromProbe) return (fromProbe.time ?? '') > fromHistory.time ? fromProbe : fromHistory
  return fromHistory ?? fromProbe
}

export function sampleHealth(sample: Sample | undefined): Health {
  if (!sample) return 'unknown'
  return sample.latency_ms !== null ? 'ok' : 'down'
}

/** Snapshot whose probes also reflect the shared ping history (manual checks, manual mode). */
export function withHistory(snapshot: Snapshot, history: Record<string, { time: string; delay: number; error?: string }[]>): Snapshot {
  const servers = snapshot.settings?.servers ?? []
  const probes = servers.flatMap((server) => {
    const sample = latestSample(
      history[server.id],
      snapshot.probes.find((p) => p.id === server.id),
      snapshot.last_check
    )
    return sample ? [{ id: server.id, latency_ms: sample.latency_ms, error: sample.error }] : []
  })
  const times = servers.map((s) => history[s.id]?.at(-1)?.time ?? '').filter(Boolean)
  const lastCheck = [snapshot.last_check ?? '', ...times].sort().at(-1) || null
  return { ...snapshot, probes, last_check: lastCheck }
}
