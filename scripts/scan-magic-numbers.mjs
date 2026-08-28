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
// ⏸ border-radius 는 **아직 안 건다**(2026-08-28 AUDIT-R6 에서 재고 뒤 보류, #149).
// 같은 병이 같은 자리에 퍼져 있는 것은 맞다 — **33곳, 13종**(1·2·3·4·5·6·7·8·10·11·20px),
// 그중 `3px` 하나가 **열여섯 곳**이라 이름 없는 사실상의 토큰이다.
// 그런데 **순서가 반대다.** font-size 때는 척도를 tokens.css 로 모은 *뒤* 가드를 걸었다(위 문단).
// radius 는 아직 안 모았고, 지금 토큰(4·6·8px)이 덮는 것은 33건 중 **7건뿐**이다 —
// 나머지 26건은 **쓸 토큰이 존재하지 않는다.** 그 상태로 가드만 켜면 게이트가 없는 토큰을
// 요구하게 된다(§ var() 폴백에서 폴백 있는 것을 통과시킨 것과 같은 이유).
// 되살릴 때: #149 에서 `--radius-xs: 3px` 를 추가하고 33곳을 정리한 **뒤**, 아래 두 줄을 켠다.
//   const STYLES_BR = /border-radius\s*:\s*[^;]*\b[0-9.]+px/i
//   const PILL = /border-radius\s*:\s*9{3,}px/i   // 알약은 척도가 아니라 관용구 — 예외로 둔다
const STYLES_FS = /font-size\s*:\s*[^;]*\b[0-9.]+px/i
for (const name of readdirSync('src/renderer/styles').filter((n) => n.endsWith('.css') && !EXCLUDE.includes(n))) {
  const file = join('src/renderer/styles', name)
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (STYLES_FS.test(line)) {
        violations.push(`${file}:${i + 1}  font-size px 리터럴(tokens.css 의 --fs-* 를 쓸 것)  → ${line.trim()}`)
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
    })
}

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

if (violations.length) {
  console.error('매직넘버 스캔 실패 — 토큰(var(--*))을 사용하세요:\n' + violations.join('\n'))
  process.exit(1)
}
console.log(`매직넘버 스캔 통과 (HEX/px 리터럴 없음, CSS 중괄호 균형 정상, 토큰 ${defined.size}종 전부 정의됨)`)
