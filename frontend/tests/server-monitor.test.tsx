import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FailoverSettings } from '../src/components/configuration/xray/servers/FailoverSettings'
import { defaults, draftFromSnapshot, latestSample, needsRestart, type Snapshot } from '../src/components/configuration/xray/servers/model'

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
