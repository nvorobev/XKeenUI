import { expect, test } from 'bun:test'
import {
  buildGenerator,
  generateCategories,
  loadGenerator,
  parseRegexes,
  setFlag,
  validIp,
} from '../src/components/configuration/xray/routing-generator'
import type { Config } from '../src/lib/types'
import { coreVectors, fresh, referenceVectors, targets } from './routing-generator-cases'
for (const vector of referenceVectors) test(`reference browser: ${vector.name}`, () => expect(vector.actual).toEqual(vector.expected))
test('QUIC and GeoIP keep independent conditions instead of widening a port-specific block', () => {
  const state = setFlag(fresh(), 'block', 'quic', true)
  state.groups.block.geo = ['geoip:ru']
  const rules = generateCategories(state, targets)
  expect(rules).toHaveLength(2)
  expect(rules[0]).toMatchObject({ network: 'udp', port: '443', ip: ['ext:geoip_zkeenip.dat:!ru'] })
  expect(rules[1]).toHaveProperty('ip', ['geoip:ru'])
  expect(rules[1]).not.toHaveProperty('port')
})
test('regex quantifiers, partial keywords and compressed IPv6 remain valid', () => {
  expect(parseRegexes('regexp:^a{1,3}\\.com$,regexp:^b\\.com$')).toEqual(['regexp:^a{1,3}\\.com$', 'regexp:^b\\.com$'])
  for (const value of ['::1', '2001:db8::1', '2001:db8::/32', '::/0', '10.0.0.0/8']) expect(validIp(value, true)).toBe(true)
  for (const value of ['256.1.1.1', '1.2.3.4/33', '::/129', '2001:::1', '1.2.3.4/1/2']) expect(validIp(value, true)).toBe(false)
  const state = fresh()
  state.groups.block.partial = 'tracker'
  expect(generateCategories(state, targets)[0].domain).toEqual(['tracker'])
})
test('loading current configuration selects existing fields and preserves complex/API rules', () => {
  const complex = {
    type: 'field',
    domain: ['domain:private.example'],
    sourceIP: ['192.168.1.2'],
    attrs: { ':method': 'GET' },
    outboundTag: 'direct',
  }
  const original = {
    api: { tag: 'api' },
    routing: {
      domainStrategy: 'AsIs',
      domainMatcher: 'hybrid',
      rules: [
        { inboundTag: ['api'], outboundTag: 'api' },
        complex,
        { type: 'field', domain: ['domain:example.com'], outboundTag: 'vless-reality' },
      ],
    },
    policy: { keep: true },
  }
  const configs = [
    { file: '04_outbounds.json', content: JSON.stringify({ outbounds: targets.map((t) => ({ tag: t.tag, protocol: t.protocol })) }) },
  ] as Config[]
  const loaded = loadGenerator(JSON.stringify(original), configs)
  expect(loaded.state.strategy).toBe('AsIs')
  expect(loaded.state.retained).toEqual(original.routing.rules.slice(1))
  expect(loaded.state.retained).toContainEqual(complex)
  const built = JSON.parse(buildGenerator(JSON.stringify(original), loaded.state, loaded.targets).content)
  expect(built.routing.rules).toEqual(original.routing.rules)
  expect(built.policy).toEqual({ keep: true })
  expect(built.routing.domainMatcher).toBe('hybrid')
})
test('core validation vectors cover every catalogue item in every category', () => expect(coreVectors()).toHaveLength(344))
