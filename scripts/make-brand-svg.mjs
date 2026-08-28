// 브랜드 마크 생성기 — A.R.A 아이콘 v2 (2026-08-27 준영님 시트 기반).
//
// **왜 생성하나.** 이 마크의 핵심은 터미널 창을 도는 **고리**인데, 고리는 손으로 베지어를 찍으면
// 반드시 어딘가 어긋나 "평면에 그은 선"이 된다(준영님 1차 피드백이 정확히 그것이었다).
// 그래서 실제 타원을 촘촘히 훑어 좌표를 뽑는다. 두 가지가 이 마크를 마크로 만든다:
//
//  ① 고리를 획(stroke)이 아니라 **면(path)** 으로 만든다 — 법선 방향 두께가 위치마다 다르다.
//     뒤쪽(위)에서 가늘고 앞쪽(아래)에서 굵다. 획으로는 굵기를 도중에 바꿀 수 없다.
//  ② 같은 면을 **두 번** 그린다 — 창 뒤에 통째로 한 벌, 창 앞에 앞쪽 절반만 한 벌.
//     두 벌의 모양·색이 완전히 같아 이음매가 없다(준영님 2차 피드백: "고리를 끊지 말고").
//     자르는 선은 타원의 장축과 같아 경계가 정확히 양 끝점에 떨어진다.
//
// 모양을 바꾸려면 아래 숫자(RX/RY/DEG/두께)만 고치고 다시 돌린다:
//   npm run icons:svg && npm run icons:png
//
// 산출물(전부 덮어쓴다 — 손으로 고치지 말 것):
//   resources/icons/ara-icon.svg   512 전체 구성. electron-builder 가 쓰는 PNG 의 원본
//   assets/brand/ara-icon.svg      같은 것(디자인 마스터 보관)
//   assets/brand/ara-favicon.svg   64px 이하용 **덜어낸 판**(랙 없음)
//   site/assets/ara-icon.svg       사이트 — 24px 헤더 + 파비콘이라 덜어낸 판
//   video/public/logo.svg          영상 — 22px/92px 둘 다 쓰므로 덜어낸 판
//   src/renderer/components/brandMark.ts  타이틀바 마크(BrandOrb)가 쓸 고리 경로
//   src/renderer/index.html        앱 파비콘 — 파일 통째가 아니라 <link rel="icon"> 의 href **한 줄**
//
// **왜 index.html 까지 여기서 쓰나.** 2026-08-27 리브랜드 때 위 여섯은 다 갈렸는데 index.html 만
// 생성기 밖에 있어서 **걷어낸 배 마크가 파비콘으로 혼자 살아남았다**(AUDIT-R4 ①). 마크는 한 곳에서
// 나와야 한다 — 손으로 따라 고치는 자리가 하나라도 남으면 다음 리브랜드에서 또 그 하나가 남는다.
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const rad = (d) => (d * Math.PI) / 180

/**
 * 굵기가 변하는 고리를 닫힌 면으로. 위(뒤)에서 가늘고 아래(앞)에서 굵다.
 * evenodd 로 채우려고 바깥·안쪽 테두리를 각각 하나의 서브패스로 낸다.
 */
function ringPath(cx, cy, rx, ry, deg, wThin, wThick, steps = 160) {
  const c = Math.cos(rad(deg))
  const s = Math.sin(rad(deg))
  const out = []
  const inn = []
  for (let i = 0; i <= steps; i++) {
    const t = (2 * Math.PI * i) / steps
    const x = rx * Math.cos(t)
    const y = ry * Math.sin(t)
    // 접선 → 법선
    const dx = -rx * Math.sin(t)
    const dy = ry * Math.cos(t)
    const L = Math.hypot(dx, dy)
    const nx = dy / L
    const ny = -dx / L
    const w = wThin + (wThick - wThin) * (0.5 + 0.5 * Math.sin(t))
    for (const [arr, sgn] of [
      [out, 1],
      [inn, -1]
    ]) {
      const px = x + (nx * w * sgn) / 2
      const py = y + (ny * w * sgn) / 2
      arr.push([cx + px * c - py * s, cy + px * s + py * c])
    }
  }
  const f = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`
  return `M${out.map(f).join(' L')} M${inn.reverse().map(f).join(' L')} Z`
}

/** 장축 아래쪽 반평면 — 고리의 '앞쪽'만 남긴다. */
function frontClip(cx, cy, deg, reach = 900) {
  const c = Math.cos(rad(deg))
  const s = Math.sin(rad(deg))
  const p1 = [cx + c * reach, cy + s * reach]
  const p2 = [cx - c * reach, cy - s * reach]
  const p3 = [p2[0] - s * reach, p2[1] + c * reach]
  const p4 = [p1[0] - s * reach, p1[1] + c * reach]
  return [p1, p2, p3, p4].map((p) => `${p[0].toFixed(0)},${p[1].toFixed(0)}`).join(' ')
}

function pointOn(cx, cy, rx, ry, deg, tDeg) {
  const c = Math.cos(rad(deg))
  const s = Math.sin(rad(deg))
  const lx = rx * Math.cos(rad(tDeg))
  const ly = ry * Math.sin(rad(tDeg))
  return [cx + lx * c - ly * s, cy + lx * s + ly * c]
}

/** 4각 반짝임. 허리를 좁혀 별처럼 뾰족하게 만든다. */
function star([x, y], arm, waist) {
  const n = (v) => v.toFixed(1)
  return (
    `M ${n(x)} ${n(y - arm)} Q ${n(x + waist)} ${n(y - waist)} ${n(x + arm)} ${n(y)} ` +
    `Q ${n(x + waist)} ${n(y + waist)} ${n(x)} ${n(y + arm)} ` +
    `Q ${n(x - waist)} ${n(y + waist)} ${n(x - arm)} ${n(y)} ` +
    `Q ${n(x - waist)} ${n(y - waist)} ${n(x)} ${n(y - arm)} Z`
  )
}

const write = (rel, body) => {
  const p = join(ROOT, rel)
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body, 'utf8')
  console.log(`  ${rel}  ${(Buffer.byteLength(body) / 1024).toFixed(1)}KB`)
}

/**
 * SVG → `href="…"` 에 그대로 넣는 data URI.
 * encodeURIComponent 로 전부 인코딩하면 5.5KB 가 두 배로 분다(공백이 전부 %20). HTML 속성 안에서
 * 실제로 깨지는 문자만 바꾼다 — 속성 따옴표는 `"` 를 쓰므로 SVG 안의 `"` 는 `'` 로 내린다.
 * `%` 를 **가장 먼저** 바꾼다: 뒤 치환이 만드는 `%` 를 다시 인코딩하면 안 된다.
 */
function dataUri(svg) {
  const body = svg
    .replace(/<!--[\s\S]*?-->/g, '') // 한 줄로 접으면 주석 뒤가 전부 주석이 된다
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/"/g, "'")
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/&/g, '%26')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
  return `data:image/svg+xml,${body}`
}

/**
 * index.html 의 `<link rel="icon">` href 를 갈아 끼운다. 파일을 통째로 쓰지 않는 유일한 산출물이라
 * 따로 둔다 — 그 안에 CSP·title·마운트 지점이 함께 있어 생성기가 소유할 수 없다.
 * 자리를 못 찾으면 **조용히 넘어가지 않고 죽는다.** 조용히 넘어가면 정확히 리브랜드 때 벌어진 일
 * (옛 마크가 그대로 남는데 생성기는 성공했다고 말하는 것)이 다시 벌어진다.
 */
function patchFavicon(rel, svg) {
  const p = join(ROOT, rel)
  const src = readFileSync(p, 'utf8')
  const re = /(rel="icon"[^>]*?href=")[^"]*(")/
  if (!re.test(src)) throw new Error(`${rel}: <link rel="icon"> href 를 못 찾았다 — 표시를 확인해라`)
  const uri = dataUri(svg)
  const out = src.replace(re, (_m, a, b) => a + uri + b)
  writeFileSync(p, out, 'utf8')
  console.log(`  ${rel}  파비콘 href 갱신 (${(Buffer.byteLength(uri) / 1024).toFixed(1)}KB data URI)`)
}

// ── 512 마스터 ───────────────────────────────────────────────────────────────
const CX = 298
const CY = 219
const RX = 178
const RY = 100
const DEG = -20
const RING = ringPath(CX, CY, RX, RY, DEG, 5.5, 18)
const CLIP = frontClip(CX, CY, DEG)
const SPARK = pointOn(CX, CY, RX, RY, DEG, -42)
const TOP = CY - Math.hypot(RX * Math.sin(rad(DEG)), RY * Math.cos(rad(DEG)))

const full = `<!-- A.R.A 아이콘 v2 — **생성물이다. 손으로 고치지 말 것**(scripts/make-brand-svg.mjs).
     서버 랙(원격) + 터미널 창(하는 일) + 고리와 반짝임(AI 가 돈다). 2026-08-27 준영님 시트 기반.
     고리가 왜 면이고 왜 두 번 그리는지는 생성기 주석에 있다. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"
     role="img" aria-label="A.R.A" shape-rendering="geometricPrecision">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0%" stop-color="#232936"/><stop offset="55%" stop-color="#141922"/><stop offset="100%" stop-color="#0b0e14"/>
    </linearGradient>
    <radialGradient id="bgLight" cx="30%" cy="18%" r="70%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".07"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <!-- 고리 — 뒤(위)는 어둡고 앞(아래)은 밝다. 같은 금색의 명암 차이만으로 깊이를 만든다. -->
    <linearGradient id="ringG" x1="0" y1="${TOP.toFixed(0)}" x2="0" y2="${(2 * CY - TOP).toFixed(0)}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#8d6f28"/><stop offset="38%" stop-color="#b8912f"/>
      <stop offset="72%" stop-color="#dab63f"/><stop offset="100%" stop-color="#fbf3e2"/>
    </linearGradient>
    <linearGradient id="rack" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2b323f"/><stop offset="100%" stop-color="#151a22"/>
    </linearGradient>
    <linearGradient id="edge" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0%" stop-color="#fbf3e2"/><stop offset="50%" stop-color="#d4af37"/><stop offset="100%" stop-color="#a87d24"/>
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".10"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000000" flood-opacity=".55"/>
    </filter>
    <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="frontHalf"><polygon points="${CLIP}"/></clipPath>
  </defs>

  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bgLight)"/>

  <!-- ① 고리 한 벌 전체 — 창·랙 뒤로 지나간다. -->
  <path d="${RING}" fill="url(#ringG)" fill-rule="evenodd"/>

  <!-- ② 서버 랙 3단 — 왼쪽에서 창에 반쯤 가린다. -->
  <g filter="url(#soft)">
    <rect x="88" y="168" width="138" height="48" rx="12" fill="url(#rack)" stroke="#454e5e" stroke-width="1.6"/>
    <rect x="88" y="228" width="138" height="48" rx="12" fill="url(#rack)" stroke="#454e5e" stroke-width="1.6"/>
    <rect x="88" y="288" width="138" height="48" rx="12" fill="url(#rack)" stroke="#454e5e" stroke-width="1.6"/>
  </g>
  <g fill="#d4af37" opacity=".85">
    <circle cx="112" cy="192" r="6"/><circle cx="112" cy="252" r="6"/><circle cx="112" cy="312" r="6"/>
  </g>
  <g fill="#79828f">
    <circle cx="136" cy="192" r="6"/><circle cx="136" cy="252" r="6"/><circle cx="136" cy="312" r="6"/>
  </g>

  <!-- ③ 터미널 창 -->
  <g filter="url(#soft)">
    <rect x="200" y="150" width="196" height="142" rx="26" fill="#0d1016" stroke="url(#edge)" stroke-width="7.5"/>
  </g>
  <rect x="206" y="156" width="184" height="60" rx="20" fill="url(#glass)"/>
  <g fill="#d4af37" opacity=".8">
    <circle cx="338" cy="176" r="5"/><circle cx="356" cy="176" r="5"/><circle cx="374" cy="176" r="5"/>
  </g>
  <path d="M234 202 L266 226 L234 250" fill="none" stroke="#f7edd8" stroke-width="17"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M282 252 L332 252" fill="none" stroke="#f7edd8" stroke-width="17" stroke-linecap="round"/>

  <!-- ④ 같은 고리를 앞쪽 절반만 다시 — 창 앞을 지난다. 모양이 같아 이음매가 없다. -->
  <g clip-path="url(#frontHalf)">
    <path d="${RING}" fill="#0b0e14" fill-rule="evenodd" transform="translate(0,3)" opacity=".55"/>
    <path d="${RING}" fill="url(#ringG)" fill-rule="evenodd"/>
  </g>

  <!-- ⑤ 반짝임 — 고리가 창 뒤로 들어가는 오른쪽 위. -->
  <path d="${star(SPARK, 30, 6)}" fill="#fdf7ea" filter="url(#glow)"/>
  <circle cx="${SPARK[0].toFixed(0)}" cy="${SPARK[1].toFixed(0)}" r="4" fill="#ffffff"/>
</svg>
`

// ── 32 덜어낸 판 ─────────────────────────────────────────────────────────────
// 64px 이하는 이쪽이다. 랙을 버리는 이유: 그 크기에서 막대 셋과 점 여섯은 얼룩으로 뭉친다.
// 고리는 남긴다 — 멀리서 이 마크를 알아보게 하는 것이 고리의 실루엣이다.
const C2 = [16, 16.2]
const R2X = 14.2
const R2Y = 8
const RING2 = ringPath(C2[0], C2[1], R2X, R2Y, DEG, 1.15, 2.6, 96)
const CLIP2 = frontClip(C2[0], C2[1], DEG, 60)
const SPARK2 = pointOn(C2[0], C2[1], R2X, R2Y, DEG, -42)
const TOP2 = C2[1] - Math.hypot(R2X * Math.sin(rad(DEG)), R2Y * Math.cos(rad(DEG)))

const small = `<!-- A.R.A 파비콘 v2 — **생성물이다**(scripts/make-brand-svg.mjs).
     16~64px 용으로 덜어낸 판: 랙을 버리고 창·고리·반짝임만 남긴다. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"
     role="img" aria-label="A.R.A" shape-rendering="geometricPrecision">
  <defs>
    <linearGradient id="rg2" x1="0" y1="${TOP2.toFixed(1)}" x2="0" y2="${(2 * C2[1] - TOP2).toFixed(1)}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#8d6f28"/><stop offset="45%" stop-color="#c19733"/>
      <stop offset="100%" stop-color="#fbf3e2"/>
    </linearGradient>
    <linearGradient id="eg2" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fbf3e2"/><stop offset="100%" stop-color="#c08f2a"/>
    </linearGradient>
    <clipPath id="fh2"><polygon points="${CLIP2}"/></clipPath>
  </defs>
  <rect width="32" height="32" rx="7" fill="#12161d"/>
  <path d="${RING2}" fill="url(#rg2)" fill-rule="evenodd"/>
  <rect x="8.6" y="10.4" width="14.8" height="11.4" rx="2.8" fill="#0d1016" stroke="url(#eg2)" stroke-width="1.7"/>
  <path d="M12 13.7 L14.7 15.9 L12 18.1" fill="none" stroke="#f7edd8" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M16.8 18.3 L20.4 18.3" fill="none" stroke="#f7edd8" stroke-width="1.8" stroke-linecap="round"/>
  <g clip-path="url(#fh2)"><path d="${RING2}" fill="url(#rg2)" fill-rule="evenodd"/></g>
  <path d="${star(SPARK2, 3.6, 0.9)}" fill="#fdf7ea"/>
</svg>
`

// ── 타이틀바 마크(BrandOrb) 가 쓸 경로 ───────────────────────────────────────
const R3X = 13.8
const R3Y = 7.8
const RING3 = ringPath(C2[0], C2[1], R3X, R3Y, DEG, 1.0, 2.3, 96)
const CLIP3 = frontClip(C2[0], C2[1], DEG, 60)
const SPARK3 = pointOn(C2[0], C2[1], R3X, R3Y, DEG, -42)

const markTs = `// **생성물이다 — 손으로 고치지 말 것**(scripts/make-brand-svg.mjs).
// 타이틀바 마크(BrandOrb.tsx)가 쓰는 고리 경로. 좌표를 손으로 찍으면 고리가 어긋나 "그은 선"이 된다.
export const MARK_RING = '${RING3}'
export const MARK_FRONT_CLIP = '${CLIP3}'
export const MARK_SPARK = '${star(SPARK3, 3.4, 0.9)}'
`

console.log('브랜드 마크 생성:')
write('resources/icons/ara-icon.svg', full)
write('assets/brand/ara-icon.svg', full)
write('assets/brand/ara-favicon.svg', small)
write('site/assets/ara-icon.svg', small)
write('video/public/logo.svg', small)
write('src/renderer/components/brandMark.ts', markTs)
patchFavicon('src/renderer/index.html', small)
console.log('→ PNG 도 다시 뽑으려면: npm run icons:png')
