// 설명서 "붙어 보이는" 자리를 실제 Chromium 레이아웃으로 **잰다** — 눈으로 훑지 않는다.
//
// 왜: 준영님 제보(2026-09-05) "서버에 연결하기 파트 1번과 2번이 딱 붙어있어" 는 manual.html:257
// 의 2번 항목이 두 줄로 접히는 순간, 항목 사이 여백이 항목 **안**의 줄바꿈과 구별 안 되는 문제다
// (DOC-spacing-task.md). 1,077줄짜리 문서를 사람이 스크롤로 훑으면 이런 자리를 놓친다.
//
// 무엇을 재나(자리마다):
//   줄사이   = lineHeight − fontSize            (한 요소 안, 줄과 줄 사이 흰 공간)
//   항목사이 = 다음형제.top − 나.bottom + 줄사이  (실제로 눈에 보이는 분리)
//   비율     = 항목사이 / 줄사이
// 비율 < 2.0 이면 "항목 경계가 줄바꿈과 헷갈릴 수 있다"는 뜻(같은 페이지의 li 사례로 이미 확인됨).
//
// 🔴 판정은 여기서 안 낸다 — **원자료만** 낸다(tip-check.cjs 와 같은 규율). 비율<2 를 전부 목록으로
// 내되, 어떤 자리를 실제로 고칠지는 사람이 다음 정보로 가른다:
//   · folded(접힘) — getClientRects().length>1 또는 scrollHeight>lineHeight*1.5. 한 줄짜리는
//     붙어 보여도 경계가 이미 명확하므로 folded 만 우선순위가 높다.
//   · sameKind — 다음형제가 **같은 태그**(li-li, p-p, tr-tr, .note-.note)이거나 dt-dd 쌍일 때만
//     쟀다. 헤딩→본문(h3→p) 처럼 서로 다른 태그로 넘어가는 자리는 안 쟀다 — 글자 크기·굵기·색이
//     이미 달라 "같은 항목의 줄바꿈"으로 헷갈릴 여지가 없다(진짜 문제는 li-대-li 처럼 **모양이
//     같은 이웃**끼리다).
//   · hasRule — 요소(또는 tr 의 자식 td/th)에 border-bottom 이 있으면 그 경계는 이미 선으로
//     그어져 있다. 숫자상 비율<2 라도 육안으로 헷갈릴 수 없다 — 표 안 tr 이 여기 해당한다.
//
// 🔴 창을 안 띄운다: show:false + offscreen:true (준영님이 지금 그 PC 를 쓰고 계신다).
//
// 돌리는 법: npx electron tests/doc-spacing-check.cjs [phase]
//   phase 생략 시 'run'. 고치기 전/후를 비교하려면 각각 다른 phase 이름으로 두 번 돌린다.
// 산출물: agent_talk/doc-spacing-<phase>.json (+ 콘솔 요약)
const { app, BrowserWindow } = require('electron')
require('./_harnessGuard.cjs') // 창 대신 빨간 로그로 죽는 안전망(uncaughtException 가드) — ipcMain 이 없어 safeWc 는 안 쓴다
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

// 🔴 offscreen 창을 연달아 만들고 destroy 하면 GPU 프로세스가 상태를 잃고 두 번째 창부터
// ERR_FAILED 로 로드가 죽는다(이 저장소의 screenshot 계열 하네스가 전부 이걸 끈다 — 같은 규율).
app.disableHardwareAcceleration()

const ROOT = join(__dirname, '..')
const phase = process.argv[2] || 'run'
const REPORT = join(ROOT, 'agent_talk', `doc-spacing-${phase}.json`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const FILES = ['site/manual.html', 'site/index.html', 'site/changelog.html']
const WIDTHS = [1280, 820] // 태블릿·좁은 창일수록 더 많이 접힌다

// ── 렌더러에서 도는 탐침 ────────────────────────────────────────────────────
// probe.toString() 으로 직렬화해 executeJavaScript 에 넣는다(문자열 템플릿 안에 코드를 적으면
// 이스케이프 사고가 난다 — tip-check.cjs 의 교훈).
function probe() {
  const round = (v) => Math.round(v * 10) / 10
  const isNote = (el) => el.classList && el.classList.contains('note')

  function hasVisibleRule(el) {
    const own = getComputedStyle(el)
    if (parseFloat(own.borderBottomWidth) > 0 && own.borderBottomStyle !== 'none') return true
    if (el.tagName === 'TR') {
      // 표는 border 가 tr 이 아니라 자식 td/th 에 붙는다(site.css .tbl td, .keys td 등).
      return Array.from(el.children).some((c) => {
        const cs = getComputedStyle(c)
        return parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomStyle !== 'none'
      })
    }
    return false
  }

  function measure(scope) {
    const cand = Array.from(scope.querySelectorAll('p, li, h2, h3, h4, tr, dt, dd, .note'))
    const items = []
    for (const el of cand) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue // 화면 밖/숨김

      const sib = el.nextElementSibling
      if (!sib) continue
      const sameKind =
        (el.tagName === sib.tagName && isNote(el) === isNote(sib)) ||
        (isNote(el) && isNote(sib)) ||
        (el.tagName === 'DT' && sib.tagName === 'DD')
      if (!sameKind) continue // 헤딩→본문처럼 모양이 다른 이웃은 헷갈릴 여지가 없어 안 잰다

      const sr = sib.getBoundingClientRect()
      if (sr.width === 0 && sr.height === 0) continue

      const cs = getComputedStyle(el)
      const fontSize = parseFloat(cs.fontSize) || 0
      const rects = el.getClientRects()
      let lineHeightPx
      if (cs.lineHeight === 'normal') {
        // 'normal' 은 getComputedStyle 이 px 로 안 준다 — 접힌 요소는 줄 사이 실측으로 대체.
        lineHeightPx = rects.length > 1 ? rects[1].top - rects[0].top : fontSize * 1.2
      } else {
        lineHeightPx = parseFloat(cs.lineHeight)
      }
      const lineGap = lineHeightPx - fontSize
      const folded = rects.length > 1 || el.scrollHeight > lineHeightPx * 1.5
      const gapToNext = sr.top - r.bottom
      const itemGap = gapToNext + lineGap
      const ratio = lineGap > 0.01 ? itemGap / lineGap : null

      items.push({
        tag: el.tagName.toLowerCase() + (isNote(el) ? '.note' : ''),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
        y: round(r.top),
        folded,
        rectCount: rects.length,
        fontSize: round(fontSize),
        lineHeightPx: round(lineHeightPx),
        lineGap: round(lineGap),
        gapToNext: round(gapToNext),
        itemGap: round(itemGap),
        ratio: ratio === null ? null : round(ratio),
        hasRule: hasVisibleRule(el)
      })
    }
    return items
  }

  const main = document.querySelector('main')
  return {
    title: document.title,
    vw: window.innerWidth,
    scrollHeight: document.body.scrollHeight,
    items: main ? measure(main) : []
  }
}

// ── 실행 ────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const results = []

  // 🔴 조합마다 창을 새로 만들고 destroy 하면 offscreen GPU 프로세스가 상태를 잃고 두 번째
  // 창부터 ERR_FAILED 로 로드가 죽는다(실측 2026-09-05). 창 하나를 만들어 setContentSize +
  // loadFile 로 재사용한다 — 스크린샷 계열 하네스와 달리 여기는 창을 계속 살려 둬도 안전하다
  // (매번 새 문서를 로드해 이전 페이지의 DOM 이 안 남는다).
  const win = new BrowserWindow({
    width: WIDTHS[0],
    height: 1000,
    useContentSize: true,
    show: false, // 🔴 준영님 화면 위로 뜨지 않는다
    backgroundColor: '#0d1119',
    webPreferences: {
      offscreen: true, // 🔴 화면 밖 렌더 — 레이아웃은 그대로 돈다
      sandbox: true
    }
  })

  for (const file of FILES) {
    for (const width of WIDTHS) {
      win.setContentSize(width, 1000)
      await win.loadFile(join(ROOT, file))
      await win.webContents.executeJavaScript('document.fonts.ready.then(()=>true)')
      await wait(300) // 웹폰트 교체 후 리플로 안정화(줄바꿈 위치가 바뀔 수 있다)

      const raw = await win.webContents.executeJavaScript(`(${probe.toString()})()`)
      results.push({ file, width, ...raw })
    }
  }
  win.destroy()

  const flagged = []
  for (const r of results) {
    for (const it of r.items) {
      if (it.ratio !== null && it.ratio < 2.0) {
        flagged.push({ file: r.file, width: r.width, ...it })
      }
    }
  }

  writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), phase, results, flagged }, null, 1))

  console.log('─'.repeat(78))
  console.log(`phase=${phase} · 잰 파일×폭 조합 ${results.length}개 · 비율<2.0 자리 ${flagged.length}개`)
  console.log('─'.repeat(78))
  const foldedBad = flagged.filter((f) => f.folded && !f.hasRule)
  const singleBad = flagged.filter((f) => !f.folded && !f.hasRule)
  const ruled = flagged.filter((f) => f.hasRule)
  console.log(`  접힘+비율<2 (진짜 위험) : ${foldedBad.length}`)
  console.log(`  한줄+비율<2 (경계 명확) : ${singleBad.length}`)
  console.log(`  경계선 있음(무관)       : ${ruled.length}`)
  for (const f of foldedBad) {
    console.log(`  🔴 [${f.file} @${f.width}px] <${f.tag}> ratio=${f.ratio} gap=${f.gapToNext}px lineGap=${f.lineGap}px "${f.text}"`)
  }
  console.log('─'.repeat(78))
  for (const r of results) console.log(`  scrollHeight ${r.file} @${r.width}px = ${r.scrollHeight}px`)
  console.log('─'.repeat(78))
  console.log('원자료: ' + REPORT)

  app.exit(0)
})

setTimeout(() => {
  console.log('doc-spacing-check timeout')
  app.exit(1)
}, 120000)
