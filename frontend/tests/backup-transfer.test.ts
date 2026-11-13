import { afterEach, expect, test } from 'bun:test'
import { downloadBackupFile, restoreBackupAndWait, uploadBackupFile } from '../src/lib/backupTransfer'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('backup upload sends unchanged binary data rather than a JSON-encoded file', async () => {
  const file = new File([new Uint8Array([0, 255, 10, 13])], 'backup.tar')
  globalThis.fetch = (async (url, options) => {
    expect(url).toBe('/api/backup/upload')
    expect(options?.body).toBe(file)
    expect(options?.method).toBe('POST')
    expect(options?.headers).toEqual({ 'Content-Type': 'application/x-tar' })
    return Response.json({ success: true })
  }) as typeof fetch
  await uploadBackupFile(file)
})

test('backup export preserves archive bytes and safely encodes its filename', async () => {
  const bytes = new Uint8Array([0, 255, 1, 10])
  const name = 'копия & ещё_xkeen-ui.tar'
  globalThis.fetch = (async (url) => {
    expect(url).toBe(`/api/backup/download?name=${encodeURIComponent(name)}`)
    return new Response(bytes, { headers: { 'Content-Type': 'application/x-tar' } })
  }) as typeof fetch
  expect(new Uint8Array(await (await downloadBackupFile(name)).arrayBuffer())).toEqual(bytes)
})

test('invalid uploads surface the validation error instead of reporting success', async () => {
  globalThis.fetch = (async () => Response.json({ success: false, error: 'Архив повреждён' })) as typeof fetch
  await expect(uploadBackupFile(new File(['invalid'], 'backup.tar'))).rejects.toThrow('Архив повреждён')
  await expect(uploadBackupFile(new File([], 'empty.tar'))).rejects.toThrow('Архив пустой')
})

test('restore recovers its actual result after the POST connection is lost', async () => {
  let operation = ''
  globalThis.fetch = (async (url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body as string)
      expect(body.name).toBe('source_xkeen-ui.tar')
      operation = body.operation_id
      expect(operation).toMatch(/^[a-f0-9]{32}$/)
      throw new TypeError('connection closed during restart')
    }
    expect(url).toBe('/api/backup/restore-status')
    return Response.json({ success: true, restore: { operation_id: operation, phase: 'done', panel_restarting: true } })
  }) as typeof fetch
  expect(await restoreBackupAndWait('source_xkeen-ui.tar')).toEqual({ panel_restarting: true })
})

test('a failed restore is shown as an error without pretending it applied', async () => {
  globalThis.fetch = (async () => Response.json({ success: false, error: 'Xray отклонил конфигурацию' })) as typeof fetch
  await expect(restoreBackupAndWait('source_xkeen-ui.tar')).rejects.toThrow('Xray отклонил конфигурацию')
})
