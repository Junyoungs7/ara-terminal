// M8 DM-02·03 — 관리형 서버 한 대에 하는 일(원격): 묻기·설치·업데이트·다리 열기·제거+검증. 연결은 부르는 쪽이 준 ssh2 Client(기존 SSH 세션의 것)를 **쓰기만** 한다.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/managed-server/install/{orcad-remote-install,orcad-remote-host-support,orcad-remote-decommission}.ts,
// lifecycle/orcad-stdio-bridge-script.ts — 핵심만 다시 씀.
// 옮긴 것: 홈 아래 한 폴더 설치, 버전 표식 파일, stdio 다리(원격 소켓 ↔ exec 채널), 낮추지 않는 업데이트, 제거 뒤 남은 것 재기.
// 뺀 것: 고정 Node 런타임 배포(우리는 원격 python3 + 스크립트 하나 — 사내 서버에 node 가 없다), 활성화 트랜잭션·펜스·롤백·GC·설치 잠금,
// Windows·WSL 호스트, 판별 슬롯(버전마다 폴더 — 우리는 폴더 하나에 덮어쓴다), TCP 포트·페어링·터널.
import { randomBytes } from 'node:crypto'
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import { connectDaemonStream, type DaemonConnection } from '../daemon/client'
import { readRemoteText, writeRemoteText } from '../editor/textIO'
import { shQuote } from '../telemetry/LogTail'
import { BRIDGE_SCRIPT, FINISH_SCRIPT, MANAGED_DIR, MKDIR_SCRIPT, PROBE_SCRIPT, UNINSTALL_SCRIPT, parseProbe, remnantsOf, supportOf, type ManagedProbe } from '@shared/managedServers'
import { ORCAD_PY } from './orcadScript'

const EXEC_TIMEOUT_MS = 20_000
/** 제거는 데몬이 세션을 끝내길 기다린다(데몬 상한 3초 × 세션 + 셸 대기 10초). */
const UNINSTALL_TIMEOUT_MS = 60_000
const OUT_MAX = 256 * 1024
export const TOKEN_BYTES = 32

export type ExecResult = { code: number; out: string; err: string }

/** 원격 `sh -c '<글>'` 한 번. 시간·출력 상한이 늘 있다. stdin 은 바로 닫는다(우리 명령은 아무것도 읽지 않는다). */
export function execSh(client: Client, script: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(`sh -c ${shQuote(script)}`, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error('exec 채널을 못 열었다'))
      let out = ''
      let errOut = ''
      let code = -1
      const timer = setTimeout(() => {
        stream.close()
        reject(new Error('원격 명령 시간 초과'))
      }, timeoutMs)
      stream.on('data', (b: Buffer) => (out = (out + b.toString('utf8')).slice(-OUT_MAX)))
      stream.stderr.on('data', (b: Buffer) => (errOut = (errOut + b.toString('utf8')).slice(-OUT_MAX)))
      stream.on('exit', (c: number | null) => (code = typeof c === 'number' ? c : -1))
      stream.on('close', () => {
        clearTimeout(timer)
        resolve({ code, out, err: errOut })
      })
      stream.end()
    })
  })
}

const sftpOf = (client: Client): Promise<SFTPWrapper> => new Promise((res, rej) => client.sftp((e, s) => (e ? rej(e) : res(s))))

export async function probeHost(client: Client): Promise<ManagedProbe> {
  return parseProbe((await execSh(client, PROBE_SCRIPT)).out)
}

/**
 * 설치(또는 같은 자리 덮어쓰기 = 업데이트). 파일은 기존 SFTP 쓰기(editor/textIO)로 — 홈 기준 상대 경로. version 은 마지막에(이게 있어야 "깔렸다").
 * 토큰은 판마다 새로 — 바꾸기 전에 옛 데몬이 내려가 있어야 한다(update 는 세션이 없을 때만 — decideUpdate).
 */
export async function installHost(client: Client, appVersion: string): Promise<void> {
  const support = supportOf(await probeHost(client))
  if (!support.ok) throw new Error(`지원하지 않는 서버: ${support.reason}`)
  const mk = await execSh(client, MKDIR_SCRIPT)
  if (mk.code !== 0) throw new Error(`설치 폴더를 못 만들었다: ${mk.err.trim() || mk.code}`)
  const sftp = await sftpOf(client)
  try {
    const put = async (name: string, text: string): Promise<void> => {
      const r = await writeRemoteText(sftp, `${MANAGED_DIR}/${name}`, text, 'lf')
      if (!r.ok) throw new Error(`${name} 올리기 실패: ${r.message}`)
    }
    await put('orcad.py', ORCAD_PY)
    await put('token', randomBytes(TOKEN_BYTES).toString('hex'))
    await put('version', appVersion)
  } finally {
    sftp.end()
  }
  const fin = await execSh(client, FINISH_SCRIPT)
  if (fin.code !== 0 || !/protocol=\d+/.test(fin.out)) throw new Error(`설치 확인 실패: ${(fin.err || fin.out).trim() || fin.code}`)
}

/** 원격 데몬에 붙는다(다리 exec 채널 + 같은 NDJSON 말). 토큰은 원격 파일에서(같은 계정만 읽는다). */
export async function openBridge(client: Client): Promise<DaemonConnection> {
  const sftp = await sftpOf(client)
  let token: string
  try {
    const r = await readRemoteText(sftp, `${MANAGED_DIR}/token`)
    if (!r.ok) throw new Error(`토큰을 못 읽었다: ${r.message}`)
    token = r.text.trim()
  } finally {
    sftp.end()
  }
  const channel = await new Promise<ClientChannel>((res, rej) => client.exec(`sh -c ${shQuote(BRIDGE_SCRIPT)}`, (e, ch) => (e ? rej(e) : res(ch))))
  channel.stderr.on('data', () => {}) // 읽지 않으면 창이 차서 막힌다
  return connectDaemonStream(channel, token)
}

/** 제거 + 검증. 남은 것 목록(빈 배열 = 흔적 0). 원격 명령이 실패해도 검증 출력은 읽는다. */
export async function uninstallHost(client: Client): Promise<string[]> {
  const r = await execSh(client, UNINSTALL_SCRIPT, UNINSTALL_TIMEOUT_MS)
  return remnantsOf(r.out)
}
