import { expect, test } from 'bun:test'
import { summarizeDeviceTraffic } from '../src/components/shell/DeviceTrafficPanel'
import { DEFAULT_LAYOUT, moveCard, normalizeLayout, normalizeOverviewPreferences, placeCard } from '../src/components/shell/OverviewLayout'
import { appendMinuteHistory, DAY_MS, useTrafficStore } from '../src/components/shell/trafficHistory'
import { buildTrafficChart } from '../src/components/shell/TrafficMonitor'

const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = Object.assign(new EventTarget(), { localStorage: storage }) as unknown as Window & typeof globalThis
globalThis.localStorage = storage as unknown as Storage
const { mbps } = await import('../src/components/shell/Overview')

const device = (mac: string, rx: number, inXkeen: boolean, tx = 0) => ({
  mac,
  name: mac,
  ip: '',
  active: true,
  registered: true,
  in_xkeen: inXkeen,
  rx_bytes: rx,
  tx_bytes: tx,
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
    right: ['device-traffic', 'traffic', 'connection', 'devices', 'router'],
  })
})

test('cards move within and across columns', () => {
  expect(moveCard(DEFAULT_LAYOUT, 'devices', 'up').left).toEqual(['devices', 'connection'])
  expect(moveCard(DEFAULT_LAYOUT, 'connection', 'up')).toBe(DEFAULT_LAYOUT)
  expect(moveCard(DEFAULT_LAYOUT, 'devices', 'right')).toEqual({
    left: ['connection'],
    right: ['device-traffic', 'devices', 'traffic', 'router', 'journal'],
  })
  expect(moveCard(DEFAULT_LAYOUT, 'devices', 'left')).toBe(DEFAULT_LAYOUT)
  expect(placeCard(DEFAULT_LAYOUT, 'journal', { side: 'left', before: 'devices' })).toEqual({
    left: ['connection', 'journal', 'devices'],
    right: ['device-traffic', 'traffic', 'router'],
  })
  expect(placeCard(DEFAULT_LAYOUT, 'connection', { side: 'left', before: 'devices' })).toBe(DEFAULT_LAYOUT)
  expect(placeCard({ left: ['devices'], right: [] }, 'devices', { side: 'right', before: null })).toEqual({
    left: [],
    right: ['devices'],
  })
})

test('overview visibility survives reload and ignores duplicate or removed cards', () => {
  expect(normalizeOverviewPreferences(DEFAULT_LAYOUT)).toEqual({ ...DEFAULT_LAYOUT, hidden: [] })
  const saved = { ...DEFAULT_LAYOUT, hidden: ['journal', 'bogus', 'journal'] }
  expect(normalizeOverviewPreferences(JSON.parse(JSON.stringify(saved)))).toEqual({ ...DEFAULT_LAYOUT, hidden: ['journal'] })
})

test('the device monitor uses recent deltas in both directions and skips resets and polling gaps', () => {
  useTrafficStore.setState({ last: null, samples: [], deviceIntervals: [], minuteHistory: [], speeds: {} })
  const { push } = useTrafficStore.getState()
  push(overview([device('a', 500, true, 700)]), 0)
  push(overview([device('a', 300, true, 800), device('new', 10_000, true, 9_000)]), 5_000)
  push(overview([device('a', 400, true, 900)]), 80_000)
  push(overview([device('a', 450, true, 950)]), 85_000)
  expect(summarizeDeviceTraffic(useTrafficStore.getState().deviceIntervals).total).toEqual({ rx: 50, tx: 150 })
  push(overview([device('a', 450, true, 950)]), 185_000)
  expect(summarizeDeviceTraffic(useTrafficStore.getState().deviceIntervals).total).toEqual({ rx: 50, tx: 50 })
})

test('the device monitor apportions the window boundary and groups smaller volumes', () => {
  const first = { start: 0, end: 10_000, devices: [{ mac: 'a', name: 'A', rx: 100, tx: 60 }] }
  const latest = {
    start: 180_000,
    end: 185_000,
    devices: Array.from({ length: 6 }, (_, index) => ({ mac: String(index), name: String(index), rx: 20 - index, tx: 10 })),
  }
  const { total, rows } = summarizeDeviceTraffic([first, latest])
  expect(total).toEqual({ rx: 155, tx: 90 })
  expect(rows.at(-1)).toEqual({ mac: 'other', name: 'Другие клиенты', rx: 31, tx: 20 })
})

test('long history splits samples across minutes and retains policy at measurement time', () => {
  const device = { mac: 'a', name: 'A', rx: 800, tx: 200, inXkeen: true }
  const first = appendMinuteHistory([], { start: 55_000, end: 65_000, devices: [device] })
  const history = appendMinuteHistory(first, { start: 65_000, end: 70_000, devices: [{ ...device, inXkeen: false }] })
  expect(history.map((minute) => minute.measuredMs)).toEqual([5_000, 10_000])
  expect(history[0].devices[0]).toMatchObject({ rx: 400, tx: 100, inXkeen: true })
  expect(history[1].devices.map((device) => device.inXkeen)).toEqual([true, false])
  expect(appendMinuteHistory(history, { start: DAY_MS + 70_000, end: DAY_MS + 75_000, devices: [] })).toHaveLength(1)
})

test('traffic chart prorates volumes and calculates speed over measured time only', () => {
  const history = [
    {
      start: 0,
      end: 10_000,
      measuredMs: 5_000,
      devices: [
        { mac: 'a', name: 'A', rx: 800, tx: 200 },
        { mac: 'b', name: 'B', rx: 100, tx: 400 },
      ],
    },
  ]
  expect(buildTrafficChart(history, ['a', 'other'], 5_000, 15_000, 'volume', 2).map((slot) => slot.values)).toEqual([
    [500, 250],
    [0, 0],
  ])
  expect(buildTrafficChart(history, ['a'], 5_000, 15_000, 'speed', 2).map((slot) => slot.values)).toEqual([[1600], [0]])
})
