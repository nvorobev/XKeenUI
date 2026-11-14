import { useEffect } from 'react'
import { create } from 'zustand'
import { apiCall } from '../../lib/api'

export const DEVICE_TRAFFIC_WINDOW_MS = 3 * 60_000
export const DAY_MS = 24 * 60 * 60_000
const MINUTE_MS = 60_000

export type DeviceTraffic = { mac: string; name: string; rx: number; tx: number; inXkeen?: boolean }
export type DeviceTrafficInterval = { start: number; end: number; devices: DeviceTraffic[]; measuredMs?: number }

export function intervalOverlap(start: number, end: number, from: number, to: number) {
  return Math.max(0, Math.min(end, to) - Math.max(start, from))
}

/** Retain one aggregate per minute and keep the policy of each measured transfer. */
export function appendMinuteHistory(history: DeviceTrafficInterval[], interval: DeviceTrafficInterval) {
  const cutoff = interval.end - DAY_MS
  const next = history.filter((minute) => minute.end > cutoff)
  const duration = interval.end - interval.start
  for (let start = interval.start; start < interval.end;) {
    const minuteStart = Math.floor(start / MINUTE_MS) * MINUTE_MS
    const minuteEnd = minuteStart + MINUTE_MS
    const end = Math.min(interval.end, minuteEnd)
    const elapsed = end - start
    const fraction = elapsed / duration
    const current = next.at(-1)
    const sameMinute = current?.start === minuteStart
    const devices = new Map<string, DeviceTraffic>()
    const key = (device: DeviceTraffic) => `${device.mac}/${!!device.inXkeen}`
    if (sameMinute) for (const device of current.devices) devices.set(key(device), device)
    for (const device of interval.devices) {
      const previous = devices.get(key(device))
      devices.set(key(device), {
        ...device,
        rx: (previous?.rx ?? 0) + device.rx * fraction,
        tx: (previous?.tx ?? 0) + device.tx * fraction,
      })
    }
    const minute = {
      start: minuteStart,
      end,
      devices: [...devices.values()],
      measuredMs: (sameMinute ? (current.measuredMs ?? 0) : 0) + elapsed,
    }
    if (sameMinute) next[next.length - 1] = minute
    else next.push(minute)
    start = end
  }
  return next
}

export type RouterDevice = {
  mac: string
  name: string
  ip: string
  active: boolean
  registered: boolean
  in_xkeen: boolean
  rx_bytes: number
  tx_bytes: number
}

export type RouterOverview = {
  success: boolean
  error?: string
  policy: { name: string; description: string } | null
  wan: { interface: string; rx_bps: number; tx_bps: number } | null
  devices: RouterDevice[]
}

type TrafficSample = { t: number; xkeen: number; other: number }

export const TRAFFIC_WINDOW_MS = 10 * 60 * 1000

type TrafficState = {
  samples: TrafficSample[]
  deviceIntervals: DeviceTrafficInterval[]
  minuteHistory: DeviceTrafficInterval[]
  /** Download speed of each device, bits per second, from the last two polls. */
  speeds: Record<string, number>
  last: { t: number; bytes: Record<string, { rx: number; tx: number }> } | null
  push: (overview: RouterOverview, now?: number) => void
}

const emptyTraffic = {
  samples: [],
  deviceIntervals: [],
  minuteHistory: [],
  speeds: {},
  last: null,
}

/** Measurements are kept in memory for the current panel session. */
export const useTrafficStore = create<TrafficState>((set, get) => ({
  ...emptyTraffic,
  push: (overview, now = Date.now()) => {
    if (!overview.success) return
    const bytes = Object.fromEntries(overview.devices.map((device) => [device.mac, { rx: device.rx_bytes, tx: device.tx_bytes }]))
    const last = get().last
    if (!last) {
      set({ last: { t: now, bytes }, speeds: {}, deviceIntervals: [] })
      return
    }
    const seconds = (now - last.t) / 1000
    if (seconds < 1) return
    // After a long pause (another page, a sleeping tab) the delta is no current speed.
    if (seconds > 60) {
      set((state) => ({
        last: { t: now, bytes },
        speeds: {},
        minuteHistory: appendMinuteHistory(state.minuteHistory, { start: now, end: now, devices: [] }),
        deviceIntervals: [
          ...state.deviceIntervals.filter((interval) => interval.end > now - DEVICE_TRAFFIC_WINDOW_MS),
          { start: now, end: now, devices: [] },
        ],
      }))
      return
    }
    const speeds: Record<string, number> = {}
    const devices: DeviceTrafficInterval['devices'] = []
    let xkeen = 0
    let other = 0
    for (const device of overview.devices) {
      const previous = last.bytes[device.mac]
      // A new device or a reset counter has no measurable delta yet.
      const rx = previous ? Math.max(0, device.rx_bytes - previous.rx) : 0
      const tx = previous ? Math.max(0, device.tx_bytes - previous.tx) : 0
      if (rx || tx) devices.push({ mac: device.mac, name: device.name || device.mac, inXkeen: device.in_xkeen, rx, tx })
      const bps = (rx * 8) / seconds
      speeds[device.mac] = bps
      if (device.in_xkeen) xkeen += bps
      else other += bps
    }
    const interval = { start: last.t, end: now, devices }
    set((state) => ({
      last: { t: now, bytes },
      speeds,
      minuteHistory: appendMinuteHistory(state.minuteHistory, interval),
      deviceIntervals: [...state.deviceIntervals.filter((interval) => interval.end > now - DEVICE_TRAFFIC_WINDOW_MS), interval],
      samples: [...state.samples.filter((sample) => now - sample.t <= TRAFFIC_WINDOW_MS), { t: now, xkeen, other }],
    }))
  },
}))

/** Polls `load` every `ms` while the page is visible. */
export function usePolling(load: () => Promise<void>, ms: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    void load()
    const timer = setInterval(() => {
      if (!document.hidden) void load()
    }, ms)
    return () => clearInterval(timer)
  }, [load, ms, enabled])
}

export const useRouterOverview = create<{
  overview: RouterOverview | null
  setOverview: (overview: RouterOverview) => void
}>((set) => ({ overview: null, setOverview: (overview) => set({ overview }) }))

export function useCollectTraffic(enabled: boolean) {
  useEffect(
    () => () => {
      useRouterOverview.setState({ overview: null })
      useTrafficStore.setState(emptyTraffic)
    },
    []
  )
  useEffect(() => {
    if (!enabled) return
    let active = true
    let busy = false
    const load = async () => {
      if (busy || document.hidden) return
      busy = true
      const previous = useRouterOverview.getState().overview
      try {
        const next = await apiCall<RouterOverview>('GET', 'overview', undefined, { timeoutMs: 10000 })
        if (!active || useRouterOverview.getState().overview !== previous) return
        useRouterOverview.getState().setOverview(next)
        useTrafficStore.getState().push(next)
      } catch {
        // Retry on the next poll.
      } finally {
        busy = false
      }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [enabled])
}
