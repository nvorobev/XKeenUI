import { afterEach, expect, test } from 'bun:test'
import { downloadBackupFile, uploadBackupFile } from '../src/lib/backupTransfer'

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
