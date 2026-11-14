import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// Static rendering checks page composition without running a browser or effects.
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = Object.assign(new EventTarget(), { localStorage: storage }) as unknown as Window & typeof globalThis
globalThis.localStorage = storage as unknown as Storage
const { BackupsPage } = await import('../src/components/modals/Backups')
const { CoreManagementPage } = await import('../src/components/modals/CoreManagement')
const { SettingsPage } = await import('../src/components/modals/Settings')
const { UpdatesPage } = await import('../src/components/modals/Update')
const { UsersPage } = await import('../src/components/auth/Users')
const { LoginForm } = await import('../src/components/auth/Login')
const { TrafficDonut } = await import('../src/components/shell/DeviceTrafficPanel')
const { TrafficMonitor } = await import('../src/components/shell/TrafficMonitor')
const { Overview } = await import('../src/components/shell/Overview')
const { CurrentOutbound } = await import('../src/components/configuration/xray/servers/CurrentServer')

test('standalone server card displays the selected server name instead of its preserved routing tag', () => {
  const html = renderToStaticMarkup(
    <CurrentOutbound
      outbound={{ tag: 'vless-reality', protocol: 'http', settings: { servers: [{ address: '192.0.2.1', port: 443 }] } }}
      name="Selected server"
      isDefault
      rules={1}
    />
  )
  expect(html).toContain('Selected server</h3>')
  expect(html).not.toContain('vless-reality</h3>')
})

describe('maintenance pages', () => {
  test.each([
    ['Резервные копии', <BackupsPage onRefreshConfigs={async () => {}} />],
    ['Ядра', <CoreManagementPage onSwitchCore={() => {}} onOpenUpdate={() => {}} />],
    ['Настройки панели', <SettingsPage />],
    ['Пользователи', <UsersPage />],
    ['Обновление', <UpdatesPage active={false} onInstalled={() => {}} />],
  ])('%s renders as a page with visible content', (title, page) => {
    const html = renderToStaticMarkup(page)
    expect(html).toContain(`<h1 class="text-xl font-bold tracking-wider uppercase">${title}</h1>`)
    expect(html).not.toContain('role="dialog"')
  })
})

test('login includes username and password fields', () => {
  const html = renderToStaticMarkup(<LoginForm mode="login" onAuth={() => {}} />)
  expect(html).toMatch(/autocomplete="username"/i)
  expect(html).toContain('value="admin"')
  expect(html).toMatch(/autocomplete="current-password"/i)
})

test('overview shows tiles and the default card columns with drag handles', () => {
  const html = renderToStaticMarkup(<Overview isXray onOpenModal={() => {}} />)
  const cards = [
    'overview-connection',
    'overview-devices',
    'overview-device-traffic',
    'overview-traffic',
    'overview-service',
    'overview-journal',
  ]
  const offsets = cards.map((id) => html.indexOf(`id="${id}"`))
  expect(offsets.every((offset) => offset >= 0)).toBe(true)
  expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
  for (const tile of ['Выход', 'Трафик', 'Через XKeen', 'Защита трафика']) expect(html).toContain(tile)
  expect(html.match(/aria-label="Переместить карточку/g)).toHaveLength(cards.length)
  expect(html).not.toContain('id="overview-tools"')
  expect(html).not.toContain('id="overview-pool"')
  expect(html).toContain('Время жизни роутера')
  expect(html).toContain('Настройки системного монитора')
})

test('traffic monitor shows both measurements, all periods and the XKeen device filter', () => {
  const html = renderToStaticMarkup(<TrafficMonitor />)
  for (const label of ['Монитор трафика', 'Скорость', 'Топ-5 устройств', '3 мин', '1 час', '3 часа', '1 день', 'Политика XKeen']) {
    expect(html).toContain(label)
  }
})

test('selected traffic sector shows device, percentage and both directions', () => {
  const html = renderToStaticMarkup(
    <TrafficDonut
      rows={[
        { mac: 'a', name: 'MacBook', rx: 4096, tx: 2048 },
        { mac: 'b', name: 'TV', rx: 2048, tx: 0 },
      ]}
      bytes={8192}
      active="a"
      onActive={() => {}}
    />
  )
  expect(html).toContain('role="tooltip"')
  expect(html).toContain('MacBook, 75 %, вход 4 КБ, выход 2 КБ')
  expect(html).toContain('opacity-45')
})
