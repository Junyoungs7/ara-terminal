/**
 * 스폰 경계 래칫 (#156) — **결정을 한 번만 하게 만든다.**
 *
 * #152 는 `shell: true` 하나가 어떤 값을 치르는지 실측으로 보여 줬다: 윈도우에서 그 옵션은 인자를
 * **공백으로 잇기만** 하고 인용은 호출자에게 미루는데, 그 미룬 자리를 파서 둘(cmd.exe → CRT)이
 * 다르게 읽어 `&` 뒤가 데이터가 아니라 **명령**이 됐다. 이 PC 의 `where claude` 가 진짜 `.cmd`
 * 셔임이라 이론이 아니었다. 답은 `ClaudeCliEngine` 의 `cmdExeArgs`/`encodeWinArg` 하나뿐이다.
 *
 * 그 답을 아는 파일이 하나여도, **두 번째 파일이 같은 결정을 다시 하면** 되돌아온다. 이 검사가
 * 막는 것이 그것이다 — Orca(`child-process-import-boundary.test.ts`)의 말대로 *"새 직접 사용은
 * 오늘 우연히 맞더라도 실패한다. '오늘은 맞다'가 바로 잘못된 파일들이 복사되기 전의 상태였다."*
 *
 * **지금이 유일한 기회다.** #152 가 마지막 제품 소비자를 없애서 `shell: true` 허용목록이 **빈 채로**
 * 시작한다. 한 번이라도 항목이 들어가면 다시는 빈 목록이 아니다.
 *
 * 왜 `scripts/scan-*.mjs` 가 아니라 vitest 인가: 스캐너들은 `npm run scan:magic` 처럼 **따로 불러야**
 * 돈다. 이 규칙은 새 파일이 생기는 순간 걸려야 하는데, 라운드마다 반드시 도는 것은 `npm test` 다.
 * 배선이 0 이라는 이유 하나로 vitest 를 골랐다(Orca 의 원본도 평범한 테스트 파일이다).
 * 스캐너 쪽은 CSS·i18n 처럼 **게이트 때만** 봐도 되는 것들이 산다 — 성격이 다르다.
 *
 * 단언 넷(Orca §5 표 그대로). 하나가 아니라 넷인 이유가 각각 있다:
 *  ⓐ 목록에 없는 위반이 없다 — 기본.
 *  ⓑ **낡은 허용목록 항목이 없다** — 고친 파일이 목록에 남아 있으면 그 경로의 다음 회귀를 가린다.
 *  ⓒ **위반 줄 수 ≤ 허용목록 파일 수** — 허용된 파일이 위반을 **하나 더** 늘리는 것을 따로 잡는다
 *     (ⓐ·ⓑ 는 파일 단위라 통과한다 — 이 셋째가 없으면 그 증가가 조용하다).
 *  ⓓ **훑은 파일이 실제로 있었다** — 없으면 위반 0 으로 **조용히 통과한다.** 게이트와 위약의 차이가
 *     이 한 줄이다(`6ae58f0` 에서 스캐너 둘에 이미 넣은 그 규칙).
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const EXTS = ['.ts', '.tsx', '.mjs', '.cjs', '.js']

/**
 * 이름이 `.` 으로 시작하는 것은 건너뛴다 — `tests/.f7-harness-main.cjs` 같은 **빌드 산출물**이다
 * (gitignore 대상이고 `scripts/bundle-*.mjs` 가 만든다). 사람이 쓴 줄이 아니므로 이 규칙의
 * 대상이 아니다.
 *
 * ⚠️ 처음엔 "번들 안에 우리가 쓰지 않은 `shell: true` 가 들어 있어서"라고 적었는데 **재 보니
 * 0건이었다**(2026-08-30). 건너뛰는 동작은 맞고 이유가 틀렸다 — 안 재고 적은 이유는 다음 사람이
 * 그 말을 근거로 다른 판단을 하게 만든다.
 */
function walk(dir: string): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out = out.concat(walk(p))
    else if (EXTS.includes(extname(p))) out.push(p.replaceAll('\\', '/'))
  }
  return out
}

type Hit = { file: string; line: number; text: string }

function scan(files: string[], re: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((raw, i) => {
        const bare = raw.trim()
        // 주석 줄은 건너뛴다 — **금지된 패턴을 인용하지 않고는 왜 금지인지 적을 수 없다.**
        // 실제로 이 규칙이 없으면 `ClaudeCliEngine`·`registerAraIpc`·`araChats` 의 설명 주석
        // 셋과 바로 위 이 파일의 머리말이 전부 위반으로 잡힌다.
        // (scan-magic-numbers 가 과제 번호 `#125` 를 HEX 로 잡고 배운 것과 같은 자리다.)
        if (bare.startsWith('//') || bare.startsWith('*') || bare.startsWith('/*')) return
        if (re.test(raw)) hits.push({ file, line: i + 1, text: bare })
      })
  }
  return hits
}

/** ⓐⓑⓒ 를 한 번에. 실패 메시지에 **무엇을 하라는지**까지 담는다(가드가 이유를 못 대면 예외가 는다). */
function ratchet(rule: string, hits: Hit[], allow: string[], fix: string): void {
  const dirty = [...new Set(hits.map((h) => h.file))].sort()
  const unlisted = hits.filter((h) => !allow.includes(h.file)).map((h) => `${h.file}:${h.line}  ${h.text}`)
  expect(unlisted, `${rule}\n${fix}`).toEqual([])
  expect(
    allow.filter((f) => !dirty.includes(f)),
    `${rule}\n이미 고친 파일이 허용목록에 남아 있다 — 지워라. 남겨 두면 그 경로의 다음 회귀를 가린다.`
  ).toEqual([])
  expect(
    hits.length,
    `${rule}\n허용된 파일이 위반을 더 늘렸다(파일 수는 그대로라 ⓐⓑ 로는 안 잡힌다).\n${fix}`
  ).toBeLessThanOrEqual(allow.length)
}

// ── 훑을 파일 ────────────────────────────────────────────────────────────────
const srcFiles = walk('src')
const allFiles = ['src', 'tests', 'scripts'].flatMap(walk)

// ⓓ 하한은 현재 수의 절반쯤(6ae58f0 의 그 기준). 2026-08-30 현재 src 231 · 전체 453.
const MIN_SRC = 100
const MIN_ALL = 200

// ── 규칙 ─────────────────────────────────────────────────────────────────────
const SHELL_TRUE = /\bshell\s*:\s*true\b/
/**
 * `shell: true` 만 본다. **`shell:` 전체를 금지할 수는 없다** — 이 저장소는 터미널이라
 * `shell: spec.shell`·`shell: 'cmd.exe'`(세션이 띄울 셸)가 정상적으로 40곳 넘게 산다.
 * 위험한 것은 셸이라는 개념이 아니라 **spawn 이 인용을 대신 해 준다는 착각**이다.
 */
const SHELL_ALLOW: string[] = []

const CHILD_PROCESS_IMPORT =
  /\bfrom\s*['"](?:node:)?child_process['"]|\b(?:require|import)\s*\(\s*['"](?:node:)?child_process['"]/
/**
 * 제품(`src/`)이 프로세스를 띄우는 자리는 셋뿐이고, 셋 다 **셸을 안 거치는 이유를 파일에 적어 두었다.**
 * Orca 는 이 결정을 `run-process.ts` 한 곳으로 모았는데 우리는 셋이라 아직 래퍼가 이르다 —
 * 그래서 이 목록은 "네 번째가 생기면 **혼자 정하지 말고 여기서 이야기하자**"는 뜻이다.
 *  · ClaudeCliEngine — 유일하게 셸(cmd.exe)을 지나야 하는 자리(`.cmd` 셔임). 인코딩이 여기 산다.
 *  · localCli · localGit — `execFile` 로 인자를 배열째 넘긴다(인용이라는 개념 자체가 없다).
 *  · rdpClipboard(#205, 2026-09-28 넷째로 들어왔다) — 윈도우 클립보드의 파일 형식(CF_HDROP)은 Electron 이
 *    못 다뤄 `powershell.exe` 를 부른다. 같은 규칙을 지킨다: `execFile` + 인자 배열 · 스크립트는 **고정 상수**를
 *    `-EncodedCommand` 로 · 파일명(원격이 정한 값 — 신뢰 경계 밖)은 **환경변수의 JSON 으로만** 가고 명령
 *    문자열에는 한 글자도 안 들어간다(`tests/rdpClipBridge.test.ts` 가 그걸 잰다). 다섯째가 오면 그때는
 *    Orca 처럼 래퍼 하나로 모을 때다.
 * `tests/`·`scripts/` 는 이 규칙 밖이다. 검사가 프로세스를 띄우는 것은 정상이고, 목록에 넣으면
 * 새 스모크를 쓸 때마다 늘어나 **의미가 닳는다.** 그쪽도 `shell: true` 는 위에서 그대로 막는다.
 */
const CHILD_PROCESS_ALLOW = [
  'src/main/ai/engine/ClaudeCliEngine.ts',
  'src/main/util/localCli.ts',
  'src/main/util/localGit.ts',
  'src/main/rdp/rdpClipboard.ts'
]

describe('스폰 경계 래칫', () => {
  it('ⓓ 훑을 파일을 실제로 찾았다 — 못 찾으면 위반 0 으로 조용히 통과한다', () => {
    const hint = '경로가 코드베이스와 어긋났다(디렉터리 이동·확장자 목록). 래칫을 고쳐라 — 지금 이 가드는 아무것도 안 지킨다.'
    expect(srcFiles.length, hint).toBeGreaterThan(MIN_SRC)
    expect(allFiles.length, hint).toBeGreaterThan(MIN_ALL)
  })

  // 이 제목에 금지된 패턴을 그대로 쓰면 **이 파일이 스스로 걸린다**(첫 실행에서 실제로 걸렸다).
  // 자기 자신을 예외로 빼지 않는다 — 가드를 무르게 고치는 사람이 제일 먼저 여는 파일이다.
  it('★ spawn 에 셸을 켠 자리가 없다 — 허용목록은 비어 있고, 비어 있는 채로 둔다', () => {
    ratchet(
      'spawn 에 shell 을 켰다(#152: 윈도우에서 인자가 명령이 된다).',
      scan(allFiles, SHELL_TRUE),
      SHELL_ALLOW,
      '윈도우면 ClaudeCliEngine 의 cmdExeArgs(bin, args) 로 cmd.exe 를 직접 부르고' +
        '(windowsVerbatimArguments: true), 아니면 셸 없이 spawn(bin, args) 한다.\n' +
        '허용목록에 추가하지 마라 — #152 가 마지막 소비자를 없애서 이 목록이 빈 채로 시작한다.'
    )
  })

  it('제품이 child_process 를 직접 부르는 자리는 목록에 적힌 셋뿐이다', () => {
    ratchet(
      'src/ 에서 child_process 를 직접 가져왔다.',
      scan(srcFiles, CHILD_PROCESS_IMPORT),
      CHILD_PROCESS_ALLOW,
      '프로세스를 띄우는 결정(셸 여부·인용·인코딩·타임아웃·windowsHide·cwd)은 여섯 개다.\n' +
        '새 자리가 정말 필요하면 목록에 적고 **왜 셸이 필요 없는지**를 파일에 남겨라(localCli·localGit 처럼).'
    )
  })
})
