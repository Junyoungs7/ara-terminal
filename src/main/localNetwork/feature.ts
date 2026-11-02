// M15 R2 TM-04 macOS 로컬 네트워크 복구 — 맥에서만 뜻이 있다(Windows·리눅스는 'unsupported' 만 돌려준다).
// 출처: stablyai/orca @ec112c6b01 (MIT) src/main/ipc/developer-permissions.ts(local-network 몫: 권한 묻기 = mDNS 멀티캐스트 한 번,
// 시스템 설정 › 개인정보 보호 › 로컬 네트워크 열기)·src/main/ipc/local-network-connection-test.ts(같은 망 기기에 TCP 연결 시험 — 자식 프로세스).
// 왜: macOS 15+ 는 앱마다 "로컬 네트워크" 권한을 따로 받는데, 아라가 띄운 셸·ssh 가 같은 망 서버(192.168…)에 못 붙고 상태도 알려 주지 않는다.
// 뺀 것: 나머지 개발자 권한(카메라·손쉬운 사용 등), 데몬 launchd 귀속(아라 데몬은 launchd 로 안 띄운다), 마지막 성공 기억(localStorage).
import dgram from 'node:dgram'
import { isIP } from 'node:net'
import { shell } from 'electron'
import { handle } from '../ipc/handle'
import { runProcess, type RunResult } from '../util/runProcess'
import type { LocalNetworkTestResult } from '@shared/localNetwork'

const LOCAL_NETWORK_PANE = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork'
const CONNECT_TIMEOUT_MS = 4_000

// 자식(Electron 을 node 로)이 연결한다 — 권한 판정이 터미널 도구(아라가 띄운 자식)와 같은 길이 되게(Orca 와 같은 이유).
const CONNECT_SCRIPT = `
const net = require('node:net')
const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) })
let settled = false
function finish(code) { if (settled) return; settled = true; if (code) { process.stderr.write(code); process.exitCode = 1 } socket.destroy() }
function isLan(a) {
  const n = (a || '').toLowerCase().split('%', 1)[0]
  const v4 = (n.match(/^::ffff:(\\d{1,3}(?:\\.\\d{1,3}){3})$/) || [])[1] || (net.isIP(n) === 4 ? n : null)
  if (v4) { const o = v4.split('.').map(Number); return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254) }
  if (net.isIP(n) === 6) { const f = Number.parseInt(n.split(':')[0], 16); return (f & 0xfe00) === 0xfc00 || (f & 0xffc0) === 0xfe80 }
  return false
}
socket.setTimeout(${CONNECT_TIMEOUT_MS})
socket.once('connect', () => finish(isLan(socket.remoteAddress) ? undefined : 'INVALID_TARGET'))
socket.once('timeout', () => finish('ETIMEDOUT'))
socket.once('error', (e) => finish(e.code || 'FAILED'))
`

/** 사설·링크 로컬 IPv4/IPv6 인가(Orca classifyRemotePairingHostname 의 'lan' 몫). */
function isLanIp(addr: string): boolean {
  if (isIP(addr) === 4) {
    const o = addr.split('.').map(Number)
    return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254)
  }
  if (isIP(addr) === 6) {
    const f = Number.parseInt(addr.split(':')[0] || '0', 16)
    return (f & 0xfe00) === 0xfc00 || (f & 0xffc0) === 0xfe80
  }
  return false
}

/** 시험 대상 호스트 — 인자 주입(`-` 시작)·URL·공백을 막고, IP 면 사설 대역만(호스트 이름은 자식이 붙은 뒤 주소로 다시 본다). */
export function normalizeTargetHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const host = raw.trim().replace(/^\[|\]$/g, '')
  if (!host || host.startsWith('-') || host.length > 253 || /[\s/\\]/.test(host) || host.includes('://') || !/^[a-z0-9.:%_-]+$/i.test(host)) return null
  const bare = host.split('%', 1)[0] ?? host
  if (isIP(bare) === 0) return host.toLowerCase() === 'localhost' ? null : host
  return isLanIp(bare) ? host : null
}

export function normalizeTargetPort(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 65_535 ? raw : null
}

function failureOf(r: RunResult): NonNullable<LocalNetworkTestResult['failure']> {
  if ((r.error as { killed?: boolean } | null)?.killed) return 'timeout'
  switch (r.stderr.trim().split(/\s/, 1)[0]) {
    case 'INVALID_TARGET':
      return 'invalid-target'
    case 'ETIMEDOUT':
      return 'timeout'
    case 'ECONNREFUSED':
      return 'refused'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'unreachable'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'unresolved'
    default:
      return 'failed'
  }
}

export async function testLocalNetwork(
  args: { host?: unknown; port?: unknown },
  o: { platform?: NodeJS.Platform; run?: typeof runProcess } = {}
): Promise<LocalNetworkTestResult> {
  const host = normalizeTargetHost(args.host)
  const port = normalizeTargetPort(args.port)
  if (!host || !port) return { ok: false, failure: 'invalid-target' }
  if ((o.platform ?? process.platform) !== 'darwin') return { ok: false, failure: 'unsupported' }
  const r = await (o.run ?? runProcess)(process.execPath, ['-e', CONNECT_SCRIPT, host, String(port)], {
    env: { ELECTRON_RUN_AS_NODE: '1' },
    timeoutMs: CONNECT_TIMEOUT_MS + 1_000,
    maxBuffer: 1024
  })
  return r.code === 0 && !r.error ? { ok: true } : { ok: false, failure: failureOf(r) }
}

/** macOS 는 앱이 로컬 망에 처음 보낼 때 권한 창을 띄운다 — mDNS 주소로 1바이트(Orca triggerLocalNetworkPrompt). 1초 안에 끝난다. */
function triggerLocalNetworkPrompt(): Promise<void> {
  return new Promise((resolve) => {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        udp.close()
      } catch {
        /* 이미 닫힘 */
      }
      resolve()
    }
    const timer = setTimeout(finish, 1000)
    udp.on('error', finish)
    udp.bind(() => udp.send(Buffer.from([0]), 5353, '224.0.0.251', finish))
  })
}

export function registerLocalNetworkFeature(): void {
  const mac = process.platform === 'darwin'
  // 권한 창 띄우기 — 상태는 macOS 가 앱에 알려 주지 않는다(Orca 도 'unknown'). 창이 안 뜨면 [시스템 설정 열기].
  handle('localNetwork:request', async () => {
    if (!mac) return { ok: false }
    await triggerLocalNetworkPrompt()
    return { ok: true }
  })
  handle('localNetwork:openSettings', async () => {
    if (!mac) return { ok: false }
    await shell.openExternal(LOCAL_NETWORK_PANE)
    return { ok: true }
  })
  handle('localNetwork:test', (args) => testLocalNetwork(args ?? {}))
}
