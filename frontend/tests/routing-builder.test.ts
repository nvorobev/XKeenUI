import { expect, test } from 'bun:test'
import { destinations, generateRouting, type DraftRule } from '../src/components/configuration/xray/routing-builder'
import type { Config } from '../src/lib/types'
const configs = [
  {
    file: '04_outbounds.json',
    content: JSON.stringify({
      outbounds: [
        { tag: 'proxy', protocol: 'vless' },
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole' },
      ],
    }),
  },
] as Config[]
const targets = destinations(configs)
const row = (value: Partial<DraftRule>): DraftRule => ({
  id: '1',
  condition: 'domain',
  values: 'example.com',
  network: '',
  target: 'outboundTag:proxy',
  ...value,
})

test('generates independent OR rules in priority order and an explicit fallback', () => {
  const generated = generateRouting(
    '{"routing":{"balancers":[{"tag":"keep"}]},"policy":{"keep":true}}',
    [
      row({ values: 'example.com, full:other.example\nregexp:^a{1,3}\\.example$' }),
      row({ condition: 'port', values: '443,1000-2000', network: 'udp', target: 'outboundTag:block' }),
    ],
    'outboundTag:direct',
    'IPOnDemand',
    targets
  )
  expect(generated.rules).toEqual([
    { type: 'field', domain: ['domain:example.com', 'full:other.example', 'regexp:^a{1,3}\\.example$'], outboundTag: 'proxy' },
    { type: 'field', port: '443,1000-2000', network: 'udp', outboundTag: 'block' },
    { type: 'field', network: 'tcp,udp', outboundTag: 'direct' },
  ])
  expect(generated.routing.balancers).toEqual([{ tag: 'keep' }])
  expect(JSON.parse(generated.content).policy).toEqual({ keep: true })
})
test('preserves API rules before catch-all when API is configured in another file', () => {
  const generated = generateRouting(
    '{"routing":{"rules":[{"inboundTag":["control"],"outboundTag":"control"},{"domain":["old.example"],"outboundTag":"proxy"}]}}',
    [],
    'outboundTag:direct',
    'AsIs',
    targets,
    ['control']
  )
  expect(generated.rules).toHaveLength(2)
  expect(generated.rules[0].outboundTag).toBe('control')
  expect(generated.preserved).toBe(1)
  expect(generated.replaced).toBe(1)
})
test('rejects invalid drafts instead of silently dropping entries or overriding a script', () => {
  for (const draft of [
    row({ values: '' }),
    row({ condition: 'port', values: '0,65536' }),
    row({ target: 'outboundTag:missing' }),
    row({ values: 'https://example.com/path' }),
  ]) {
    expect(() => generateRouting('{}', [draft], 'outboundTag:direct', 'AsIs', targets)).toThrow()
  }
  expect(() => generateRouting('{"routing":{"script":"override"}}', [], 'outboundTag:direct', 'AsIs', targets)).toThrow()
  expect(() => generateRouting('{broken', [], 'outboundTag:direct', 'AsIs', targets)).toThrow()
})
test('distinguishes outbound and balancer destinations with the same tag', () => {
  const available = [...targets, { value: 'balancerTag:proxy', tag: 'proxy', kind: 'balancerTag' as const, label: 'Pool' }]
  const generated = generateRouting('{}', [], 'balancerTag:proxy', 'AsIs', available)
  expect(generated.rules[0].balancerTag).toBe('proxy')
  expect(generated.rules[0].outboundTag).toBeUndefined()
})

test('loads the existing rules, strategy and fallback without losing combined or advanced conditions', async () => {
  const { readRoutingDraft } = await import('../src/components/configuration/xray/routing-builder')
  const routing = {
    domainStrategy: 'IPOnDemand',
    domainMatcher: 'hybrid',
    balancers: [],
    rules: [
      {
        type: 'field',
        domain: ['plain-keyword', 'regexp:^a{1,3}\\.example$'],
        port: '443',
        sourceIP: ['192.168.1.2'],
        attrs: { ':method': 'GET' },
        network: 'tcp',
        outboundTag: 'proxy',
        ruleTag: 'original',
      },
      { type: 'field', sourcePort: '1024-65535', inboundTag: ['tproxy'], outboundTag: 'direct' },
      { type: 'field', network: 'tcp,udp', outboundTag: 'direct', ruleTag: 'fallback' },
    ],
  }
  const content = JSON.stringify({ routing, policy: { keep: true } })
  const initial = readRoutingDraft(content)
  expect(initial.draft).toHaveLength(2)
  expect(initial.draft[0].values).toContain('plain-keyword')
  expect(initial.draft[0].extra?.port).toBe('443')
  expect(initial.fallback).toBe('outboundTag:direct')
  const built = generateRouting(content, initial.draft, initial.fallback, initial.strategy, targets, [], initial.fallbackTemplate)
  expect(JSON.parse(built.content)).toEqual(JSON.parse(content))
  const changed = initial.draft.map((rule, i) => (i === 0 ? { ...rule, network: 'udp', extraInputs: { port: '80,443' } } : rule))
  const edited = generateRouting(content, changed, initial.fallback, initial.strategy, targets, [], initial.fallbackTemplate)
  expect(edited.rules[0].domain).toEqual(routing.rules[0].domain)
  expect(edited.rules[0].port).toBe('80,443')
  expect(edited.rules[0].sourceIP).toEqual(['192.168.1.2'])
  expect(edited.rules[0].attrs).toEqual({ ':method': 'GET' })
  expect(edited.rules[1]).toEqual(routing.rules[1])
  expect(JSON.parse(content).routing).toEqual(routing)
})

test('keeps implicit fallback and omits generated pool destinations from the source constructor', async () => {
  const { readRoutingDraft, IMPLICIT_DEFAULT } = await import('../src/components/configuration/xray/routing-builder')
  const content = '{"routing":{"rules":[{"domain":["keyword"],"outboundTag":"proxy"}]}}'
  const initial = readRoutingDraft(content)
  expect(initial.fallback).toBe(IMPLICIT_DEFAULT)
  expect(JSON.parse(generateRouting(content, initial.draft, initial.fallback, initial.strategy, targets).content)).toEqual(
    JSON.parse(content)
  )
  const withPool = destinations([
    ...configs,
    {
      file: '/opt/etc/xray/configs/07_pool.json',
      content: '{"outbounds":[{"tag":"internal","protocol":"vless"}],"routing":{"balancers":[{"tag":"xkeen-ui-servers"}]}}',
    } as Config,
  ])
  expect(withPool).toEqual(targets)
})
