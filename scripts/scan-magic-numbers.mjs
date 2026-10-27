// 매직넘버 스캔 (계획서 §D.3). 컴포넌트/인터랙션 CSS·TSX에서 토큰 우회 HEX/px 감지.
// tokens.css는 예외(토큰 정의부). CI 게이트용 — 위반 시 exit 1.
// + CSS 중괄호 균형 검사(BLOCKER-3 재발 방지 — vite는 깨진 CSS를 그대로 통과시킨다).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['src/renderer/components', 'src/renderer/interactions']
/**
 * 색 리터럴이 허용되는 파일.
 *  · tokens.css   — 토큰을 정의하는 자리다(여기 없으면 어디에도 색이 없다).
 *  · fileIcons.tsx — 확장자별 파일 아이콘(2026-08-22). 그 색은 **디자인 토큰이 아니라 외부 규약**이다:
 *    엑셀은 초록, 워드는 파랑, PDF 는 빨강 — 우리 팔레트로 갈아 끼우면 "실제 그 아이콘"이라는
 *    성질 자체가 사라진다. 대신 다른 곳으로 새지 않게 **한 파일에 가두고** 여기 이름을 적는다.
 */
const EXCLUDE = ['tokens.css', 'fileIcons.tsx']
const HEX = /#[0-9a-fA-F]{3,8}\b/
const RGBA = /rgba?\(\s*\d/
// px 리터럴이 시각 속성(§D.3 b)에 붙은 경우.
const PX_PROP = /(font-size|width|height|padding|margin|gap|border-radius)\s*:\s*[^;]*\b\d+px/i

function walk(dir) {
  let out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out // 아직 없는 디렉토리(interactions는 F4c에서 생성)는 건너뜀
  }
  for (const name of entries) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out = out.concat(walk(p))
    else if (['.css', '.tsx'].includes(extname(p)) && !EXCLUDE.includes(name)) out.push(p)
  }
  return out
}

const violations = []

/**
 * **공허성 방지**(2026-08-28 — Orca 의 래칫 테스트에서 가져온 규칙).
 *
 * 훑을 파일을 하나도 못 찾으면 위반도 0이라 **조용히 통과한다.** ROOTS 를 옮기거나 styles/ 를
 * 다른 데로 빼면 그날부터 이 게이트는 아무것도 안 지키면서 초록으로 남는다.
 * 게이트와 위약(placebo)의 차이가 이 한 줄이다 — 하한은 현재 수의 절반쯤에 둔다.
 */
const MIN_TSX = 30
const MIN_CSS = 3
const tsxFiles = ROOTS.flatMap((r) => walk(r))
const cssFiles = readdirSync('src/renderer/styles').filter((n) => n.endsWith('.css') && !EXCLUDE.includes(n))
if (tsxFiles.length < MIN_TSX || cssFiles.length < MIN_CSS) {
  console.error(
    `매직넘버 스캔이 공허하다: tsx ${tsxFiles.length}개(하한 ${MIN_TSX}) · css ${cssFiles.length}개(하한 ${MIN_CSS}).\n` +
      'ROOTS 나 styles/ 경로가 코드베이스와 어긋났다 — 스캐너를 고쳐라.'
  )
  process.exit(1)
}

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // 인라인 SVG viewBox 등 비시각 좌표는 예외 (§D.3 b)
      if (/viewBox|stroke-width|strokeWidth|cx=|cy=|\br=|points=/.test(line)) return
      // 2026-08-25(#125): 주석 줄은 HEX 검사에서 뺀다 — styles/ 쪽이 이미 그렇게 한다(아래).
      // 여기서 처음 걸린 것은 색이 아니라 **과제 번호 `#125`**였다(3자리부터 HEX 모양이 된다).
      // 두 자리 시절(`#79`)에는 안 걸리던 것이라 규칙이 아니라 우연히 조용했던 것이다.
      const bare = line.trim()
      const isComment = bare.startsWith('/*') || bare.startsWith('*') || bare.startsWith('//') || bare.startsWith('{/*')
      if (HEX.test(line) && !isComment) violations.push(`${file}:${i + 1}  HEX 리터럴  → ${line.trim()}`)
      else if (PX_PROP.test(line)) violations.push(`${file}:${i + 1}  px 리터럴  → ${line.trim()}`)
    })
  }
}

// UI-font5(2026-08-11): styles/ 는 위 ROOTS 밖이라 검사를 안 받고 있었다 — 그 사이
// shell.css·interactions.css 에 font-size 리터럴이 **229곳, 12종**(9~15.5px) 쌓였고,
// 크기가 흩어져 있어 "UI 글자를 키운다"를 한 번에 할 방법이 없었다(UI-font3 이 실험만 하고
// 적용하지 못한 이유). 척도를 tokens.css 로 모은 뒤, 다시 흩어지지 않게 여기서 막는다.
// 범위는 font-size 하나다. width·padding 까지 지금 토큰화하는 것은 별개의 큰 작업이고,
// 이 가드의 목적은 "**척도**가 다시 흩어지는 것"을 막는 것이다.
//
// ⏸→▶ border-radius. **2026-08-28 아침에 보류했다가 같은 날 켰다**(#149) — 보류 사유가
// "규칙이 틀렸다"가 아니라 "**순서가 반대다**"였기 때문이다. 그 판단은 지우지 않고 남긴다:
//
//   [보류할 때] 병은 실재했다 — **33곳, 13종**(1·2·3·4·5·6·7·8·10·11·20px), 그중 `3px` 하나가
//   **열여섯 곳**이라 이름 없는 사실상의 토큰이었다. 그런데 font-size 때는 척도를 tokens.css 로
//   모은 *뒤* 가드를 걸었는데(위 문단) radius 는 아직 안 모았고, 그때 토큰(4·6·8px)이 덮는 것은
//   33건 중 **7건뿐**이었다. 그 상태로 가드만 켜면 게이트가 **없는 토큰을 요구**하게 된다
//   (§ var() 폴백에서 폴백 있는 것을 통과시킨 것과 같은 이유).
//
//   [지금 켜는 이유] 그 선행 조건을 이번 라운드에서 끝냈다. `--radius-xs: 3px` 를 추가해
//   척도를 4단으로 넓혔고(16곳이 이미 쓰던 값에 이름만 붙인 것이다), 남은 열 곳은 추측 대신
//   **이웃이 쓰는 토큰**으로 맞췄다(.term-comp→.ctx-menu · .font-item→.prof). 이제 리터럴로
//   남은 것은 알약뿐이고, 그건 아래 PILL 로 빠진다 — **요구할 토큰이 전부 존재한다.**
//
// ⚠️ `calc(var(--radius) - 2px)` 같은 관계식도 **일부러 위반으로 잡는다.** px 가 보이면 걸린다.
// 중첩 보정이 정말 필요하면 예외를 파지 말고 척도에 칸을 하나 더 만들어라 — 예외를 허용한
// 순간 그 자리에 매직 오프셋이 돌아온다(이번 열 곳 중 관계식이 필요한 자리는 결국 없었다).
// ⏸ padding·margin·gap. **켜지 않았다**(2026-08-30, #153/M5) — 바로 위 border-radius 가 남긴
// 교훈("척도를 모은 **뒤** 가드를 건다")의 나머지 절반이 여기 걸린다. 이번엔 순서는 맞았는데
// **덮이지 않는 자리가 남았다.**
//
//   const STYLES_SP =
//     /(?:^|[;{\s])(?:(?:padding|margin)(?:-(?:top|right|bottom|left))?|(?:row-|column-)?gap)\s*:\s*[^;]*\b[0-9.]+px/i
//
//   ⚠️ **단축 속성만 보면 안 된다.** 처음 적었던 `/(padding|margin|gap|…)\s*:\s*…/` 는 속성명
//   바로 뒤에 콜론을 요구해서 `padding-left:`·`margin-top:`·`padding-bottom:` 를 통째로 못 본다 —
//   실제로 17줄 중 **6줄을 놓쳤다**(트리 들여쓰기 22·30·34px, 음성 오버레이 20·26·168px).
//   위 border-radius 가 "가드가 안 보는 **파일**"에 값을 숨기고 있었다면, 이쪽은 "가드가 안 보는
//   **속성**"이다. 켤 때 이 정규식을 그대로 쓰고, 켜기 전에 아래 두 수가 같은지부터 확인해라:
//   이 규칙이 잡는 줄 수 == 표 ③ 의 줄 수(지금은 둘 다 17).
//
//   척도는 모았다 — `--sp-1`~`--sp-9`(2px 격자)와 `--sp-hair`. px 727개 중 708개가 토큰이 됐다.
//   그런데 **19개 값이 17줄에 리터럴로 남는다**(agent_talk/FINISH-M5-table.md ③):
//     · 트리 들여쓰기 22·30·34px — 캐럿+아이콘 폭에서 나온 치수
//     · 라벨 열 정렬 78px · 고정 음성 바를 비우는 168px
//     · 넓은 여백 20·24·26·28px — 홀수가 없는 구간이라 척도를 늘릴 이유가 없었다
//     · .frow 의 반픽셀 2.5px(행 높이 맞춤) · .set-sec-d 의 -5px(음수 끌어올림)
//   이것들은 **리듬이 아니라 다른 숫자에서 계산된 값**이라 토큰이 답이 아니다. 지금 이 줄을
//   켜면 게이트가 `--sp-huge: 168px` 같은 **없어야 마땅한 토큰을 요구**하게 된다 — border-radius
//   때 하루 만에 되돌린 그 실패와 정확히 같은 모양이다. 빨간 게이트로 커밋되면 안 된다.
//
//   [켜려면] 치수를 예외로 빼는 방법이 필요하다. 값 목록으로 빼면 그 값이 다시 흩어지므로
//   (예외 하나를 파면 그 자리에 매직 오프셋이 돌아온다 — 아래 calc 문단과 같은 이유),
//   `/* dimension */` 같은 **줄 주석 표시**로 의도를 적게 하는 쪽이 맞다. 17줄이라 손으로 붙일
//   만하다. 그 표시를 도입하는 것 자체가 별건이라 M5 에서는 하지 않았다.
const STYLES_BR = /border-radius\s*:\s*[^;]*\b[0-9.]+px/i
// 알약은 척도가 아니라 관용구 — 예외로 둔다. 토글 스위치·칩·개수 배지처럼 "끝이 반원"이
// 모양의 정의인 자리다. 다만 tokens.css §Radius 는 알약을 거부하고 있는데 실제로는 여덟 곳이
// 쓴다 — 그 모순을 없앨지는 디자인 결정이라 값을 유지한 채 남겨 두었다(FINISH-M1 보고).
const PILL = /border-radius\s*:\s*9{3,}px/i
const STYLES_FS = /font-size\s*:\s*[^;]*\b[0-9.]+px/i
// ── 지속시간 리터럴 (2026-09-04) ─────────────────────────────────────────────
// font-size·border-radius 와 **같은 순서**로 켠다: 척도를 tokens.css 로 모은 **뒤** 가드를 건다.
// 모으기 전 상태는 `transition`·`animation` 선언 92개에 토큰 5개였고, 0.12(18) · 0.15(8) ·
// 0.14(8) · 0.13(4) · 0.1(8) 이 나란히 있었다 — 사람이 구분하지 못하는 네 값이라 **의도일 수
// 없는** 흩어짐이다. 게다가 `0.12s` 와 `120ms` 두 표기가 섞여 어느 쪽으로 grep 해도 전부를
// 못 찾았다. 지금은 --dur-quick(120ms) · --dur-pop(200ms) · --dur-drawer(280ms) 셋이다.
//
// ⚠️ **이 검사가 보는 것은 한 가지 모양뿐이다**: `transition:` 값이 **맨 숫자로 시작**하는 것
// (`transition: 0.12s` · `transition: 120ms ease`). 그 모양이 흩어짐을 만든 저작 동작이고,
// 지금 잡히는 것이 0곳이라 예외가 하나도 없다 — 예외 없는 게이트만 초록을 믿을 수 있다.
//
// ⚠️ **안 보는 것을 적어 둔다.** 속성을 명시한 것(`transition: transform 90ms …`)과 `animation:`
// 은 통과한다. 일부러다 — 척도로 안 모이는 값이 거기 산다: 부팅 인사(.boot* — 0.25~1.6s 와
// 지연 넷이 한 벌로 짜인 안무) · 게이지의 `width 0.3s linear`(폴링 사이를 잇는다) · 음성
// 레벨 미터의 `90ms`(50ms 갱신 주기에 맞춘 값). 여기에 이름을 요구하면 게이트가 **없어야
// 마땅한 토큰**을 요구하게 된다 — 위 border-radius 가 하루 만에 되돌아온 그 실패다.
// 그쪽까지 덮으려면 값 목록이 아니라 `/* choreo */` 같은 **의도 표시**가 먼저 필요하다.
const STYLES_DUR = /transition\s*:\s*[0-9.]+m?s\b|transition-duration\s*:\s*[^;]*[0-9]/i
for (const name of readdirSync('src/renderer/styles').filter((n) => n.endsWith('.css') && !EXCLUDE.includes(n))) {
  const file = join('src/renderer/styles', name)
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (STYLES_FS.test(line)) {
        violations.push(`${file}:${i + 1}  font-size px 리터럴(tokens.css 의 --fs-* 를 쓸 것)  → ${line.trim()}`)
      }
      if (STYLES_BR.test(line) && !PILL.test(line)) {
        violations.push(`${file}:${i + 1}  border-radius px 리터럴(tokens.css 의 --radius-* 를 쓸 것)  → ${line.trim()}`)
      }
      // 2026-08-16: **HEX 는 styles/ 도 본다.** 그전까지 HEX 검사는 ROOTS(components·interactions)
      // 에만 걸려 있었는데 그 두 디렉터리에는 .css 파일이 **0개**다 — "HEX 리터럴 금지"가 색이
      // 실제로 사는 6,800줄에 한 줄도 안 걸려 있었다. px 는 여전히 font-size 만 본다(§D.3 별건).
      // 주석 줄은 건너뛴다 — "왜 이 값을 쓰면 안 되는가"를 적으려면 그 값을 인용해야 한다.
      const bare = line.trim()
      const isComment = bare.startsWith('/*') || bare.startsWith('*') || bare.startsWith('//')
      if (HEX.test(line) && !isComment) {
        violations.push(`${file}:${i + 1}  HEX 리터럴(tokens.css 의 색 토큰을 쓸 것)  → ${bare}`)
      }
      // 2026-08-21: **rgba() 도 본다.** HEX 만 보고 있어서 G 팔레트로 갈아탄 뒤에도 옛 남색·
      // 시안·빨강이 `rgba(4,6,11,.65)` 같은 모양으로 다섯 곳에 남아 있었다(모달 뒷막·위험 틴트·
      // 터미널 선택색). 색을 바꿔도 **혼자 따라오지 않는 값**이라 화면에서 그 자리만 색조가 달랐다.
      // 알파가 필요한 색은 tokens.css 에 토큰으로 두면 된다(--scrim · --err-tint · --accent-glow).
      if (RGBA.test(line) && !isComment) {
        violations.push(`${file}:${i + 1}  rgba 리터럴(tokens.css 에 알파 토큰을 둘 것)  → ${bare}`)
      }
      if (STYLES_DUR.test(line) && !isComment) {
        violations.push(
          `${file}:${i + 1}  transition 지속시간 리터럴(--dur-quick·--dur-pop·--dur-drawer 를 쓸 것)  → ${bare}`
        )
      }
    })
}

// ── §PRESS 뒤에는 :hover 가 없어야 한다 (2026-09-04) ────────────────────────
// 누름 반응(:active)은 shell.css·interactions.css **맨 끝**에 한 덩어리로 산다. `:active` 와
// `:hover` 는 명시도가 같아 **뒤에 오는 쪽이 이기기** 때문이다. 누군가 그 아래에 `:hover`
// 규칙을 하나 붙이면 그 자리만 조용히 안 눌린다 — 화면은 멀쩡해 보이고 아무도 모른다.
// 주석으로 "여기 아래에 쓰지 마라"라고만 적어 두면 언젠가 깨진다. 그래서 센다.
for (const name of ['shell.css', 'interactions.css']) {
  const file = join('src/renderer/styles', name)
  const src = readFileSync(file, 'utf8')
  const at = src.indexOf('§PRESS')
  if (at < 0) {
    // 공허성 방지 — 표시가 사라지면 이 검사는 아무것도 안 지키면서 초록이 된다.
    violations.push(`${file}  §PRESS 표시가 없다 — 누름 반응 블록이 사라졌거나 이름이 바뀌었다`)
    continue
  }
  // 머리 주석이 닫히는 자리부터 본다 — 그 주석 안에서 `:hover` 를 **인용**하고 있어서
  // (왜 순서가 중요한지를 적으려면 그 이름을 써야 한다) 거기서부터 세면 자기 자신에 걸린다.
  const body = src.slice(src.indexOf('*/', at) + 2).replace(/\/\*[\s\S]*?\*\//g, '')
  for (const line of body.split('\n')) {
    const bare = line.trim()
    if (bare.includes(':hover')) {
      violations.push(
        `${file}  §PRESS 뒤의 :hover — 같은 명시도라 이 규칙이 누름을 이긴다(§PRESS 위로 옮겨라)  → ${bare}`
      )
    }
  }
}

// tokens.css 도 **border-radius 만은** 검사한다(2026-08-28, #149). 이 파일은 색·척도의 정의부라
// 위 루프에서 통째로 빠져 있는데, 파일 **아래쪽**에는 정의가 아니라 평범한 규칙이 산다
// (`* { box-sizing }` · `body` · `::-webkit-scrollbar-*`). 실제로 거기 스크롤바 손잡이가
// `20px` 을 쓰고 있었고 — 척도 밖의 값인데 **가드가 안 보는 파일이라 조용했다.** 한 번 뚫린
// 구멍은 다음에도 뚫린다. `border-radius:` 라는 속성명은 :root 의 토큰 정의(`--radius-lg: 8px`)
// 에는 나올 수 없으므로 이 검사만 걸어도 정의부를 오탐하지 않는다.
readFileSync(join('src/renderer/styles', 'tokens.css'), 'utf8')
  .split('\n')
  .forEach((line, i) => {
    if (STYLES_BR.test(line) && !PILL.test(line)) {
      violations.push(
        `src/renderer/styles/tokens.css:${i + 1}  border-radius px 리터럴(--radius-* 를 쓸 것)  → ${line.trim()}`
      )
    }
  })

// 정의되지 않은 var() 검사 (AUDIT-R6 ②). 스캐너가 HEX·px 는 봐도 **`var(--x)` 의 `--x` 가
// 실제로 있는지는 안 봤다.** 없는 토큰을 쓰면 브라우저는 오류 없이 **선언을 통째로 버린다** —
// 그래서 RDP 카드가 각진 모서리로, [지난 대화] 버튼이 테두리 없는 맨 글자로 배포 직전까지 갔다.
// ⚠️ 폴백이 있으면(`var(--group-clr, var(--accent))`) 통과다 — 그 넷(--group-clr·--t-bg·--sx·--sy)은
// TSX 가 인라인으로 넣는 값이라 CSS 에 정의부가 없는 게 정상이다. 위반으로 잡으면 게이트가
// 틀린 걸 요구하게 된다. TSX 가 setProperty 로 넣는 것도 같은 이유로 CSS 에 기본값을 두거나
// 폴백을 붙이는 쪽이 답이다 — 예외 목록을 늘리지 않는다.
const VAR_DEF = /(^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g
const VAR_USE = /var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g
const defined = new Set()
for (const name of readdirSync('src/renderer/styles').filter((n) => n.endsWith('.css'))) {
  for (const m of readFileSync(join('src/renderer/styles', name), 'utf8').matchAll(VAR_DEF)) defined.add(m[2])
}
function walkAll(dir) {
  let out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out = out.concat(walkAll(p))
    else if (['.css', '.ts', '.tsx'].includes(extname(p))) out.push(p)
  }
  return out
}
for (const file of walkAll('src/renderer')) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(VAR_USE)) {
        if (m[2] === ')' && !defined.has(m[1])) {
          violations.push(`${file}:${i + 1}  정의 없는 토큰 ${m[1]} (선언이 통째로 버려진다)  → ${line.trim()}`)
        }
      }
    })
}

// ── 대비 게이트 (2026-08-31) ────────────────────────────────────────────────
// 이 스캐너는 "토큰을 쓰는가"만 봤지 **그 토큰이 읽히는가**는 안 봤다. 그래서 다음이 조용히
// 통과했다: 글자 4단 램프의 대비를 `--bg-canvas` 하나에 대고 손으로 재서 tokens.css 주석과
// docs/design-system.md 표에 적어 뒀는데, 사이드바·하단바는 `--bg-surface` 위에 살고 hover·
// 칩은 그보다 밝은 `--bg-overlay` 위에 산다. 그 두 배경에서 `--text-dim` 은 3.49 · 2.80 으로
// **하한 3.5 를 깨고 있었다** — 준영님이 "안 보인다"고 짚을 때까지 다섯 달.
//
// 결함의 정체는 값이 아니라 **손으로 잰 수가 배경이 늘면서 낡은 것**이다. 그래서 값을 고치는
// 대신 여기서 매번 계산한다: 램프 × 배경 **전 조합**을 WCAG 2.x 상대휘도로 재고 가장 나쁜
// 짝이 하한 미만이면 세운다. 배경 토큰이 하나 늘어도 자동으로 조합에 들어온다 — 사람이
// 표를 갱신할 것을 믿지 않는 것이 이 검사의 요점이다.
//
// ⚠️ 주석을 먼저 걷는다. tokens.css 주석은 "왜 이 값이면 안 되는가"를 적느라 배경 HEX 를
// 인용하고 있어서, 안 걷으면 주석 속 색이 토큰으로 잡힌다(위 HEX 검사가 isComment 를 두는 것과
// 같은 이유다).
// 2026-10-08 family-core: 하한을 **글자 4.5(WCAG AA 본문)** 로 올렸다. 단 --text-dim 은 글자 단이
// 아니라 placeholder·disabled 전용이라(WCAG 가 대비를 요구하지 않는 자리) 옛 하한 3.5 를 유지한다 —
// 그 대신 아래 "dim 용도" 검사가 그 단이 다른 자리에 새지 않는지를 본다.
const MIN_RATIO = 4.5
const DIM_TOKEN = '--text-dim'
const DIM_MIN_RATIO = 3.5
// 비텍스트(WCAG 1.4.11) — 액센트·포커스 링·의미색이 배경 위에서 **모양으로** 읽혀야 하는 하한.
const NONTEXT_MIN_RATIO = 3.0
const NONTEXT_TOKENS = ['--accent', '--focus-ring-color', '--ok', '--warn', '--err']
// 공허성 방지 — 위 MIN_TSX/MIN_CSS 와 같은 규칙. 접두사를 바꾸거나 램프를 다른 파일로 옮기면
// 조합이 0이 되어 "위반 없음"으로 초록이 된다. 지금 4×6=24 조합이라 하한을 절반쯤에 둔다.
const MIN_PAIRS = 12
const MIN_NONTEXT_PAIRS = 15 // 지금 5×6=30
const TOKENS_SRC = readFileSync(join('src/renderer/styles', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const relLum = (hex) =>
  [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + [0.2126, 0.7152, 0.0722][i] * v, 0)
const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const grab = (re) => [...TOKENS_SRC.matchAll(re)].map((m) => [m[1], m[2]])
// :root 안의 **선언이 아닌 것** (2026-10-08). 주석을 `/*` 없이 열면 그 글자부터 다음 `*/` 까지가
// 깨진 선언 하나가 되어 **바로 뒤 토큰을 삼킨다** — 브라우저는 조용히 버린다. 실제로 이 라운드에
// `--text-hi` 가 그렇게 사라져 본문 글자가 배경색이 됐는데, 위 정규식은 여전히 `--text-hi: #…` 를
// 찾아 대비를 "통과"로 쟀다. 그래서 :root 본문의 문장마다 `--이름:` 으로 시작하는지 본다.
for (const m of TOKENS_SRC.matchAll(/:root\s*\{([^}]*)\}/g)) {
  for (const stmt of m[1].split(';')) {
    const t = stmt.trim()
    if (t && !/^--[A-Za-z0-9_-]+\s*:/.test(t)) {
      violations.push(`src/renderer/styles/tokens.css  :root 안에 선언이 아닌 글자 — 열리지 않은 주석? → ${t.slice(0, 60)}`)
    }
  }
}
const ramp = grab(/(--text-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)
const surfaces = grab(/(--bg-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)
const pairs = ramp.flatMap(([tn, tv]) => surfaces.map(([bn, bv]) => [tn, bn, contrast(tv, bv)]))
if (pairs.length < MIN_PAIRS) {
  console.error(
    `대비 검사가 공허하다: 글자 ${ramp.length}종 × 배경 ${surfaces.length}종 = ${pairs.length}조합(하한 ${MIN_PAIRS}).\n` +
      'tokens.css 의 --text-* / --bg-* 접두사가 바뀌었거나 램프가 다른 파일로 갔다 — 스캐너를 고쳐라.'
  )
  process.exit(1)
}
const floorOf = (tn) => (tn === DIM_TOKEN ? DIM_MIN_RATIO : MIN_RATIO)
for (const [tn, bn, r] of pairs.filter(([tn, , r]) => r < floorOf(tn))) {
  violations.push(
    `src/renderer/styles/tokens.css  대비 ${r.toFixed(2)} < ${floorOf(tn)} — ${tn} 을 ${bn} 위에 얹으면 안 읽힌다` +
      ' (opacity 로 덮지 말고 램프의 명도를 올려라)'
  )
}
const textPairs = pairs.filter(([tn]) => tn !== DIM_TOKEN)
const worst = textPairs.reduce((a, b) => (a[2] <= b[2] ? a : b))

// 비텍스트 쌍(2026-10-08). `--focus-ring-color: var(--accent)` 처럼 별칭이면 끝까지 따라가 HEX 를 얻는다.
// 못 풀면(rgba·없는 토큰) **조용히 빼지 않고** 위반으로 적는다 — 빠진 쌍은 검사된 쌍처럼 보인다.
const tokenVal = Object.fromEntries(grab(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g).map(([n, v]) => [n, v.trim()]))
const resolveHex = (name, depth = 0) => {
  const v = tokenVal[name]
  if (!v || depth > 5) return null
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(v)
  return m ? resolveHex(m[1], depth + 1) : null
}
const nontextPairs = []
for (const tn of NONTEXT_TOKENS) {
  const hex = resolveHex(tn)
  if (!hex) {
    violations.push(`src/renderer/styles/tokens.css  비텍스트 대비 검사 불가 — ${tn} 이 6자리 HEX 로 풀리지 않는다`)
    continue
  }
  for (const [bn, bv] of surfaces) nontextPairs.push([tn, bn, contrast(hex, bv)])
}
if (nontextPairs.length < MIN_NONTEXT_PAIRS) {
  console.error(`비텍스트 대비 검사가 공허하다: ${nontextPairs.length}조합(하한 ${MIN_NONTEXT_PAIRS}). 토큰 이름을 확인하라.`)
  process.exit(1)
}
for (const [tn, bn, r] of nontextPairs.filter(([, , r]) => r < NONTEXT_MIN_RATIO)) {
  violations.push(
    `src/renderer/styles/tokens.css  비텍스트 대비 ${r.toFixed(2)} < ${NONTEXT_MIN_RATIO} — ${tn} 이 ${bn} 위에서 모양으로 안 읽힌다`
  )
}
const worstNontext = nontextPairs.reduce((a, b) => (a[2] <= b[2] ? a : b))

// CSS 중괄호 균형 검사: 주석·문자열 제거 후 {/} 개수 비교. (tokens.css 포함 전부 대상)
const STYLES_DIR = 'src/renderer/styles'
const braceErrors = []
for (const name of readdirSync(STYLES_DIR).filter(n => n.endsWith('.css'))) {
  const file = join(STYLES_DIR, name)
  const stripped = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '')
  const open = (stripped.match(/\{/g) || []).length
  const close = (stripped.match(/\}/g) || []).length
  if (open !== close) braceErrors.push(`${file}  { ${open} : } ${close}`)
}
if (braceErrors.length) {
  console.error('CSS 중괄호 불균형:\n' + braceErrors.join('\n'))
  process.exit(1)
}

// ── 글자 위 이중 감쇠 (2026-08-31, #161) ───────────────────────────────────
// 위 대비 게이트는 **램프 토큰 자체**만 잰다. `opacity` 로 한 번 더 흐려진 합성값은 못 본다.
// 그 사각지대에서 같은 병이 세 번 났다: `.pkg-row.missing td`(2.5) · `.bench-sec .hint`(2.57) ·
// 그리고 #161 이 훑어 찾은 11곳(1.88~3.10). 매번 사람이 눈으로 찾았다.
//
// ⚠️ **이 검사는 울타리가 아니다.** "이 opacity 가 글자에 닿나"는 정적으로 판정할 수 없다 —
// `.foo { opacity: .5 }` 의 `.foo` 안에 글자가 있는지는 CSS 만 봐서는 모르고, opacity 는 자손
// 전체에 곱해진다(위 `.ara-box.off` 가 정확히 그 모양이었다: 자기 자리엔 글자가 없고 안쪽
// textarea 를 2.36 으로 끌어내렸다). 그걸 규칙으로 흉내 내면 오탐이 쌓이고, 오탐이 쌓인 게이트는
// 사람이 무시한다. 그래서 **한 가지 모양만** 본다:
//
//   같은 규칙이 글자를 칠하면서(`color:` / `font-*:`) 동시에 자기를 흐린다(`0 < opacity < 1`)
//
// 이 모양은 오탐이 없다(그 규칙에 글자가 있다는 것을 규칙 자신이 말하고 있다). 대신 절반만
// 잡는다 — #161 의 11곳 중 6곳, 과거 두 건 중 `.hint` 하나. `opacity` 만 홀로 적힌 나머지는
// 여전히 사람이 봐야 한다. 그 절반을 남기고도 넣는 이유는 잡히는 쪽이 **가장 흔한 저작 동작**
// (라벨을 칠하고 그 자리에서 흐리기)이기 때문이고, 통과했다고 "글자 대비가 검사됐다"는 뜻은
// 아니라는 것을 여기 적어 둔다. 나머지 절반까지 보려면 정적 검사가 아니라 **렌더된 DOM** 에서
// 실효 opacity 사슬과 계산된 색을 재야 한다(e2e 축의 일이다 — CSS 만으로는 못 한다).
// `color:` 는 선언 처음에만 — `background: …` / `transition: color .15s` 는 콜론이 없어 안 걸린다.
const TEXT_DECL = /(?:^|[;{])\s*(?:color|font(?:-[a-z]+)?)\s*:/
const FADE_DECL = /(?:^|[;{])\s*opacity\s*:\s*(0?\.\d+)\s*(?:;|$)/
// ── 굵기 두 단 (2026-10-27, 2.0 4단계) ─────────────────────────────────────
// design-system-v2 §2: 400/500 두 단, 600 은 브랜드 `A.R.A` 글자(타이틀바·부팅 인사)만.
// 600 이상(·bold·bolder)을 쓰는 규칙은 선택자가 허용 목록에 있어야 한다. @font-face 의 굵기는
// 글꼴 파일의 범위 선언이지 칠하는 굵기가 아니라 뺀다.
// ⚠️ 못 보는 것: UA 기본 bold(b·strong·h*·th) — tokens.css 의 리셋 한 줄이 맡는다 — 와 TSX 인라인 style.
const HEAVY_DECL = /(?:^|[;{\s])font-weight\s*:\s*(?:[6-9]00|bold|bolder)\b/
const HEAVY_OK = /\.tb-name|\.boot-name|@font-face/
let heavyAllowed = 0
let ruleCount = 0
let dimRules = 0
for (const name of readdirSync(STYLES_DIR).filter((n) => n.endsWith('.css'))) {
  const file = join(STYLES_DIR, name)
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const chunk of src.split('}')) {
    const at = chunk.lastIndexOf('{')
    if (at < 0) continue
    ruleCount++
    const body = chunk.slice(at + 1)
    if (HEAVY_DECL.test(body)) {
      const selText = chunk.slice(0, at)
      if (HEAVY_OK.test(selText)) heavyAllowed++
      else {
        const sel = selText.split(/\r?\n/).filter((x) => x.trim()).slice(-2).join(' ').trim()
        violations.push(`${file}  굵기 600 이상은 브랜드(.tb-name·.boot-name)만 — ${sel} (400/500 을 쓸 것)`)
      }
    }
    // dim 용도 (2026-10-08): --text-dim 은 placeholder·disabled(+ 터미널 고스트 자동완성) 전용이다.
    // 선택자 **이름**으로 판정한다 — `.foo.off` 처럼 클래스로 끈 자리는 못 알아본다(그런 자리는
    // `:disabled` 를 쓰거나 --text-lo 로 올려라). 판정 기준이 선택자 글자라는 한계를 여기 적어 둔다.
    if (body.includes(`var(${DIM_TOKEN})`)) {
      dimRules++
      const selText = chunk.slice(0, at)
      if (!/placeholder|disabled|ghost/.test(selText)) {
        const sel = selText.split(/\r?\n/).filter((x) => x.trim()).slice(-2).join(' ').trim()
        violations.push(`${file}  --text-dim 은 placeholder·disabled 전용 — ${sel} (글자면 --text-lo 를 쓸 것)`)
      }
    }
    const fade = body.match(FADE_DECL)
    // `opacity: 0`(숨김)·`1`(복원)은 감쇠가 아니라 스위치다. 0<n<1 만 본다(`0.0` 포함해서 거른다).
    if (!fade || Number(fade[1]) <= 0) continue
    if (!TEXT_DECL.test(body)) continue
    const sel = chunk.slice(0, at).split('\n').filter((s) => s.trim()).slice(-3).join(' ').trim()
    violations.push(
      `${file}  글자 위 이중 감쇠 — ${sel} { … opacity: ${fade[1]} } ` +
        '(§1.3: 흐리게는 opacity 가 아니라 한 단계 아래 --text-* 토큰이다)'
    )
  }
}
// 공허성 방지 — 위 MIN_PAIRS 와 같은 규칙. 파서가 깨져 규칙을 0개로 읽으면 조용히 초록이 된다.
// dim 용도 검사의 양성 대조 — placeholder 규칙이 최소 몇 개는 dim 을 써야 정상이다(지금 18).
// 0 이면 "위반 없음"이 아니라 토큰 이름이 바뀌었거나 파서가 못 읽은 것이다.
if (dimRules < 5) {
  console.error(`dim 용도 검사가 공허하다: --text-dim 을 쓰는 규칙 ${dimRules}개(하한 5). 토큰 이름·파서를 확인하라.`)
  process.exit(1)
}
// 굵기 검사의 양성 대조 — 브랜드 600 두 곳이 안 잡히면 파서나 선택자 이름이 바뀐 것이다.
if (heavyAllowed < 2) {
  console.error(`굵기 검사가 공허하다: 허용 목록 규칙 ${heavyAllowed}개(하한 2 — .tb-name·.boot-name). 선택자·파서를 확인하라.`)
  process.exit(1)
}
if (ruleCount < 300) {
  console.error(`이중 감쇠 검사가 공허하다: 규칙 ${ruleCount}개만 읽혔다(하한 300). CSS 파서를 고쳐라.`)
  process.exit(1)
}

if (violations.length) {
  console.error('매직넘버 스캔 실패 — 토큰(var(--*))을 사용하세요:\n' + violations.join('\n'))
  process.exit(1)
}
console.log(
  `매직넘버 스캔 통과 (HEX/px/맨 transition 리터럴 없음, CSS 중괄호 균형 정상, 토큰 ${defined.size}종 전부 정의됨)\n` +
    `글자 대비 ${pairs.length}조합 통과(글자 ${MIN_RATIO} · ${DIM_TOKEN} ${DIM_MIN_RATIO}) — 가장 나쁜 글자 짝 ${worst[0]} × ${worst[1]} = ${worst[2].toFixed(2)}\n` +
    `비텍스트 대비 ${nontextPairs.length}조합 전부 ${NONTEXT_MIN_RATIO} 이상 — 가장 나쁜 짝 ${worstNontext[0]} × ${worstNontext[1]} = ${worstNontext[2].toFixed(2)}\n` +
    `--text-dim 용도 ${dimRules}규칙 전부 placeholder·disabled\n` +
    `굵기 600 이상 ${heavyAllowed}규칙 전부 허용 목록(브랜드·@font-face)`
)
