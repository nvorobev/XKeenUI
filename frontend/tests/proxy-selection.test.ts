import { afterEach, expect, test } from 'bun:test'

const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = Object.assign(new EventTarget(), { localStorage: storage }) as unknown as Window & typeof globalThis
globalThis.localStorage = storage as unknown as Storage
const { confirmedSelection, fetchClashProxies, pendingProxySelections, settleProxySelection, useProxiesStore } =
  await import('../src/lib/store')

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  pendingProxySelections.clear()
})

/** Answers each `proxies` request with the next queued group choice after the given delay. */
function serveProxies(answers: { now: string; delay: number }[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('providers/proxies')) return Response.json({ providers: {} })
    const answer = answers.shift() ?? { now: 'none', delay: 0 }
    await new Promise((r) => setTimeout(r, answer.delay))
    return Response.json({ proxies: { GROUP: { name: 'GROUP', type: 'Selector', now: answer.now, all: ['A', 'B'] } } })
  }) as typeof fetch
}

const shown = () => (useProxiesStore.getState().proxies.GROUP as { now?: string } | undefined)?.now

test('a list requested earlier but answered later does not overwrite a newer one', async () => {
  serveProxies([
    { now: 'A', delay: 60 },
    { now: 'B', delay: 0 },
  ])
  const older = fetchClashProxies('9090', null, true)
  const newer = fetchClashProxies('9090', null, true)
  expect(await newer).toBe(true)
  expect(await older).toBe(false)
  expect(shown()).toBe('B')
  expect(confirmedSelection('GROUP')).toBe('B')
})

test('a choice on its way is kept over lists read before the core took it', async () => {
  pendingProxySelections.set('GROUP', { choice: 'A', settledAt: null })
  serveProxies([{ now: 'B', delay: 0 }])
  await fetchClashProxies('9090', null, true)
  expect(shown()).toBe('A')
  // The core took it; a list requested afterwards shows the core's value and ends the overlay.
  settleProxySelection('GROUP', 'A')
  serveProxies([{ now: 'A', delay: 0 }])
  await fetchClashProxies('9090', null, true)
  expect(shown()).toBe('A')
  expect(pendingProxySelections.has('GROUP')).toBe(false)
})
