import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { apiCall } from '../src/lib/api'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
})

describe('panel API requests', () => {
  test('persists a server independently of pool activation', async () => {
    const request = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true }))
    const server = { id: 'server-id', name: 'Saved server', outbound: { protocol: 'socks' } }
    await apiCall('PUT', 'xray/servers/library', server)
    expect(request).toHaveBeenCalledWith(
      '/api/xray/servers/library',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(server) })
    )
  })

  test('reports backend errors rather than parsing an empty unauthorized response', async () => {
    const target = new EventTarget()
    globalThis.window = target as unknown as Window & typeof globalThis
    let expired = false
    target.addEventListener('auth-required', () => {
      expired = true
    })
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch
    await expect(apiCall('GET', 'settings')).rejects.toThrow('Необходимо войти')
    expect(expired).toBe(true)
  })

  test('an expired local session sends the user to the login screen', async () => {
    const target = new EventTarget()
    globalThis.window = target as unknown as Window & typeof globalThis
    let expired = false
    target.addEventListener('auth-required', () => {
      expired = true
    })
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch
    await expect(apiCall('GET', 'settings')).rejects.toThrow('Необходимо войти в панель')
    expect(expired).toBe(true)
  })

  test('an unresponsive request times out and releases the caller', async () => {
    globalThis.fetch = ((_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })) as typeof fetch
    await expect(apiCall('POST', 'control', { action: 'start' }, { timeoutMs: 10 })).rejects.toThrow('не ответила вовремя')
  })

  test('preserves the storage error returned by the backend', async () => {
    globalThis.fetch = (async () => Response.json({ error: 'disk is full' }, { status: 500 })) as typeof fetch
    await expect(apiCall('POST', 'auth/reset')).rejects.toThrow('disk is full')
  })
})
