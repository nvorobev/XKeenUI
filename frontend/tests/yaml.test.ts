import { expect, test } from 'bun:test'
import { validateYaml } from '../src/components/configuration/editor/validation'

test('Mihomo config with anchors and merge keys is valid', () => {
  const config = [
    'x: &classical',
    '  type: http',
    '  interval: 86400',
    'rule-providers:',
    '  a: { <<: *classical, url: https://example.com/a.list }',
    '  b: { <<: *classical, url: https://example.com/b.list }',
    '',
  ].join('\n')
  expect(validateYaml(config)).toEqual({ diagnostics: [], isValid: true })
})

test('YAML errors point at their line', () => {
  const result = validateYaml('dns:\n  enable: true\n  enable: false\n')
  expect(result.isValid).toBe(false)
  expect(result.error).toContain('[строка 3]')
  expect(result.diagnostics[0].from).toBe('dns:\n  enable: true\n'.length + 2)
})
