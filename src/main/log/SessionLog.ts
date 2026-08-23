// F12 세션 로그 — MainSessionManager.flush 가 링버퍼에 넣는 바로 그 자리에 tee 하나를 건다.
// 새 스트림·새 훅은 없다. 기록은 attached 여부와 무관하다(부팅 복원 중 출력도 남는다).
//
// 정제 순서가 곧 보안 순서다: ANSI 제거 → 대체화면 구간 제외 → 줄 완성 → **마스킹** → 쓰기.
// 마스킹이 마지막 직전이라 원문이 파일에 잠깐도 닿지 않는다.
//
// 알려진 한계: 파일 권한은 userData 디렉토리 기본 ACL 에 의존한다(별도 권한 강화 없음).
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createMasker } from '@shared/maskSecrets'
import type { Session } from '@shared/types'

// 세션당 파일 크기 상한. 회전(.1/.2)보다 정직하고 코드가 짧다 — htop 을 켜 둔 세션이 디스크를
// 채우는 사고를 막는 게 목적이다.
export const MAX_BYTES = 20 * 1024 * 1024
export const CAP_NOTICE = `\n[A.R.A] 로그 크기 상한(20MB) 도달 — 이 세션의 기록을 중단합니다.\n`
export const ALT_NOTICE = `\n[A.R.A] 대체화면 구간 — 종료할 때까지 이 세션의 출력을 기록하지 않습니다.\n`
// 미완성 줄 꼬리의 상한. 이보다 긴 "한 줄"은 줄이 아니라 개행 없는 덤프다(미니파이 JS·base64 블롭·
// 바이너리 cat). 상한 검사는 put() 안에만 있고 put() 은 '\n' 이 있을 때만 불리므로, 이 상한이 없으면
// 원격 출력이 상한 없는 버퍼에 무제한으로 쌓여 main 프로세스가 OOM 으로 죽는다(앱 전체 + 전 세션).
export const MAX_LINE = 1024 * 1024
// 보존 스윕이 지울 수 있는 파일 이름. 우리가 만든 것만 지운다 — 사용자가 그 폴더에 넣어 둔
// 다른 파일은 건드리지 않는다.
export const LOG_NAME_RE = /^\d{8}-\d{6}_.*_[0-9a-f]{8}\.log$/
const DAY_MS = 24 * 60 * 60 * 1000
// renderer 가 ui:setPrefs 로 보내는 값은 신뢰 경계 밖이다(W2 보안 리뷰 L2) — 그대로 sweep() 의
// unlinkSync 임계값이 된다. NaN/음수/거대값은 "무제한(삭제 안 함)"으로 떨어지는 게 안전하고,
// 작은 양수(예: 1e-9)로 "거의 전부 삭제"를 유도하는 것을 막기 위해 정수로 자르고 상한을 둔다.
const MAX_RETENTION_DAYS = 3650
function clampRetention(days: number): number {
  if (!Number.isFinite(days)) return 0
  return Math.min(MAX_RETENTION_DAYS, Math.max(0, Math.trunc(days)))
}
// 시퀀스 파편을 무한히 들고 있지 않기 위한 캐리 상한(정상 CSI/OSC 는 이보다 훨씬 짧다).
const MAX_CARRY = 4096

// 파일명 조각 정제: 경로 구분자·드라이브 문자·와일드카드를 원천 제거하고 글자·숫자만 남긴다.
// 한글은 남긴다 — 프로필 이름이 한글인 환경에서 전부 `____` 가 되면 로그를 찾을 수가 없다.
export function sanitizeKey(key: string): string {
  const s = (key || 'session').replace(/[^\p{L}\p{N}._-]/gu, '_')
  return s.slice(0, 40) || 'session'
}

// YYYYMMDD-HHmmss (로컬 시각). 평면 디렉토리에서 이름순 = 시간순이 되게 한다.
export function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function logFileName(meta: Session, now = new Date()): string {
  return `${stamp(now)}_${sanitizeKey(meta.serverKey)}_${meta.id.replace(/-/g, '').slice(0, 8)}.log`
}

// ── #86(2026-08-16) 지난 세션 목록 ──────────────────────────────────────────
// 준영님: "현재 세션의 기록은 하단에서, 이전 세션 기록은 우측에서 찾을 수 있게."
//
// **새 저장소를 만들지 않았다.** 파일 이름이 이미 `날짜-시각_서버_id8.log` 라 그 폴더를 읽는
// 것만으로 목록이 나온다 — 별도 색인을 두면 파일과 어긋날 때 어느 쪽이 진실인지 정해야 한다.

export type PastLog = {
  /** 폴더 안 파일 이름. 읽기 요청이 이 값을 그대로 돌려준다(경로가 아니라 이름이다 — 탈출 금지). */
  file: string
  /** 시작 시각(epoch ms). 파일명 stamp 를 로컬 시각으로 되읽는다. */
  startedAt: number
  serverKey: string
  bytes: number
  /** 지금도 쓰이고 있는 기록(그 세션이 살아 있다). 목록에서 [진행 중]으로 갈라 보인다. */
  live?: boolean
}

/**
 * 파일 이름 → 조각(순수 — 단위 테스트 대상). 우리 규칙이 아니면 null.
 * serverKey 에 `_` 가 들어갈 수 있으므로(sanitizeKey 가 남긴다) **뒤에서부터** 가른다:
 * 마지막 `_` 뒤가 id8, 첫 `_` 앞이 stamp, 가운데가 전부 serverKey 다.
 */
export function parseLogName(name: string): { startedAt: number; serverKey: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_(.*)_[0-9a-f]{8}\.log$/.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, sec, key] = m
  // stamp 는 **로컬 시각**으로 찍었다(stamp()) — 되읽을 때도 로컬로 만들어야 시각이 안 밀린다.
  const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec))
  const ms = at.getTime()
  // 존재하지 않는 날짜(13월 등)는 Date 가 조용히 넘겨 버린다 — 되돌려 확인한다.
  if (!Number.isFinite(ms) || at.getMonth() !== Number(mo) - 1 || at.getDate() !== Number(d)) return null
  return { startedAt: ms, serverKey: key }
}

// ── ANSI 스트리핑(스트리밍) ──
// 청크가 시퀀스 중간에서 잘릴 수 있으므로 미완성 꼬리를 캐리한다.
// 대체화면(`\x1b[?1049h` ~ `l`) 구간은 통째로 버린다 — htop·vim·less 의 초당 수십 회 전체
// 재그리기가 로그의 90% 를 차지하는 것을 상태 플래그 하나로 막는다.
// entered: 이 청크에서 대체화면 진입 시퀀스를 봤다(기록자가 누락 표식을 남기고 소비한다).
// 진입/종료가 한 청크 안에서 끝나도 서야 한다 — 안 그러면 `\e[?1049h…\e[?1049l` 를 한 번에 써서
// 표식 없이 활동을 숨길 수 있다.
/**
 * 스트립 상태. `line`·`col` 이 **지금 그려지고 있는 한 줄**이다 — 2026-08-23 에 들어왔다.
 * (그전에는 글자를 그냥 이어 붙였다. 왜 그것으로 부족했는지는 stripAnsi 머리주석 참고.)
 */
export type StripState = { carry: string; alt: boolean; entered: boolean; line: string[]; col: number }
export const newStripState = (): StripState => ({ carry: '', alt: false, entered: false, line: [], col: 0 })

/** 아직 개행이 안 온 줄 — 세션을 닫을 때 이것도 흘려보내야 마지막 줄이 안 사라진다. */
export const pendingLine = (st: StripState): string => st.line.join('')

// 반복 상한을 둔다: 원격 출력은 신뢰 경계 밖이라 종료 문자 없는 `\x1b]` 를 잔뜩 보내면
// 무제한 lazy 스캔이 매 위치마다 버퍼 끝까지 훑어 O(n²) 가 된다. 정상 시퀀스는 이 상한보다 훨씬 짧다.
const CSI = /^\x1b\[[0-?]{0,32}[ -/]{0,8}[@-~]/
const OSC = /^\x1b\][\s\S]{0,4096}?(?:\x07|\x1b\\)/
const ALT_ON = /^\x1b\[\?(?:1049|1047|47)h$/
const ALT_OFF = /^\x1b\[\?(?:1049|1047|47)l$/

/**
 * 줄 지우기·줄 안 커서 이동 — **셸이 명령행을 다시 그릴 때 쓰는 것들**.
 */
const EL = /^\x1b\[([0-2]?)K$/ // Erase in Line: 0=커서~끝, 1=처음~커서, 2=줄 전체
const CHA = /^\x1b\[([0-9]*)G$/ // Cursor Horizontal Absolute — 줄 안 절대 열 이동
const CUF = /^\x1b\[([0-9]*)C$/ // 커서 오른쪽
const CUB = /^\x1b\[([0-9]*)D$/ // 커서 왼쪽

/** 한 줄이 이만큼 길어지면 개행 없는 덤프로 보고 흘려보낸다(힙 상한 — MAX_LINE 과 같은 뜻). */
const LINE_CELLS = MAX_LINE

/**
 * 터미널 출력 → 기록할 텍스트.
 *
 * **한 줄을 셀 배열로 들고 커서 열을 추적한다.** 2026-08-23 준영님 제보 4번이 이 구조를 요구했다:
 * ```
 * jun@kvt:~/data$ ls - cd data/omo
 * ```
 * 서로 다른 두 명령이 한 줄에 섞였다. 그전 방식은 글자를 **이어 붙이고** 몇몇 시퀀스만 특별
 * 취급했는데(백스페이스·EL·CHA), 셸이 줄을 다시 그릴 때 하는 일은 이어 붙이기가 아니라
 * **덮어쓰기**다 — 커서를 앞으로 보내고 그 자리부터 다시 쓴다. 열을 모르면 그 덮어쓰기가 전부
 * 뒤에 붙어 두 명령이 한 줄에 남는다. 8/22 에 백스페이스만 고쳤을 때 제보가 다시 온 이유가 그것이다.
 *
 * 그래서 이제 화면이 하는 그대로 한다: 셀에 쓰고, 커서를 움직이고, 지우라면 지운다. 완전한
 * 에뮬레이터는 아니다(줄 넘김·스크롤·탭 정지는 안 본다) — **한 줄 안에서** 벌어지는 재그리기만
 * 정확히 재현하면 이 문제는 사라진다.
 *
 * 돌려주는 것은 **완성된 줄들**(개행 포함)이고, 아직 안 끝난 줄은 상태에 남는다(pendingLine).
 */
export function stripAnsi(text: string, st: StripState): string {
  const s = st.carry + text
  st.carry = ''
  let out = ''
  let i = 0

  const write = (ch: string): void => {
    // 커서가 줄 끝보다 뒤면 그 사이를 공백으로 채운다(터미널이 하는 그대로).
    while (st.line.length < st.col) st.line.push(' ')
    st.line[st.col] = ch
    st.col += 1
  }
  const endLine = (): void => {
    out += st.line.join('') + '\n'
    st.line = []
    st.col = 0
  }

  while (i < s.length) {
    const c = s[i]
    if (c !== '\x1b') {
      if (!st.alt) {
        if (c === '\n') endLine()
        else if (c === '\r') st.col = 0
        else if (c === '\b') st.col = Math.max(0, st.col - 1)
        else write(c)
        // 개행 없이 한 줄이 무한정 길어지는 출력(미니파이 JS·base64)도 여기서 끊는다.
        if (st.line.length > LINE_CELLS) endLine()
      }
      i++
      continue
    }
    const rest = s.slice(i)
    const csi = CSI.exec(rest)
    if (csi) {
      if (ALT_ON.test(csi[0])) st.alt = st.entered = true
      else if (ALT_OFF.test(csi[0])) st.alt = false
      else if (!st.alt) {
        const el = EL.exec(csi[0])
        const cha = CHA.exec(csi[0])
        const cuf = CUF.exec(csi[0])
        const cub = CUB.exec(csi[0])
        if (el) {
          // 0(기본) = 커서부터 끝까지. **이것이 8/22 까지 no-op 이었다** — 순차 출력만 생각하면
          // 커서 뒤에 아무것도 없지만, \r 로 앞에 돌아간 뒤라면 옛 글자가 그대로 남아 있다.
          if (el[1] === '' || el[1] === '0') st.line.length = Math.min(st.line.length, st.col)
          else if (el[1] === '1') for (let k = 0; k < st.col; k++) st.line[k] = ' '
          else st.line = []
        } else if (cha) st.col = Math.max(0, (parseInt(cha[1] || '1', 10) || 1) - 1)
        else if (cuf) st.col += parseInt(cuf[1] || '1', 10) || 1
        else if (cub) st.col = Math.max(0, st.col - (parseInt(cub[1] || '1', 10) || 1))
      }
      i += csi[0].length
      continue
    }
    const osc = OSC.exec(rest)
    if (osc) {
      i += osc[0].length
      continue
    }
    // 미완성 시퀀스 — 다음 청크와 이어 붙인다(상한을 넘으면 시퀀스가 아니라고 보고 버린다).
    if ((rest[1] === '[' || rest[1] === ']') && rest.length < MAX_CARRY) {
      st.carry = rest
      break
    }
    // ESC ( B / ESC # 8 은 3바이트, 나머지 2바이트 시퀀스.
    const width = rest[1] === '(' || rest[1] === ')' || rest[1] === '#' ? 3 : 2
    if (rest.length < width) {
      st.carry = rest
      break
    }
    i += width
  }
  return out
}

// \r\n → \n, 단독 \r(진행률 덮어쓰기)은 마지막 상태만 남긴다.
export function normalizeCr(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n')
}

type Entry = {
  fd: number
  path: string
  bytes: number
  stopped: boolean
  strip: StripState
  masker: ReturnType<typeof createMasker>
  buf: string // 아직 줄이 끝나지 않은 꼬리(마스킹은 완성된 줄에만 적용한다)
}

export type SessionLogService = {
  write(meta: Session, chunk: Uint8Array): void
  close(sessionId: string): void
  closeAll(): void
  setPrefs(enabled: boolean, retentionDays: number): void
  // 기동 시 1회 보존 스윕. 삭제한 파일 수를 돌려준다(테스트용).
  sweep(): number
  /** 이 세션이 지금 쓰고 있는 로그 파일 경로(기록 off·미개시면 null). 로그 패널이 읽어 간다. */
  pathOf(sessionId: string): string | null
  /**
   * 기록을 쌓을 폴더를 바꾼다(2026-08-23 설정 [세션 기록 폴더]).
   * 열려 있던 파일은 **닫고** 새 폴더로 간다 — 한 세션의 기록이 두 폴더에 쪼개지지만, 그 편이
   * 옛 폴더에 계속 쓰는 것보다 정직하다(사용자는 "지금부터 여기"를 기대한다).
   * 지난 기록 목록(listPast)도 새 폴더를 본다 — 옛 폴더의 파일은 그대로 남는다(지우지 않는다).
   */
  setDir(next: string): void
  /** #86: 남아 있는 지난 세션 기록. 최근 것이 앞이다. */
  listPast(): PastLog[]
  /**
   * 아직 파일로 안 나간 꼬리(줄이 안 끝난 부분)의 합. **테스트 seam** 이다 — 개행 없는 출력이
   * 상한 없이 쌓이던 결함(M-8)을 재발 검사할 때 힙 사용량 대신 이 값을 본다. 힙은 GC 타이밍에
   * 흔들려 부하 걸린 머신에서 간헐 실패했고, 재는 대상도 실제로는 이 버퍼였다.
   * 프로덕션에서는 아무도 부르지 않는다.
   */
  bufferedBytes(): number
  /**
   * #86: 파일 **이름**을 폴더 안 경로로. 이름에 경로 구분자·상위 참조가 있으면 null —
   * 렌더러가 보낸 값이라 신뢰 경계다(그대로 join 하면 로그 폴더 밖을 읽을 수 있다).
   */
  pathOfFile(file: string): string | null
  dir: string
}

export function createSessionLog(dir0: string, enabled: boolean, retentionDays: number): SessionLogService {
  let dir = dir0 // setDir 로 바뀐다(설정 [세션 기록 폴더])
  const entries = new Map<string, Entry>()
  let on = enabled
  let keepDays = clampRetention(retentionDays)

  function ensureDir(): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  function open(meta: Session): Entry | null {
    ensureDir()
    const name = logFileName(meta)
    const path = join(dir, name)
    // 이중 방어: 새니타이즈를 통과한 이름이라도 최종 경로가 로그 디렉토리 밖이면 열지 않는다.
    if (basename(path) !== name || resolve(dirname(path)) !== resolve(dir)) return null
    try {
      const e: Entry = {
        fd: openSync(path, 'a'),
        path,
        bytes: 0,
        stopped: false,
        strip: newStripState(),
        masker: createMasker(),
        buf: ''
      }
      entries.set(meta.id, e)
      return e
    } catch (err) {
      process.stderr.write(`[sessionlog] 파일 열기 실패: ${String(err)}\n`)
      return null
    }
  }

  function put(e: Entry, text: string): void {
    if (!text || e.stopped) return // 상한 도달 후에는 안내를 두 번 남기지 않는다
    const data = Buffer.from(text, 'utf8')
    if (e.bytes + data.length > MAX_BYTES) {
      writeSync(e.fd, CAP_NOTICE)
      e.stopped = true
      return
    }
    writeSync(e.fd, data)
    e.bytes += data.length
  }

  function closeEntry(id: string): void {
    const e = entries.get(id)
    if (!e) return
    entries.delete(id)
    try {
      // 줄이 끝나지 않은 꼬리도 마스킹해서 흘려보낸다(세션이 프롬프트에서 끝나는 것이 보통이다).
      // 꼬리는 **두 군데**에 있다: 아직 개행이 안 온 줄(strip 상태의 셀 배열)과 그 앞의 버퍼.
      // 2026-08-23 에 stripAnsi 가 완성된 줄만 돌려주게 되면서 전자가 생겼다 — 안 흘려보내면
      // 세션의 **마지막 줄이 통째로 사라진다**(보통 그 줄이 마지막 프롬프트다).
      const tail = e.buf + pendingLine(e.strip)
      if (tail && !e.stopped) put(e, e.masker.mask(tail) + '\n')
      closeSync(e.fd)
    } catch {
      /* 이미 닫힌 fd — 무시 */
    }
  }

  return {
    dir,

    pathOf(sessionId) {
      return entries.get(sessionId)?.path ?? null
    },

    setDir(next) {
      if (!next || next === dir) return
      this.closeAll()
      dir = next
      // `dir` 은 인터페이스에도 노출된 값이라(로그 패널·[폴더 열기]가 읽는다) 함께 갱신한다.
      ;(this as { dir: string }).dir = next
    },

    // 테스트 seam(위 타입 주석 참고) — 아직 줄이 안 끝나 파일로 못 나간 꼬리의 합.
    bufferedBytes() {
      let n = 0
      // 그리는 중인 줄(strip 상태)까지 센다 — 개행 없는 출력은 그쪽에 쌓인다.
      for (const e of entries.values()) n += e.buf.length + e.strip.line.length
      return n
    },

    listPast() {
      const livePaths = new Set([...entries.values()].map((e) => resolve(e.path)))
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return [] // 폴더가 아직 없다(기록을 한 번도 안 켰다) — 빈 목록이 정답이다.
      }
      const out: PastLog[] = []
      for (const name of names) {
        const parsed = parseLogName(name)
        if (!parsed) continue // 우리 규칙이 아닌 파일은 건드리지 않는다(sweep 과 같은 태도).
        try {
          const st = statSync(join(dir, name))
          if (!st.isFile()) continue
          // 살아 있는 세션이 쓰고 있는 파일인가 — main 만 알 수 있다(렌더러에는 경로가 없다).
          const live = livePaths.has(resolve(join(dir, name)))
          out.push({
            file: name,
            startedAt: parsed.startedAt,
            serverKey: parsed.serverKey,
            bytes: st.size,
            ...(live ? { live: true } : {})
          })
        } catch {
          /* 지워지는 중이거나 권한 없음 — 목록에서 빼면 그만이다 */
        }
      }
      // 최근 것이 앞. 같은 초에 시작한 둘은 이름순으로 갈라 순서가 흔들리지 않게 한다.
      return out.sort((a, b) => b.startedAt - a.startedAt || a.file.localeCompare(b.file))
    },

    pathOfFile(file) {
      if (typeof file !== 'string' || !LOG_NAME_RE.test(file)) return null
      const full = resolve(join(dir, file))
      // 이름 검사만으로도 충분하지만(구분자가 통과 못 한다) 한 겹 더 본다 — 이 값이 곧 읽기 대상이다.
      return full.startsWith(resolve(dir)) ? full : null
    },

    write(meta, chunk) {
      // 기본 off: 사용자가 켜지 않으면 파일 자체가 생기지 않는다(보안 체크리스트 · 테스트 LOG-1).
      if (!on) return
      let e = entries.get(meta.id)
      if (!e) {
        e = open(meta) ?? undefined
        if (!e) return
      }
      if (e.stopped) return
      let text = normalizeCr(stripAnsi(Buffer.from(chunk).toString('utf8'), e.strip))
      // 대체화면 진입 = 여기서부터 출력이 로그에 남지 않는다. 원격이 종료 시퀀스(`\x1b[?1049l`)를
      // 보내지 않으면 이후 전부가 조용히 사라지는데(8바이트짜리 안티포렌식) 파일에는 아무 흔적도
      // 없었다. 억제는 그대로 두되 **구멍이 있다는 사실**은 남긴다.
      if (e.strip.entered) {
        e.strip.entered = false
        text += ALT_NOTICE
      }
      if (!text) return
      e.buf += text
      const cut = e.buf.lastIndexOf('\n')
      if (cut >= 0) {
        const complete = e.buf.slice(0, cut + 1)
        e.buf = e.buf.slice(cut + 1)
        put(e, e.masker.mask(complete))
      }
      // 남은 꼬리가 한 줄이라기엔 너무 길면 개행 없는 덤프다 — 완성 줄로 간주해 흘려보낸다.
      // 마스커를 반드시 거친다("기록 전 마스킹" 불변식). 이걸로 힙은 MAX_LINE, 디스크는 MAX_BYTES 로 묶인다.
      if (e.buf.length > MAX_LINE) {
        put(e, e.masker.mask(e.buf) + '\n')
        e.buf = ''
      }
    },

    close: closeEntry,

    closeAll() {
      for (const id of [...entries.keys()]) closeEntry(id)
    },

    setPrefs(nextEnabled, nextRetention) {
      keepDays = clampRetention(nextRetention)
      if (on === nextEnabled) return
      on = nextEnabled
      // 끄면 열려 있던 파일을 즉시 닫는다 — 토글 후에도 계속 쓰이면 "껐는데 남는다"가 된다.
      if (!on) this.closeAll()
    },

    sweep() {
      if (!keepDays || keepDays <= 0) return 0 // 0 = 무제한
      ensureDir()
      const cutoff = Date.now() - keepDays * DAY_MS
      let removed = 0
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return 0
      }
      for (const name of names) {
        // 우리 이름 패턴의 .log 만. 디렉토리·다른 확장자·사용자 파일은 손대지 않는다.
        if (!LOG_NAME_RE.test(name)) continue
        const path = join(dir, name)
        try {
          const st = statSync(path)
          if (!st.isFile() || st.mtimeMs >= cutoff) continue
          unlinkSync(path)
          removed++
        } catch {
          /* 다른 프로세스가 잡고 있음 등 — 다음 기동에 다시 시도한다 */
        }
      }
      return removed
    }
  }
}
