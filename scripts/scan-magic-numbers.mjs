// 매직넘버 스캔 (계획서 §D.3). 컴포넌트/인터랙션 CSS·TSX에서 토큰 우회 HEX/px 감지.
// tokens.css는 예외(토큰 정의부). CI 게이트용 — 위반 시 exit 1.
// + CSS 중괄호 균형 검사(BLOCKER-3 재발 방지 — vite는 깨진 CSS를 그대로 통과시킨다).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['src/renderer/components', 'src/renderer/interactions']
const EXCLUDE = ['tokens.css']
const HEX = /#[0-9a-fA-F]{3,8}\b/
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
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // 인라인 SVG viewBox 등 비시각 좌표는 예외 (§D.3 b)
      if (/viewBox|stroke-width|strokeWidth|cx=|cy=|\br=|points=/.test(line)) return
      if (HEX.test(line)) violations.push(`${file}:${i + 1}  HEX 리터럴  → ${line.trim()}`)
      else if (PX_PROP.test(line)) violations.push(`${file}:${i + 1}  px 리터럴  → ${line.trim()}`)
    })
  }
}

// UI-font5(2026-08-11): styles/ 는 위 ROOTS 밖이라 검사를 안 받고 있었다 — 그 사이
// shell.css·interactions.css 에 font-size 리터럴이 **229곳, 12종**(9~15.5px) 쌓였고,
// 크기가 흩어져 있어 "UI 글자를 키운다"를 한 번에 할 방법이 없었다(UI-font3 이 실험만 하고
// 적용하지 못한 이유). 척도를 tokens.css 로 모은 뒤, 다시 흩어지지 않게 여기서 막는다.
// 범위는 font-size 하나로 좁힌다 — styles/ 의 width·padding 까지 지금 토큰화하는 것은
// 별개의 큰 작업이고, 이 가드의 목적은 "글자 크기가 다시 흩어지는 것"을 막는 것이다.
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
      if (HEX.test(line) && !bare.startsWith('/*') && !bare.startsWith('*') && !bare.startsWith('//')) {
        violations.push(`${file}:${i + 1}  HEX 리터럴(tokens.css 의 색 토큰을 쓸 것)  → ${bare}`)
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
console.log('매직넘버 스캔 통과 (HEX/px 리터럴 없음, CSS 중괄호 균형 정상)')
