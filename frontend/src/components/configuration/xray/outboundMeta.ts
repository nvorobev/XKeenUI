// Shared human-readable summary of an Xray outbound (GuiOutbounds, Xray servers pool).
type Outbound = Record<string, any>

export interface OutboundMeta {
  protocol: string
  protocolLabel?: string
  address?: string
  port?: string | number
  network?: string
  security?: string
  sni?: string
  fingerprint?: string
  flow?: string
  domainStrategy?: string
  sockoptDomainStrategy?: string
  alpn?: string[]
  muxEnabled?: boolean
  congestion?: string
}

/** Достаёт из аутбаунда человекочитаемые метаданные подключения. */
export function extractMeta(ob: Outbound): OutboundMeta {
  const s = ob.settings ?? {}
  const stream = ob.streamSettings ?? {}
  const tls = stream.tlsSettings ?? {}
  const reality = stream.realitySettings ?? {}
  // vless/vmess in the classic format keep the endpoint in settings.vnext[]
  const server = Array.isArray(s.servers) ? s.servers[0] : Array.isArray(s.vnext) ? s.vnext[0] : undefined

  let address: string | undefined = s.address ?? server?.address
  let port: string | number | undefined = s.port ?? server?.port
  // wireguard хранит конечную точку в peers[].endpoint как "host:port"
  if (!address && ob.protocol === 'wireguard') {
    if (Array.isArray(s.peers) && typeof s.peers[0]?.endpoint === 'string') {
      const endpoint: string = s.peers[0].endpoint
      const i = endpoint.lastIndexOf(':')
      address = i >= 0 ? endpoint.slice(0, i) : endpoint
      port = i >= 0 ? endpoint.slice(i + 1).replace(/\/.*$/, '') : undefined
    }
  }

  const sni = tls.serverName ?? reality.serverName ?? s.sni ?? undefined
  const alpn = Array.isArray(tls.alpn) && tls.alpn.length ? tls.alpn : Array.isArray(s.alpn) && s.alpn.length ? s.alpn : undefined
  const security =
    stream.security === 'tls' || stream.security === 'reality' ? stream.security : tls.serverName || reality.serverName ? 'tls' : 'none'
  // При security tls/reality без явного fingerprint Xray использует uTLS с профилем chrome — показываем дефолт.
  const fpDefault = security === 'tls' || security === 'reality' ? 'chrome' : undefined
  const fingerprint = tls.fingerprint ?? reality.fingerprint ?? fpDefault

  // mux: поле аутбаунда
  const muxObj = ob.mux ?? (s.muxEnabled != null ? { enabled: s.muxEnabled } : undefined)

  // freedom: доменная стратегия может задаваться и в settings, и в streamSettings.sockopt
  const isFreedom = ob.protocol === 'freedom'
  const domainStrategy = isFreedom && s.domainStrategy ? String(s.domainStrategy) : undefined
  const sockoptDomainStrategy = isFreedom && stream.sockopt?.domainStrategy ? String(stream.sockopt.domainStrategy) : undefined

  // hysteria: метод управления перегрузкой QUIC живёт в streamSettings.finalmask.quicParams
  const isHysteria = ob.protocol === 'hysteria'
  const congestion = isHysteria && stream.finalmask?.quicParams?.congestion ? String(stream.finalmask.quicParams.congestion) : undefined
  const version = ob.hysteriaSettings?.version ?? stream.hysteriaSettings?.version ?? s.version
  const protocolLabel = isHysteria && version === 2 ? 'Hysteria2' : undefined

  return {
    protocol: String(ob.protocol ?? 'unknown'),
    protocolLabel,
    address: address != null && address !== '' ? String(address) : undefined,
    port: port != null && port !== '' ? (Number.isFinite(+port) ? +port : String(port)) : undefined,
    network: stream.network ? String(stream.network) : undefined,
    security,
    sni: sni ? String(sni) : undefined,
    fingerprint: fingerprint ? String(fingerprint) : undefined,
    flow: s.flow ? String(s.flow) : undefined,
    domainStrategy,
    sockoptDomainStrategy,
    alpn: alpn as string[] | undefined,
    muxEnabled: muxObj?.enabled === true,
    congestion,
  }
}

export function delayColor(delay: number | null): string {
  if (!delay) return 'text-red-400'
  if (delay < 300) return 'text-green-400'
  if (delay < 600) return 'text-yellow-300'
  return 'text-red-400'
}

/** host:port with IPv6 brackets; '—' when unknown. */
export function endpoint(meta: OutboundMeta): string {
  if (!meta.address) return '—'
  const host = meta.address.includes(':') ? `[${meta.address}]` : meta.address
  return meta.port != null ? `${host}:${meta.port}` : host
}

/** Short transport line like "tcp · reality · example.com". */
export function transportLine(meta: OutboundMeta): string {
  return [meta.network ?? 'tcp', meta.security && meta.security !== 'none' ? meta.security : null, meta.sni].filter(Boolean).join(' · ')
}
