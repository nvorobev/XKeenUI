import { describe, expect, test } from 'bun:test'
import { formatWithPrettier } from '../src/components/configuration/editor/format'

describe('configuration formatting', () => {
  test('expands nested JSON and arrays without changing values', async () => {
    const input = '{"outbounds":[{"tag":"proxy","settings":{"servers":[1,2]}}],"text":"https://example.test/a//b"}'
    const result = (await formatWithPrettier(input, 'json', 0))!
    expect(JSON.parse(result.text)).toEqual(JSON.parse(input))
    expect(result.text).toContain('"servers": [\n          1,\n          2\n        ]')
    expect(result.text).toEndWith('\n')
    expect((await formatWithPrettier(result.text, 'json', 0))!.text).toBe(result.text)
  })

  test('preserves JSONC comments and the cursor position at its token', async () => {
    const input = '{// keep this comment\n"tag":"proxy","port":443}'
    const offset = input.indexOf('proxy') + 2
    const result = (await formatWithPrettier(input, 'json', offset))!
    expect(result.text).toContain('// keep this comment')
    expect(result.text.slice(result.cursor - 2, result.cursor + 3)).toBe('proxy')
  })

  test('reports invalid JSON instead of silently replacing it', async () => {
    await expect(formatWithPrettier('{"port":}', 'json', 0)).rejects.toThrow()
  })

  test('keeps YAML valid and does not format plain text', async () => {
    expect((await formatWithPrettier('proxies: [{name: test, port: 443}]', 'yaml', 0))!.text).toContain('proxies:')
    expect(await formatWithPrettier('keep me', 'text', 0)).toBeNull()
  })
})
