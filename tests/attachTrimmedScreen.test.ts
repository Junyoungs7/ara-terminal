// 2.2.22 준영님 제보 — "하단바가 사라지는데 전체화면을 풀면 다시 그려서 보여준다"(스크린숏: Claude 칸 아래쪽 줄이 비고 바뀌는 숫자만 남음).
//
// 실앱 순서를 그대로 밟는다: pty 출력 → MainSessionManager(16ms 배치 → 256KB 링) → 탭 재마운트(작업 단위·레일 화면 전환) → attach 재생.
// Claude 같은 차분 그리기 TUI 는 처음 한 번만 전체를 그리고 그 뒤로는 바뀐 칸만 커서 이동으로 고쳐 쓴다. 링이 앞을 버린 뒤 그대로
// 재생하면 처음 그림(테두리·라벨)과 모드 켜기(괄호 붙여넣기)가 빠진다. 고치기 전 이 시험은 화면 29줄 중 대부분이 달라 실패했다.
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import type { SessionSink } from '../src/main/sessions/ISessionManager'
import type { SessionBackend } from '../src/main/sessions/SessionBackend'

const COLS = 100
const ROWS = 20
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const cup = (r: number, c: number): string => `\x1b[${r};${c}H`

function rig() {
  let emit: (s: string) => void = () => {}
  const sink: SessionSink = { data() {}, exit() {}, cwd() {} }
  const mgr = new MainSessionManager(sink)
  const backend: SessionBackend = {
    write() {},
    resize() {},
    pause() {},
    resume() {},
    kill() {},
    onData(cb) {
      emit = cb
    },
    onExit() {}
  }
  const id = mgr.adopt(backend, { type: 'local', title: 't', serverKey: 'local', profileId: null, cwd: undefined, shell: undefined, cols: COLS, rows: ROWS }, 'tui')
  return { mgr, id, emit: (s: string) => emit(s) }
}

const fresh = (): Terminal => {
  const t = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
  t.loadAddon(new Unicode11Addon())
  t.unicode.activeVersion = '11'
  return t
}
const W = (t: Terminal, d: string | Uint8Array): Promise<void> => new Promise((r) => t.write(d, r))
const rows = (t: Terminal): string[] => {
  const b = t.buffer.active
  return Array.from({ length: t.rows }, (_, y) => b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
}

describe('2.2.22 잘린 재생 버퍼 — 아래쪽 줄 사라짐', () => {
  it('★ 링이 잘린 뒤 다시 붙어도 화면(테두리·라벨)과 괄호 붙여넣기 모드가 그대로다', async () => {
    const { mgr, id, emit } = rig()
    const live = fresh()
    const send = async (s: string): Promise<void> => {
      emit(s)
      await W(live, s)
      await sleep(20) // 16ms 배치 flush
    }
    // 처음 한 번 전체 그리기(Claude 시작)
    await send('\x1b[?2004h')
    for (let i = 0; i < 30; i++) await send(`지난 출력 ${i}\r\n`)
    await send(cup(ROWS - 5, 1) + '\x1b[2K' + '─'.repeat(COLS))
    await send(cup(ROWS - 4, 1) + '\x1b[2K> 그리고 아라 2버전에서 사용하다보면')
    await send(cup(ROWS - 3, 1) + '\x1b[2K' + '─'.repeat(COLS))
    await send(cup(ROWS - 2, 1) + '\x1b[2K5h:[##--]3%(4h00m) wk:[########--]76% | session:148000m | ctx:[####------]36%')
    await send(cup(ROWS, 1) + '\x1b[2K✻ Syntax-checking changed R3 mod files… (23m 00s · ↓ 00.5k tokens)')
    // 그 뒤로는 바뀐 숫자만(동기 출력으로 감싼 차분 프레임) — 링(256KB)을 넘을 때까지
    const frames: string[] = []
    for (let n = 1, total = 0; total < 300 * 1024; n++) {
      const s = `\x1b[?2026h${cup(ROWS - 2, 15)}${String(n % 60).padStart(2, '0')}${cup(ROWS - 2, 58)}${148000 + n}${cup(ROWS, 47)}${String(n % 60).padStart(2, '0')}${cup(ROWS - 4, 22)}\x1b[?2026l`
      frames.push(s)
      total += Buffer.byteLength(s)
    }
    // 한 번에 64KB 씩(실앱의 배치 상한과 같은 크기)
    for (let i = 0; i < frames.length; i += 500) await send(frames.slice(i, i + 500).join(''))

    const back = fresh()
    await W(back, mgr.attach(id))
    expect(rows(back)).toEqual(rows(live))
    expect(rows(back)[ROWS - 6]).toBe('─'.repeat(COLS))
    expect(back.modes.bracketedPasteMode).toBe(true)
    expect(back.buffer.active.cursorY).toBe(live.buffer.active.cursorY)
    expect(back.buffer.active.cursorX).toBe(live.buffer.active.cursorX)
  })

  it('링이 안 잘렸으면 원래 출력을 그대로 돌려준다(스크롤백까지 바이트 그대로)', async () => {
    const { mgr, id, emit } = rig()
    emit('hello\r\n')
    await sleep(20)
    expect(Buffer.from(mgr.attach(id)).toString('utf8')).toBe('hello\r\n')
  })
})
