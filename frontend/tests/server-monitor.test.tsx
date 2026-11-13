import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FailoverSettings } from '../src/components/configuration/xray/servers/FailoverSettings'
import { defaults, draftFromSnapshot, draftStatus, latestSample, needsRestart, settingsEqual, type Snapshot } from '../src/components/configuration/xray/servers/model'

test('loading and saving identical JSON with reordered fields does not create a pending change', () => {
  const server = { id: 'a', name: 'A', outbound: { protocol: 'vless', settings: { address: 'vpn.test', port: 443 } } }
  const saved = { ...defaults, servers: [server], selected_id: 'a', target_tag: 'vpn' }
  const received = Object.fromEntries(Object.entries(saved).reverse()) as typeof saved
  const library = { outbound: { settings: { port: 443, address: 'vpn.test' }, protocol: 'vless' }, name: 'A', id: 'a' }
  const draft = draftFromSnapshot({ settings: received, servers: [library] } as Snapshot)
  expect(settingsEqual(draft, received)).toBe(true)
  expect(draftStatus(library, saved)).toBeNull()
  expect(needsRestart(draft, received)).toBe(false)
  const changed = { ...draft, auto: !draft.auto }
  expect(settingsEqual(changed, received)).toBe(false)
  expect(settingsEqual({ ...changed, auto: draft.auto }, received)).toBe(true)
  expect(settingsEqual({ ...draft, servers: [{ ...library, name: 'Renamed' }] }, received)).toBe(false)
})

test('legacy interval seconds are preserved and compare equal to explicit milliseconds', () => {
  const stored = { ...defaults, interval_secs: 90 }
  delete stored.interval_ms
  const draft = draftFromSnapshot({ settings: stored, servers: [] } as unknown as Snapshot)
  expect(draft.interval_ms).toBe(90000)
  expect(settingsEqual(draft, stored)).toBe(true)
  const old = { ...stored } as Partial<typeof stored>
  delete old.latency_samples
  delete old.prefer_fastest
  expect(settingsEqual(draftFromSnapshot({ settings: old, servers: [] } as unknown as Snapshot), stored)).toBe(true)
})

test('old stored groups acquire a five-check window and keep fastest selection opt-in', () => {
  const old: Partial<typeof defaults> = { ...defaults }
  delete old.latency_samples
  delete old.prefer_fastest
  const draft = draftFromSnapshot({ settings: old, servers: [] } as unknown as Snapshot)
  expect(draft.latency_samples).toBe(5)
  expect(draft.prefer_fastest).toBe(false)
})

test('editing an inactive server does not restart the active connection', () => {
  const saved = { ...defaults, selected_id: 'a', servers: [
    { id: 'a', name: 'A', outbound: { protocol: 'vless', address: 'a.test' } },
    { id: 'b', name: 'B', outbound: { protocol: 'vless', address: 'b.test' } },
  ] }
  expect(needsRestart({ ...saved, servers: [saved.servers[0], { ...saved.servers[1], outbound: { protocol: 'vless', address: 'new.test' } }] }, saved)).toBe(false)
  expect(needsRestart({ ...saved, selected_id: 'b' }, saved)).toBe(true)
})

test('a successful zero-millisecond check remains healthy and preserves its rolling average', () => {
  const sample = latestSample([{ time: '2026-11-14T00:00:00Z', delay: 0 }], { id: 'a', latency_ms: 0, error: null, average_ms: 4, checks: 5 }, '2026-11-14T00:00:00Z')
  expect(sample?.latency_ms).toBe(0)
  expect(sample?.average_ms).toBe(4)
  expect(sample?.checks).toBe(5)
})

test('monitoring controls expose the optional fastest choice and configurable sample window', () => {
  const html = renderToStaticMarkup(<FailoverSettings draft={{ ...defaults, auto: true, latency_samples: 7 }} disabled={false} error="Проверка формы" onChange={() => {}} />)
  expect(html).toContain('Переключаться на самый быстрый')
  expect(html).toContain('Проверок для среднего пинга')
  expect(html).toContain('value="7"')
})
