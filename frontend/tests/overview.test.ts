import { expect, test } from 'bun:test'

const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = Object.assign(new EventTarget(), { localStorage: storage }) as unknown as Window & typeof globalThis
globalThis.localStorage = storage as unknown as Storage
const { DEFAULT_LAYOUT, mbps, moveCard, normalizeLayout, useTrafficStore } = await import('../src/components/shell/Overview')

const device = (mac: string, rx: number, inXkeen: boolean) => ({
  mac,
  name: mac,
  ip: '',
  active: true,
  registered: true,
  in_xkeen: inXkeen,
  rx_bytes: rx,
  tx_bytes: 0,
})
const overview = (devices: ReturnType<typeof device>[]) => ({ success: true, policy: null, wan: null, devices })

test('device speeds come from byte counter deltas, split by XKeen membership', () => {
  const { push } = useTrafficStore.getState()
  push(overview([device('a', 1_000, true), device('b', 5_000, false)]), 0)
  expect(useTrafficStore.getState().samples).toHaveLength(0)
  push(overview([device('a', 1_251_000, true), device('b', 5_000, false), device('c', 9_999, false)]), 5_000)
  const { samples, speeds } = useTrafficStore.getState()
  expect(speeds).toEqual({ a: 2_000_000, b: 0, c: 0 })
  expect(samples.at(-1)).toEqual({ t: 5_000, xkeen: 2_000_000, other: 0 })
  // A reset counter is not a negative speed.
  push(overview([device('a', 10, true), device('b', 5_000, false)]), 10_000)
  expect(useTrafficStore.getState().speeds.a).toBe(0)
  // A long pause starts the measurement again instead of averaging over it.
  const before = useTrafficStore.getState().samples.length
  push(overview([device('a', 99_000_000, true), device('b', 5_000, false)]), 200_000)
  expect(useTrafficStore.getState().samples).toHaveLength(before)
})

test('speed formatting and saved card order survive bad input', () => {
  expect(mbps(12_400_000)).toBe('12,4')
  expect(mbps(250_000_000)).toBe('250')
  expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT)
  expect(normalizeLayout({ left: ['journal', 'bogus', 'journal'], right: ['traffic'] })).toEqual({
    left: ['journal'],
    right: ['traffic', 'connection', 'devices', 'router'],
  })
})

test('cards move within and across columns', () => {
  expect(moveCard(DEFAULT_LAYOUT, 'devices', 'up').left).toEqual(['devices', 'connection'])
  expect(moveCard(DEFAULT_LAYOUT, 'connection', 'up')).toBe(DEFAULT_LAYOUT)
  expect(moveCard(DEFAULT_LAYOUT, 'devices', 'right')).toEqual({
    left: ['connection'],
    right: ['traffic', 'devices', 'router', 'journal'],
  })
  expect(moveCard(DEFAULT_LAYOUT, 'devices', 'left')).toBe(DEFAULT_LAYOUT)
})
