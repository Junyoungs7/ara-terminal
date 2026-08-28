// i18n 키 스캔 (AUDIT-R6 ①). `t()` 는 키가 없으면 **키 문자열을 그대로 반환한다**
// (`src/renderer/i18n/index.ts:24`). 그래서 `dlg.close` 라는 글자가 찍힌 버튼이 배포 직전
// 감사까지 살아남았다 — 타입도 테스트도 사람 눈도 못 잡는다. 그 화면을 열어 봐야만 보인다.
//
// 두 검사의 등급이 다르다:
//  · 없는 키 → exit 1 (화면에 키 문자열이 그대로 나간다)
//  · 안 쓰는 키 → 경고만 (나가는 화면이 안 틀린다. 정리는 별건이다)
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const KO_PATH = 'src/renderer/i18n/ko.json'
const KO = JSON.parse(readFileSync(KO_PATH, 'utf8'))

function walk(dir) {
  let out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out = out.concat(walk(p))
    else if (['.ts', '.tsx'].includes(extname(p))) out.push(p)
  }
  return out
}

//  t('키')  ·  t("키")  ·  t('접두어.' + x)  — 리터럴이 `t(` 바로 뒤에 오는 자리
const T_LITERAL = /\bt\(\s*(['"])([^'"\n]*?)\1/g
//  t(`접두어.${x}`) — 템플릿의 고정 앞부분도 접두어다
const T_TEMPLATE = /\bt\(\s*`([^`$\n]*)\$\{/g
//  t(변수) · t(MAP[k]) · t(a ? 'x' : 'y') — 정적으로 못 푸는 자리
const T_DYNAMIC = /\bt\(\s*[A-Za-z_$([]/
//  파일 어디에 있든 따옴표에 싸인 문자열 전부(맵의 값·prop 기본값·상수 테이블…).
//  "안 쓰는 키" 판정은 `t()` 안만 봐서는 안 된다 — 키는 `const TIP = { ok: 'x.y' }` 처럼
//  멀리 떨어진 테이블에 적히고 `t(TIP[s])` 로 쓰인다.
const ANY_LITERAL = /(['"`])([A-Za-z0-9_.]{1,60})\1/g

const files = walk('src')

/**
 * **공허성 방지**(2026-08-28 — Orca 의 래칫 테스트에서 가져온 규칙).
 *
 * 스캐너가 훑을 파일을 하나도 못 찾으면 위반도 0이라 **조용히 통과한다.** 디렉터리를 옮기거나
 * 확장자 목록이 어긋나면 그날부터 이 게이트는 아무것도 안 지키면서 초록으로 남는다 —
 * 게이트와 위약(placebo)의 차이가 이 한 줄이다. 하한은 현재 수(약 190)의 절반쯤에 둔다.
 */
const MIN_FILES = 100
if (files.length < MIN_FILES) {
  console.error(
    `i18n 스캔이 공허하다: 소스 ${files.length}개만 찾았다(하한 ${MIN_FILES}).\n` +
      'walk() 의 루트나 확장자 목록이 코드베이스와 어긋났다 — 스캐너를 고쳐라.'
  )
  process.exit(1)
}

const missing = []      // {file, line, key}
const prefixes = new Set()
const literals = new Set()
const dynamicFiles = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (file.replace(/\\/g, '/') === 'src/renderer/i18n/index.ts') continue // t() 정의부

  for (const m of text.matchAll(ANY_LITERAL)) literals.add(m[2])
  for (const m of text.matchAll(T_TEMPLATE)) if (m[1].endsWith('.')) prefixes.add(m[1])

  const lines = text.split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(T_LITERAL)) {
      const key = m[2]
      // ⚠️ 접두어 조립(`t('console.svc.act.' + action)`)이 이 저장소에 38곳 있다.
      // 이걸 안 거르면 없는 키 27건 중 24건이 오탐이 된다 — 사람이 무시하는 게이트가 된다.
      if (key.endsWith('.')) prefixes.add(key)
      else if (!(key in KO)) missing.push({ file, line: i + 1, key })
    }
    if (T_DYNAMIC.test(line)) {
      if (!dynamicFiles.includes(file)) dynamicFiles.push(file)
    }
  })
}

// 접두어는 `t()` 안에서만 조립되지 않는다. `labelKey={(v) => 'ui.scale.' + v}` 처럼
// 멀리서 만들어 `t(labelKey(o))` 로 넘기는 자리가 SettingsDrawer 에만 다섯 곳이다.
// 그래서 **소스 어디에 있든 점으로 끝나는 키 모양 리터럴**을 접두어로 본다.
// 무엇을 접두어로 봤는지는 아래에서 전부 출력한다 — 조용히 넓게 덮으면 안 된다.
for (const lit of literals) if (/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*\.$/.test(lit)) prefixes.add(lit)

const startsWithPrefix = (key) => [...prefixes].some((p) => key.startsWith(p))
const unused = Object.keys(KO).filter((k) => !literals.has(k) && !startsWithPrefix(k))

console.log(`i18n 스캔 — 소스 ${files.length}개 / ko.json 키 ${Object.keys(KO).length}개 / 조립 접두어 ${prefixes.size}종`)
console.log(`  접두어: ${[...prefixes].sort().join(' ')}`)

if (unused.length) {
  console.log(`\n[안 쓰는 키] ${unused.length}건 — 경고(정리 대상, 게이트를 막지 않는다)`)
  for (const k of unused) console.log(`  ${k}`)
}

if (dynamicFiles.length) {
  console.log(`\n[동적 키를 쓰는 파일] ${dynamicFiles.length}개 — 이 근처의 "안 쓰는 키" 판정은 못 믿는다`)
  for (const f of dynamicFiles) console.log(`  ${f}`)
}

if (missing.length) {
  console.error(`\n[없는 키] ${missing.length}건 — ko.json 에 없다. 화면에 키 문자열이 그대로 찍힌다`)
  for (const m of missing) console.error(`  ${m.file}:${m.line}  ${m.key}`)
  process.exit(1)
}
console.log('\ni18n 스캔 통과 (없는 키 0건)')
