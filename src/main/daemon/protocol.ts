// M4 DM-01 로컬 터미널 데몬 — 앱(main)과 데몬이 같이 쓰는 순수 규칙: 판·경로·줄 단위 프레이밍·토큰 비교·replay 버퍼·판 판정.
// 출처: stablyai/orca @7a7f46f8a3 (MIT) src/main/daemon/{daemon-protocol-version,daemon-spawner(getDaemonSocketPath·TokenPath),
// daemon-hello-protocol,ndjson}.ts, src/shared/terminal-scrollback-policy.ts — 핵심만.
// ⚠️ 이 파일은 데몬 번들(daemonEntry)에도 들어간다 — electron 을 import 하지 않는다.
import { createHash, timingSafeEqual } from 'node:crypto'
import { join, posix } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentLimits } from '@shared/resources'

/**
 * 데몬은 앱 업데이트에도 살아남는다 — 그래서 선 위의 말은 판으로 묶는다(Orca PROTOCOL_VERSION).
 * 말(메시지 모양·뜻)이 바뀔 때만 올린다. 앱 판이 바뀌어도 이 값이 같으면 살아 있는 데몬을 그대로 쓴다.
 */
export const DAEMON_PROTOCOL_VERSION = 1
/** 이 앱이 아직 말할 줄 아는 옛 판 — 그 데몬의 세션은 붙어서 쓰고, 세션이 다 끝나면 데몬이 스스로 내려간다(Orca PREVIOUS_DAEMON_PROTOCOL_VERSIONS). */
export const PREVIOUS_DAEMON_PROTOCOL_VERSIONS: readonly number[] = []

export type DaemonPaths = { socketPath: string; tokenPath: string }

/**
 * 판마다 다른 소켓 — 다른 판의 데몬과 섞이지 않는다(Orca getDaemonSocketPath). Windows 는 named pipe(이름에 runtimeDir 해시 —
 * 사용자·설치마다 다름), 그 밖은 runtimeDir 안 unix socket.
 * ponytail: unix socket 경로 길이 상한(macOS 104)을 넘으면 Orca 처럼 /tmp 짧은 경로로 옮기지 않는다 — userData 가 아주 깊을 때만 문제.
 */
export function daemonPaths(runtimeDir: string, version = DAEMON_PROTOCOL_VERSION, platform: NodeJS.Platform = process.platform): DaemonPaths {
  const socketPath =
    platform === 'win32'
      ? `\\\\?\\pipe\\ara-agent-daemon-v${version}-${createHash('sha256').update(runtimeDir).digest('hex').slice(0, 12)}`
      : posix.join(runtimeDir.replace(/\\/g, '/'), `daemon-v${version}.sock`)
  return { socketPath, tokenPath: join(runtimeDir, `daemon-v${version}.token`) }
}

/** 같은 사용자만 붙게 — 토큰 파일(사용자 폴더, 0600)을 읽을 수 있는 쪽만 맞힌다. 길이가 달라도 시간이 새지 않게 해시로 비교. */
export function tokenMatches(expected: string, got: unknown): boolean {
  if (typeof got !== 'string' || !expected) return false
  const h = (s: string): Buffer => createHash('sha256').update(s).digest()
  return timingSafeEqual(h(expected), h(got))
}

// ── 프레이밍: 줄 하나 = JSON 하나(NDJSON, Orca ndjson.ts) ──────────────────────────────────────────────
/** 줄 하나의 상한. PTY 조각은 작다(수 KB) — replay 도 조각 단위로 보내므로 큰 줄이 생기지 않는다. 넘으면 끊는다(메모리 보호). */
export const FRAME_MAX_BYTES = 8 * 1024 * 1024

export function encodeFrame(msg: unknown): string {
  return JSON.stringify(msg) + '\n'
}

/** 조각난 바이트 흐름에서 줄을 모아 JSON 으로 돌려준다. 깨진 줄은 건너뛴다. 상한을 넘으면 onOverflow(그 연결을 끊으라는 뜻). */
export function createFrameParser(onMessage: (msg: unknown) => void, onOverflow: () => void = () => {}, max = FRAME_MAX_BYTES): (chunk: Buffer | string) => void {
  let pending = ''
  // 소켓 조각 경계에 걸린 한글(UTF-8 여러 바이트)을 깨지 않게 — 남은 바이트는 디코더가 다음 조각까지 들고 있는다.
  const dec = new StringDecoder('utf8')
  return (chunk) => {
    pending += typeof chunk === 'string' ? chunk : dec.write(chunk)
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (!line.trim()) continue
      try {
        onMessage(JSON.parse(line))
      } catch {
        // 깨진 줄은 아무 말도 안 한 것.
      }
    }
    if (pending.length > max) {
      pending = ''
      onOverflow()
    }
  }
}

// ── replay 버퍼(Orca 크기 규칙) ────────────────────────────────────────────────────────────────────
/**
 * Orca terminal-scrollback-policy: 백로그 상한 = max(2 MiB 글자, 스크롤백 줄 × 120 글자). 기본 스크롤백 5,000 줄이면 2 MiB.
 * ponytail: Orca 는 헤드리스 에뮬레이터 화면을 직렬화해 돌려준다(이스케이프가 잘리지 않음). 우리는 원래 출력 조각을 링으로 — 앞이 잘린 첫 조각은
 * 이스케이프 중간일 수 있다(아라 MainSessionManager backlog 와 같은 한계). 화면 깨짐이 잦으면 @xterm/headless 직렬화로.
 */
export const REPLAY_MIN_CAP_CHARS = 2 * 1024 * 1024
export const REPLAY_CHARS_PER_ROW = 120
export const REPLAY_SCROLLBACK_ROWS = 5_000
export const replayCapChars = (rows = REPLAY_SCROLLBACK_ROWS): number => Math.max(REPLAY_MIN_CAP_CHARS, rows * REPLAY_CHARS_PER_ROW)

export class ReplayBuffer {
  private chunks: string[] = []
  private size = 0
  constructor(private readonly cap = replayCapChars()) {}
  push(s: string): void {
    if (!s) return
    this.chunks.push(s)
    this.size += s.length
    // 조각 단위로 앞에서 버린다. 마지막 조각 하나는 상한을 넘어도 끝부분만 남긴다(한 조각이 상한보다 클 때).
    while (this.size > this.cap && this.chunks.length > 1) this.size -= this.chunks.shift()!.length
    if (this.size > this.cap) {
      this.chunks[0] = this.chunks[0].slice(this.size - this.cap)
      this.size = this.cap
    }
  }
  snapshot(): string[] {
    return [...this.chunks]
  }
  get chars(): number {
    return this.size
  }
}

// ── 판 판정 ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * 찾은 데몬을 어떻게 할까(Orca 규칙):
 * - `adopt`: 같은 판 — 앱 판이 달라도 그대로 쓴다(새 세션도 거기서).
 * - `drain`: 이 앱이 아는 옛 판 — 그 세션은 이어 붙여 쓰고 새 세션은 새 데몬에서. 세션이 다 끝나면 옛 데몬은 스스로 내려간다(교체).
 * - `ignore`: 모르는 판(새 앱이 띄운 데몬을 옛 앱이 만남 등) — 건드리지 않는다.
 */
export type DaemonVerdict = 'adopt' | 'drain' | 'ignore'
export function judgeDaemon(protocol: number, current = DAEMON_PROTOCOL_VERSION, previous: readonly number[] = PREVIOUS_DAEMON_PROTOCOL_VERSIONS): DaemonVerdict {
  if (protocol === current) return 'adopt'
  return previous.includes(protocol) ? 'drain' : 'ignore'
}

// ── 메시지 ──────────────────────────────────────────────────────────────────────────────────────────
/** 세션을 만들 때 앱이 싣는 것. env 는 앱의 환경 전체(데몬 환경은 띄운 순간에 굳어 PATH 갱신 등을 놓친다). meta 는 데몬이 읽지 않고 그대로 돌려준다(탭 복원용). */
/**
 * M11 R2: space 'terminal' = 터미널 공간 로컬 셸(에이전트 탭 표식 ARA_PANE_KEY 를 안 넣는다), shell = 그 탭이 고른 셸. 없으면 에이전트 셸(1차 그대로).
 * 덧붙인 선택 필드라 판(protocol)은 그대로다 — v1 데몬은 아직 배포 전(v2.2)이라 이것을 모르는 데몬이 사용자 PC 에 없다.
 */
export type DaemonCreateSpec = { id: string; cwd: string; cols?: number; rows?: number; env: Record<string, string>; meta: Record<string, unknown>; space?: 'terminal'; shell?: string; shellArgs?: string[] }
/** viewers: 원격(orcad) 만 — 지금 이 세션에 붙은 PC 이름들(R1 다른 PC 에서 이어 보기). 로컬 데몬은 안 채운다. */
/** status: 원격(orcad) 만 — R2 서버가 훅으로 들은 그 세션의 마지막 상태(늦게 붙은 PC 도 받는다). */
export type DaemonHookStatus = { source: string; payload: Record<string, unknown>; at: number }
export type DaemonSessionInfo = { id: string; pid: number; cwd: string; cols: number; rows: number; meta: Record<string, unknown>; viewers?: string[]; status?: DaemonHookStatus }

export type DaemonHello = { type: 'hello'; protocol: number; token: string }
/** hookDir: R2 orcad 만 — 설치 폴더(절대 경로, 훅 설정 파일이 있는 곳). 옛 orcad 는 안 준다 = 서버 상태 판정 없음. */
export type DaemonHelloReply = { type: 'hello'; ok: boolean; protocol: number; pid: number; appVersion?: string; error?: string; hookDir?: string }

/** 요청(앱 → 데몬). rid 로 답을 짝짓는다 — rid 0 은 답이 필요 없는 것(write·resize, 키 하나마다 답을 받지 않는다). */
export type DaemonRequest =
  | { rid: number; type: 'create'; spec: DaemonCreateSpec }
  | { rid: number; type: 'list' }
  /** pc: 원격(orcad) 만 — 붙는 PC 의 이름(다른 PC 에 "누가 보는 중"으로 보인다). */
  | { rid: number; type: 'attach'; id: string; pc?: string }
  /** 원격(orcad) R1 — 이 PC 에서만 닫기(세션은 서버에 산다)·meta 덧쓰기(제목 등, null = 지움). 옛 orcad 는 '모르는 요청'으로 답한다. */
  | { rid: number; type: 'detach'; id: string }
  | { rid: number; type: 'meta'; id: string; meta: Record<string, unknown> }
  | { rid: number; type: 'kill'; id: string }
  | { rid: number; type: 'killAll' }
  | { rid: number; type: 'shutdown' }
  | { rid: number; type: 'write'; id: string; data: string }
  | { rid: number; type: 'resize'; id: string; cols: number; rows: number }
  /**
   * M4 R3 자원 상한(데몬 전체에 하나 — 설정 › 에이전트). 붙자마자·설정이 바뀔 때 앱이 보낸다. 우선순위는 그 뒤 만드는 세션부터,
   * 메모리 상한은 바로. 덧붙인 요청이라 판(protocol)은 그대로다 — 이것을 모르는 옛 데몬은 '모르는 요청'으로 답하고 앱은 넘어간다.
   */
  | { rid: number; type: 'limits'; limits: AgentLimits }

/** 데몬 → 앱: 답(rid) 또는 사건(data·exit). */
export type DaemonReply = { type: 'reply'; rid: number; ok: boolean; error?: string; result?: unknown }
export type DaemonEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; code: number; signal?: number }
  /** 그 세션 트리의 작업 세트가 상한을 넘었다(넘어설 때 한 번 — overMemory). 붙은 앱 모두에게. */
  | { type: 'memoryOver'; id: string; memory: number; limit: number }
  /** 원격(orcad) R1 — 그 세션에 붙은 PC 가 바뀌었다 · meta 가 바뀌었다(붙은 쪽 모두에게). */
  | { type: 'viewers'; id: string; viewers: string[] }
  | { type: 'meta'; id: string; meta: Record<string, unknown> }
  | ({ type: 'status'; id: string } & DaemonHookStatus)
