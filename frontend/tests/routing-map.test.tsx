import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RoutingMap, routeConditions, routePath } from '../src/components/configuration/xray/RoutingMap'
import { targets } from './routing-generator-cases'

test('map explains AND conditions without treating a combined rule as independent routes', () => {
  const rule = { type: 'field', ip: ['geoip:ru'], network: 'udp', port: '443', outboundTag: 'block' }
  const description = routeConditions(rule)
  expect(description).toBe('IP: geoip:ru · И · Сеть: udp · И · Порт назначения: 443')
  expect(routePath(rule, targets)).toBe('block')
  expect(routePath({ outboundTag: 'direct' }, targets)).toBe('direct')
  expect(routePath({ outboundTag: 'xkeen-ui-server-selected' }, targets)).toBe('vpn')
  expect(routePath({ outboundTag: 'unknown-custom-exit' }, targets)).toBe('other')
  expect(routePath({ balancerTag: 'xkeen-ui-servers' }, targets)).toBe('vpn')
})
test('map shows one uplink to the provider and two outgoing routes selected by the router', () => {
  const html = renderToStaticMarkup(
    <RoutingMap
      rules={[
        { type: 'field', domain: ['domain:example.com'], outboundTag: 'vless-reality' },
        { type: 'field', network: 'tcp,udp', outboundTag: 'direct' },
      ]}
      targets={targets}
      poolActive
      pool={{ targetTag: 'vless-reality', selectedName: 'Нидерланды', auto: true }}
      inboundTags={['redirect', 'tproxy']}
      domainStrategy="IPIfNonMatch"
      result={{
        success: true,
        results: [
          {
            target: 'example.com',
            kind: 'domain',
            outcome: 'matched',
            outbound: 'xkeen-ui-servers',
            rule: { index: 0, text: 'domain:example.com', detail: null },
            balancer: { tag: 'xkeen-ui-servers', selector: ['xkeen-ui-server-selected'] },
            resolvedIps: [],
            dnsSource: null,
            skipped: [],
            error: null,
          },
        ],
      }}
    />
  )
  for (const label of ['Устройство', 'Роутер', 'Провайдер', 'VPN-сервер', 'Сайт / сервис', 'Блокировка', 'правило #1'])
    expect(html).toContain(label)
  expect(html).toContain('aria-pressed="true"')
  expect(html).not.toContain('Этот выход не относится')
  expect(html.match(/data-node="provider"/g)).toHaveLength(1)
  expect(html.match(/data-from="router" data-to="provider"/g)).toHaveLength(1)
  expect(html).toMatch(/data-from="router" data-to="provider" data-route="shared"[^>]*class="[^"]*stroke-primary"/)
  expect(html).toContain('data-from="rules" data-to="block"')
  expect(html).toContain('data-from="provider" data-to="vpn" data-route="vpn"')
  expect(html).toContain('data-from="provider" data-to="destination" data-route="direct"')
  expect(html).toContain('Маршрут выбирается правилами Xray внутри роутера')
  for (const title of ['Политика / перехват', 'Вход Xray', 'Правила Xray', 'DNS', 'Пул серверов', 'Нидерланды'])
    expect(html).toContain(title)
  expect(html).toContain('data-from="policy" data-to="inbound"')
  expect(html).toContain('data-from="inbound" data-to="rules"')
  expect(html).toContain('data-from="dns" data-to="rules" data-kind="dependency"')
  expect(html).toContain('data-from="pool" data-to="proxy" data-kind="dependency"')
  expect(html).not.toContain('data-from="provider" data-to="pool"')
  expect(html).not.toContain('>Интернет</text>')
  expect(html).toContain('На весь экран')
  expect(html).toContain('Первое совпадение')
  expect(html).toContain('а не наблюдение за пакетами')
})
