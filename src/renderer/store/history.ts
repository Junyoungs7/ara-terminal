// F11 명령어 히스토리 — 입력 스트림 수집 · scope 별 캐시 · 인라인 고스트 매칭.
// 순수 로직은 전부 여기 두고 TerminalPane 은 xterm 배선(고스트 데코레이션·Tab/ESC)만 한다.
//
// ⚠️ 비밀번호는 어디에도 남기지 않는다: 커밋 시점의 프롬프트 줄이 비밀번호 프롬프트면 그 입력은
// 캐시·IPC·디스크 어느 쪽으로도 가지 않고 버려진다(shouldRecord).

// scope 당 상한. main 의 HistoryStore 와 같은 값을 쓴다 — 렌더러 캐시가 더 길게 들고 있으면
// 재시작 전후로 고스트 결과가 달라진다.
export const HISTORY_MAX = 500

// 비밀번호 프롬프트로 볼 단어(대소문자 무시). sudo·ssh·mysql·한글 프롬프트를 모두 덮는다.
const PW_PROMPT = /(password|passphrase|암호|비밀번호)/i

// 커밋 시점 커서 줄에서 사용자가 친 부분을 뺀 나머지 = 프롬프트. 비밀번호 프롬프트는 입력을
// 에코하지 않으므로 typed 로 끝나지 않고, 그때는 줄 전체가 프롬프트다.
// (이 분리가 없으면 `echo password` 같은 평범한 명령까지 비밀번호로 오인해 기록이 사라진다.)
export function promptPrefix(line: string, typed: string): string {
  return typed && line.endsWith(typed) ? line.slice(0, line.length - typed.length) : line
}

export function isPasswordPrompt(line: string): boolean {
  return PW_PROMPT.test(line)
}

// 기록 대상 판정: 빈 줄 제외 · 공백으로 시작하면 제외(셸 관례) · 비밀번호 프롬프트 뒤면 제외.
export function shouldRecord(command: string, cursorLine: string): boolean {
  if (!command.trim() || command.startsWith(' ')) return false
  return !isPasswordPrompt(promptPrefix(cursorLine, command))
}

export type Feed = { buf: string; commands: string[] }

// 단말 **응답** 시퀀스 — 사용자가 친 것이 아니라 xterm 이 셸의 질의에 자동으로 답한 것이다.
// DA(Device Attributes) `ESC[?...c` · 포커스 리포트 `ESC[I`/`ESC[O` · CPR(커서 위치) `ESC[행;열R`.
// xterm 은 이 응답을 pty 로 쓰면서 동시에 term.onData 로도 흘려보내므로, 사용자가 타이핑하는 도중에
// 이 응답 한 덩어리가 별도의 onData 호출로 끼어든다(세션당 첫 포커스 직후 한 번 — M-4/HIST-15).
// 응답을 리드라인 편집으로 오인해 줄 버퍼를 비우면 그때까지 친 글자가 사라진다 — 버퍼는 그대로 두고
// 이 조각만 건너뛴다.
const RESPONSE_SEQ = /\x1b(?:\[\?[\d;]*c|\[[IO]|\[\d+;\d+R)/g

// term.onData(사용자 입력) 청크 → 줄 버퍼 갱신 + 완성된 명령 목록.
// 한 청크에 여러 줄이 올 수 있다(여러 줄 붙여넣기)므로 문자 단위로 훑는다.
//
// ponytail: 리드라인 편집(방향키·Ctrl+U·Tab 완성)이 섞인 줄은 우리가 재구성할 수 없어 통째로
// 버린다 — 틀린 기록을 남기느니 안 남기는 쪽이 낫다. 정확한 수집이 필요해지면 셸 훅
// (bash PROMPT_COMMAND / zsh precmd) 으로 승격한다.
export function feedInput(buf: string, data: string): Feed {
  const commands: string[] = []
  data = data.replace(RESPONSE_SEQ, '') // 단말 응답만 제거 — 버퍼는 건드리지 않는다.
  if (data.includes('\x1b')) return { buf: '', commands } // 남은 ESC(방향키·히스토리 탐색 등)는 그대로 버림
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      commands.push(buf)
      buf = ''
    } else if (ch === '\x7f' || ch === '\b') {
      buf = buf.slice(0, -1)
    } else if (ch === '\t' || ch < ' ') {
      buf = '' // 셸 자동완성 · Ctrl+C/U/K 등 — 추적 불가
    } else {
      buf += ch
    }
  }
  return { buf, commands }
}

/** 제안을 시작하는 최소 글자 수(#194 ③). 한 글자는 히스토리의 절반과 맞아 아무 뜻이 없다. */
export const GHOST_MIN_PREFIX = 2

/**
 * 이 입력에 **제안을 띄울 자리인가**(#194 ③, 2026-09-08 준영님: *"작성할때 너무 불편한데"*).
 *
 * 두 가지만 본다:
 *  · 공백으로 끝나면 지금 치는 낱말이 **비어 있다** → `cd ` 만 쳐도 히스토리의 아무 `cd` 나
 *    들이밀던 것을 여기서 끊는다.
 *  · 줄 전체가 두 글자 미만이면 → `c` 로는 안 뜬다.
 *
 * ⚠️ 문턱은 **줄 전체** 기준이지 마지막 낱말 기준이 아니다. `cd w` 는 떠야 하고 `c` 는 아니어야
 * 한다는 것이 요청의 예시인데, 마지막 낱말(`w`)로 재면 `cd w` 가 함께 죽는다. 바꾸기 전에 그
 * 두 예시를 먼저 통과시켜라(tests/w1c-qol.test.ts).
 *
 * `ghostList` 안에 두지 않고 뗀 이유는 부르는 쪽이다: TerminalPane 이 **타이머를 걸기 전에**
 * 이것을 물어, 어차피 안 뜰 입력에는 지연 타이머도 xterm 버퍼 읽기도 히스토리 훑기도 만들지 않는다.
 */
export function ghostEligible(input: string): boolean {
  return input.length >= GHOST_MIN_PREFIX && !/\s$/.test(input)
}

/**
 * 접두 일치 후보 — **최근 것부터**, 중복 없이, 최대 max 개
 * (2026-08-22 준영님 제보 10번: "자동완성이 IDE 처럼 목록으로 떴으면 좋겠어").
 *
 * 중복 제거가 핵심이다: 같은 명령을 어제도 오늘도 쳤으면 히스토리엔 여러 번 있는데, 목록에
 * 같은 줄이 세 개 뜨면 고를 것이 없는 목록이 된다(연속 중복만 appendHistory 가 막는다).
 */
export function ghostList(entries: readonly string[], input: string, max = 6): string[] {
  if (!ghostEligible(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
    const e = entries[i]
    if (e.length <= input.length || !e.startsWith(input) || seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out
}

// 인라인 고스트로 보여 줄 하나 = 목록의 첫 줄. 규칙을 두 벌 두지 않는다(갈라지면 고스트와
// 목록의 첫 줄이 서로 다른 명령을 가리킨다).
export function ghostFor(entries: readonly string[], input: string): string | null {
  return ghostList(entries, input, 1)[0] ?? null
}

// ── scope 별 캐시 ──
// 고스트 매칭은 키 입력마다 도는 경로라 IPC 왕복을 둘 수 없다. scope 당 한 번만 load 하고
// 이후 append 는 캐시와 디스크(main)에 동시에 반영한다.
const cache = new Map<string, string[]>()
const loading = new Map<string, Promise<string[]>>()

export function cachedHistory(scope: string): readonly string[] {
  return cache.get(scope) ?? []
}

export function loadHistory(scope: string): Promise<string[]> {
  const done = cache.get(scope)
  if (done) return Promise.resolve(done)
  let p = loading.get(scope)
  if (!p) {
    p = (window.ev?.history?.load(scope) ?? Promise.resolve([]))
      // 하네스(history:* 미배선)에서도 고스트만 비활성으로 두고 나머지는 그대로 동작하게 한다.
      .catch(() => [] as string[])
      .then((entries) => {
        cache.set(scope, entries)
        loading.delete(scope)
        return entries
      })
    loading.set(scope, p)
  }
  return p
}

// 캐시 + 영속 동시 갱신. 연속 중복은 남기지 않는다(같은 명령을 반복하면 히스토리가 그것으로 찬다).
export function appendHistory(scope: string, command: string): void {
  const list = cache.get(scope) ?? []
  if (list[list.length - 1] === command) return
  list.push(command)
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX)
  cache.set(scope, list)
  void window.ev?.history?.append(scope, command).catch(() => {})
}

// 테스트 전용 — 모듈 캐시를 비운다(vitest 간 상태 누수 방지).
export function resetHistoryCache(): void {
  cache.clear()
  loading.clear()
}
