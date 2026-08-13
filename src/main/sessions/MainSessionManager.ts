// MainSessionManager — main 프로세스 세션 (계획서 §B.7, MVP 구현체).
// 로컬(node-pty)과 원격(ssh2 shell)을 동일 SessionBackend 파이프라인에 태운다(별도 경로 금지, §C F3).
// 백프레셔(계획서 §B.2): (1) 바이트 버짓 배칭 64KB/16ms, (2) pause/resume, (3) Uint8Array는 IPC 레이어에서 transfer.
import { randomUUID } from 'node:crypto'
import type { Client } from 'ssh2'
import type { ISessionManager, SessionSink, SessionSpec } from './ISessionManager'
import type { SessionBackend } from './SessionBackend'
import { PtyBackend } from './PtyBackend'
import { SshBackend } from './ssh/SshBackend'
import { parseOsc7Cwd } from './osc7'
import type { Session } from '@shared/types'

// 백프레셔 메커니즘 1: flush당 상한 바이트. 초과 시 즉시 flush.
const FLUSH_BYTE_BUDGET = 64 * 1024
// flush 타이밍 상한(~60fps 프레임 정렬). 백프레셔 해결책 자체는 아님(계획서 §B.2).
const FLUSH_INTERVAL_MS = 16
// 세션당 재생 버퍼 상한. renderer 가 xterm 을 새로 만들 때(세션 전환·재마운트·부트 복원) 이만큼을 되감아 준다.
const BACKLOG_LIMIT = 256 * 1024

// conpty 는 세션이 열리는 즉시 셸 실행 파일 경로를 OSC 제목으로 보낸다(C:\WINDOWS\SYSTEM32\cmd.exe).
// 그대로 받으면 로컬 탭이 전부 같은 이름이 돼 "셸 1 / 셸 2" 구분(R2.1)이 통째로 무너진다.
// 실행 파일 경로처럼 보이는 제목만 걸러 낸다 — 셸이 의도적으로 세운 제목(deploy@web-01: ~/svc)은 통과.
const SHELL_PATH_TITLE = /(?:^|[\\/])[^\\/\s]+\.exe$/i
export function isShellPathTitle(title: string): boolean {
  return SHELL_PATH_TITLE.test(title.trim())
}

type Handle = {
  backend: SessionBackend
  meta: Session
  buf: Uint8Array[]
  bufBytes: number
  timer: NodeJS.Timeout | null
  paused: boolean
  // 재생 버퍼(링) — flush 된 청크를 상한까지 보관한다.
  backlog: Uint8Array[]
  backlogBytes: number
  // attach 전 출력은 링버퍼에만 쌓고 내보내지 않는다. 구독자가 없는 시점의 출력(adopt 직후·부트 복원 중)이
  // 유실되던 경로를 없앤다 — renderer 는 xterm 을 만든 뒤 attach 로 한 번에 받아 간다.
  attached: boolean
  // F30: 이 세션에서 마지막으로 출력이 온 시각(epoch ms). "AI 가 조용하다"의 유일한 근거다.
  //
  // 왜 main 이 들고 있나: 화면에 안 보이는 탭은 attached 가 false 라 renderer 로 데이터가 안 나간다
  // (flush 의 `if (h.attached)`). 그런데 **조용한지 알고 싶은 건 정확히 그 안 보이는 탭들**이다.
  // 그래서 renderer 가 셀 수 없고 여기서 세야 한다.
  lastDataAt: number
}

// F12 세션 로그 tee. main/index.ts 가 늦게 주입한다(로거는 userData 경로를 알아야 만들 수 있다).
type SessionLogTee = { write(meta: Session, chunk: Uint8Array): void; close(sessionId: string): void }

export class MainSessionManager implements ISessionManager {
  private readonly handles = new Map<string, Handle>()
  private log: SessionLogTee | null = null

  constructor(private readonly sink: SessionSink) {}

  // F12: 출력 스트림 tee. null 이면 아무 일도 일어나지 않는다(기록 off 는 로거 내부에서도 한 번 더 막는다).
  setLog(log: SessionLogTee | null): void {
    this.log = log
  }

  async create(spec: SessionSpec): Promise<string> {
    // 로컬만 여기서 스폰. SSH는 연결(호스트키·vault)을 IPC 레이어가 처리 후 adopt()로 넘긴다.
    const backend = new PtyBackend(spec)
    const meta: Session = {
      id: randomUUID(),
      type: spec.type,
      shell: spec.shell,
      profileId: spec.profileId ?? null,
      cwd: spec.cwd,
      title: spec.title,
      serverKey: spec.serverKey,
      manualTitle: spec.manualTitle
    }
    this.register(backend, meta)
    return meta.id
  }

  // 외부에서 준비한 백엔드(예: 연결된 SshBackend)를 세션으로 편입. 로컬과 동일 파이프라인.
  adopt(backend: SessionBackend, meta: Omit<Session, 'id'>): string {
    const full: Session = { id: randomUUID(), ...meta }
    this.register(backend, full)
    return full.id
  }

  // 백엔드를 세션 핸들로 편입하고 스트림을 건다(로컬 create / SSH adopt 공통).
  private register(backend: SessionBackend, meta: Session): void {
    const id = meta.id
    const h: Handle = {
      backend,
      meta,
      buf: [],
      bufBytes: 0,
      timer: null,
      paused: false,
      backlog: [],
      backlogBytes: 0,
      attached: false,
      // 방금 만들었으니 그 시각부터 센다 — 0 으로 두면 "1970년부터 조용함"이 된다.
      lastDataAt: Date.now()
    }
    this.handles.set(id, h)
    backend.onData((data) => this.enqueue(id, data))
    // SSH 는 셸 출력이 아니라 /proc 에서 cwd 를 읽어 온다(remoteCwd.ts) — 도착 경로만 다르고
    // 그 뒤 처리는 OSC7 과 같다.
    backend.onCwd?.((cwd) => {
      const cur = this.handles.get(id)
      if (!cur || cwd === cur.meta.cwd) return
      cur.meta.cwd = cwd
      this.sink.cwd(id, cwd)
    })
    backend.onExit((exitCode, signal) => {
      this.flush(id) // 종료 전 잔여 출력 방출
      this.log?.close(id) // 남은 꼬리를 흘려보내고 파일을 닫는다
      this.handles.delete(id)
      this.sink.exit(id, exitCode, signal)
    })
  }

  private enqueue(id: string, data: string): void {
    const h = this.handles.get(id)
    if (!h) return
    // CWD 추적(F6 MS-3): 셸이 방출한 OSC7(file://host/path)에서 작업 디렉토리를 갱신.
    // 로컬은 셸 통합 주입으로 확보, 원격은 OSC7 방출 셸이면 best-effort. 파싱 실패 시 cwd 유지.
    // F7: cwd 가 실제로 바뀐 경우에만 알림(터미널→SFTP 트리 자동 이동).
    const cwd = parseOsc7Cwd(data)
    if (cwd && cwd !== h.meta.cwd) {
      h.meta.cwd = cwd
      this.sink.cwd(id, cwd)
    }
    h.lastDataAt = Date.now()
    const bytes = Buffer.from(data, 'utf8')
    h.buf.push(bytes)
    h.bufBytes += bytes.length
    if (h.bufBytes >= FLUSH_BYTE_BUDGET) {
      this.flush(id)
    } else if (!h.timer) {
      h.timer = setTimeout(() => this.flush(id), FLUSH_INTERVAL_MS)
    }
  }

  private flush(id: string): void {
    const h = this.handles.get(id)
    if (!h) return
    if (h.timer) {
      clearTimeout(h.timer)
      h.timer = null
    }
    if (h.buf.length === 0) return
    const merged = h.buf.length === 1 ? h.buf[0] : Buffer.concat(h.buf, h.bufBytes)
    h.buf = []
    h.bufBytes = 0
    // 새 ArrayBuffer로 복사해 transfer 가능하게 함(Buffer는 공유 풀 슬라이스일 수 있음).
    const out = new Uint8Array(merged.length)
    out.set(merged)
    this.remember(h, out)
    // F12: 링버퍼에 넣는 바로 그 자리에 tee. attached 여부와 무관하게 기록한다
    // (부팅 복원 중 출력도 남아야 "작업 내역"이 된다).
    this.log?.write(h.meta, out)
    if (h.attached) this.sink.data(id, out)
  }

  // 재생 버퍼 적재 + 상한 초과분을 앞에서 버린다(청크 단위 트림 — 바이트 정밀 절단은 불필요).
  private remember(h: Handle, chunk: Uint8Array): void {
    h.backlog.push(chunk)
    h.backlogBytes += chunk.length
    while (h.backlogBytes > BACKLOG_LIMIT && h.backlog.length > 1) {
      h.backlogBytes -= h.backlog.shift()!.length
    }
  }

  // renderer 가 xterm 을 만든 직후 호출한다. 지금까지의 출력을 한 덩어리로 돌려주고 라이브 스트림을 연다.
  // 같은 세션에 다시 attach 하면(세션 전환으로 xterm 재생성·StrictMode 이중 마운트) 전체를 다시 재생한다.
  attach(id: string): Uint8Array {
    const h = this.handles.get(id)
    if (!h) return new Uint8Array(0)
    this.flush(id) // 대기 중인 배치까지 재생 버퍼에 반영한 뒤 스냅샷.
    h.attached = true
    return this.snapshotBacklog(h)
  }

  // F23: MCP session_read 의 읽기 전용 접근자. attach() 와 달리 attached 플래그를 건드리지 않는다
  // (구독자가 없던 세션이 나중에 렌더러에 붙어도 여전히 전체 재생을 받아야 한다) — 부수효과는
  // flush() 하나뿐이고, 그건 정상적으로도 타이머로 곧 일어날 일을 조금 앞당기는 것뿐이다.
  peek(id: string): Uint8Array {
    const h = this.handles.get(id)
    if (!h) return new Uint8Array(0)
    this.flush(id)
    return this.snapshotBacklog(h)
  }

  // F23: 세션 존재 확인(MCP 인자는 신뢰 경계 밖 — 매 호출마다 재확인 요구, 설계 §5).
  has(id: string): boolean {
    return this.handles.has(id)
  }

  private snapshotBacklog(h: Handle): Uint8Array {
    const out = new Uint8Array(h.backlogBytes)
    let off = 0
    for (const c of h.backlog) {
      out.set(c, off)
      off += c.length
    }
    return out
  }

  // 탭 이름 변경(R2.1). meta 가 스냅샷에 그대로 저장되므로 여기서 바꾸면 재시작 후에도 유지된다.
  // 사용자가 정한 이름은 manualTitle 로 표시해 셸의 OSC 제목이 덮어쓰지 못하게 한다(R3.6).
  rename(id: string, title: string): void {
    const h = this.handles.get(id)
    if (!h || !title) return
    h.meta.title = title
    h.meta.manualTitle = true
  }

  // R3.6: 셸이 보낸 OSC 0/2 제목. 사용자가 이름을 바꾼 세션은 건드리지 않는다.
  // 적용 여부를 돌려줘 렌더러 탭 라벨과 어긋나지 않게 한다.
  autoTitle(id: string, title: string): boolean {
    const h = this.handles.get(id)
    if (!h || !title || h.meta.manualTitle || isShellPathTitle(title)) return false
    h.meta.title = title
    return true
  }

  // 같은 서버로 여러 번 접속하면 탭 이름이 전부 같아 구분이 안 된다(R2.1).
  // 이미 쓰이는 이름이면 뒤에 ·2, ·3 … 을 붙인다. 닫힌 세션의 번호는 다시 쓴다(빈 자리 채움).
  nextTitle(base: string): string {
    const used = new Set([...this.handles.values()].map((h) => h.meta.title))
    if (!used.has(base)) return base
    for (let n = 2; ; n++) {
      const candidate = `${base}·${n}`
      if (!used.has(candidate)) return candidate
    }
  }

  write(id: string, data: string): void {
    this.handles.get(id)?.backend.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const h = this.handles.get(id)
    if (!h || cols < 1 || rows < 1) return
    h.backend.resize(cols, rows)
  }

  pause(id: string): void {
    const h = this.handles.get(id)
    if (!h || h.paused) return
    h.paused = true
    h.backend.pause()
  }

  resume(id: string): void {
    const h = this.handles.get(id)
    if (!h || !h.paused) return
    h.paused = false
    h.backend.resume()
  }

  destroy(id: string): void {
    const h = this.handles.get(id)
    if (!h) return
    if (h.timer) clearTimeout(h.timer)
    this.handles.delete(id)
    h.backend.kill()
  }

  snapshot(): Session[] {
    return [...this.handles.values()].map((h) => h.meta)
  }

  /**
   * F30: 세션별 마지막 출력 시각. **snapshot() 에 얹지 않는 이유** — 그쪽은 workspace.json 으로
   * 영속되는 타입이라, 매 출력마다 바뀌는 값을 넣으면 스냅샷이 늘 더럽고 복원 때 낡은 시각이 딸려온다.
   */
  activity(): { id: string; lastDataAt: number }[] {
    return [...this.handles.entries()].map(([id, h]) => ({ id, lastDataAt: h.lastDataAt }))
  }

  // F7: 세션의 ssh2 커넥션 반환(SFTP 서브시스템 재사용용). 로컬/미존재 세션은 null.
  sshClient(id: string): Client | null {
    const b = this.handles.get(id)?.backend
    return b instanceof SshBackend ? b.sshClient() : null
  }

  destroyAll(): void {
    for (const id of [...this.handles.keys()]) this.destroy(id)
  }
}
