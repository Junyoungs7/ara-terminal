// 3차 R1-B 코드 보기 3차 — 리치 마크다운·리뷰 메모·HTML 미리 보기(샌드박스)·Mermaid·CSV/TSV·새 탭 옴니박스.
// 저장소는 임시 폴더에 git init 한 것만. 작성만 — 실행은 메인(phase2-common).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, tempDir, rmDir } from './fixtures'

const side = '.aiws-side'
const panel = '[data-aiws="explorer"]'

const MD = '---\ntitle: demo\n---\n\n# Title\n\n* one\n* two\n\nSome __bold__ text here.\n\n```mermaid\ngraph TD; A-->B\n```\n'
const HTML =
  '<!doctype html><html><body><h1 id="h">Preview OK</h1><p id="o">-</p><img id="r" src="https://example.com/x.png"><img id="l" src="pic.svg">' +
  '<script>document.getElementById("o").textContent = (function(){ try { return typeof parent.document.body } catch (e) { return "blocked" } })()</script></body></html>'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'

function makeRepo(): { root: string; repo: string } {
  const root = realpathSync(tempDir('ara-e2e-p3r1b-'))
  const repo = join(root, 'shop-api')
  mkdirSync(join(repo, 'site'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), MD)
  writeFileSync(join(repo, 'data.csv'), 'name,n\nb,10\nA,9\nc,100\n')
  writeFileSync(join(repo, 'flow.mmd'), 'graph LR; X-->Y\n')
  writeFileSync(join(repo, 'site', 'index.html'), HTML)
  writeFileSync(join(repo, 'site', 'pic.svg'), SVG)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return { root, repo }
}

async function openProject(app: ElectronApplication, page: Page, repo: string): Promise<void> {
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await expect(page.locator(side)).toBeVisible()
  await app.evaluate(({ dialog: d }, picked) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof d.showOpenDialog
  }, repo)
  await page.click(`${side} [data-aiws="add-project"]`)
  const mainRow = page.locator(`${side} .aiws-row`).filter({ hasText: 'main' })
  await mainRow.click()
  await expect(mainRow).toHaveAttribute('aria-current', 'true')
  await page.click('.rbar [data-rbar="explorer"]')
}
const row = (page: Page, name: string) => page.locator(`${panel} .frow:has(.fn:text-is("${name}"))`)
const view = (page: Page, v: string) => page.locator(`[data-code="doc-views"] [data-doc-view="${v}"]`)

test('P3B-1★ 마크다운 — 리치 편집이 기본, 고친 블록만 바뀌어 저장(* 목록·__굵게__·머리말 유지), 원문·미리 보기 전환, Mermaid 그림', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await row(page, 'README.md').dblclick()
    await expect(page.locator('[data-doc="rich"]')).toBeVisible({ timeout: 15_000 })
    await expect(view(page, 'rich')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.doc-front')).toContainText('title: demo')
    // 제목 끝에 글자를 친다 → 탭 더러움 → Ctrl+S → 디스크엔 제목만 바뀜.
    await page.locator('[data-doc="rich-body"] h1').click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await expect(page.locator('.aiws-tab[data-file-tab="README.md"]')).toHaveAttribute('data-dirty', 'true')
    await page.keyboard.press('Control+s')
    await expect.poll(() => readFileSync(join(repo, 'README.md'), 'utf8')).toBe(MD.replace('# Title', '# Title!'))
    // 원문 = Monaco(같은 글), 미리 보기 = 그린 글 + mermaid 그림.
    await view(page, 'source').click()
    await expect(page.locator('.code-ed .monaco-editor')).toBeVisible()
    await expect(page.locator('.code-ed .monaco-editor .view-lines')).toContainText('# Title!')
    await view(page, 'preview').click()
    await expect(page.locator('[data-doc="md-preview"] h1')).toHaveText('Title!')
    await expect(page.locator('[data-doc="md-preview"] [data-doc="mermaid"] svg')).toBeVisible({ timeout: 30_000 })
  } finally {
    rmDir(root)
  }
})

test('P3B-2 리뷰 메모 — 미리 보기에서 글을 골라 메모(원문 줄 범위), 에이전트가 없으면 보내기 이유', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await row(page, 'README.md').dblclick()
    await view(page, 'preview').click()
    const para = page.locator('[data-doc="md-preview"] p', { hasText: 'Some' })
    await expect(para).toBeVisible()
    // 문단 글을 고르고 마우스를 뗀 것과 같게(선택 + mouseup).
    await para.evaluate((el) => {
      const r = document.createRange()
      r.selectNodeContents(el)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(r)
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.click('[data-doc="note-add"]')
    await page.fill('[data-field="md-note"]', '이 문장 다듬어 줘')
    await page.keyboard.press('Enter')
    const note = page.locator('[data-doc="notes"] [data-doc="note"]')
    await expect(note).toHaveCount(1)
    // 머리말 3줄 + 빈 줄 → 본문 'Some …' 은 원문 10번째 줄.
    await expect(note.locator('.md-note-loc')).toHaveText('10줄')
    await page.click('[data-doc="notes-send"]')
    await expect(page.locator('.md-notes-msg')).toContainText('에이전트 탭이 없습니다')
  } finally {
    rmDir(root)
  }
})

test('P3B-3★ HTML 미리 보기 — 샌드박스(앱에 못 닿음)·상대 리소스는 문서 폴더에서·원격 리소스 기본 차단', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await row(page, 'site').click()
    await row(page, 'index.html').dblclick()
    await expect(view(page, 'source')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.code-ed .monaco-editor')).toBeVisible()
    await view(page, 'preview').click()
    const frame = page.locator('[data-doc="html-frame"]')
    await expect(frame).toHaveAttribute('src', /^ara-doc:\/\/[0-9a-f]{32}\/index\.html$/)
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    const doc = page.frameLocator('[data-doc="html-frame"]')
    await expect(doc.locator('#h')).toHaveText('Preview OK')
    // 스크립트는 돌지만 앱 창(parent)에는 못 닿는다(불투명 출처).
    await expect(doc.locator('#o')).toHaveText('blocked')
    // 같은 폴더 그림은 읽히고(ara-doc:), https 그림은 CSP 가 막는다.
    await expect.poll(() => doc.locator('#l').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(10)
    await expect.poll(() => doc.locator('#r').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(0)
  } finally {
    rmDir(root)
  }
})

test('P3B-4 CSV 표 — 머리 줄·검색·숫자 정렬, [원문]은 Monaco', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await row(page, 'data.csv').dblclick()
    const csv = page.locator('[data-doc="csv"]')
    await expect(csv.locator('tbody tr')).toHaveCount(3)
    await csv.locator('[data-csv-col="1"]').click()
    await expect(csv.locator('tbody tr td:nth-child(3)')).toHaveText(['9', '10', '100'])
    await page.fill('[data-field="csv-search"]', 'a')
    await expect(csv.locator('tbody tr')).toHaveCount(1)
    await view(page, 'source').click()
    await expect(page.locator('.code-ed .monaco-editor')).toBeVisible()
  } finally {
    rmDir(root)
  }
})

test('P3B-5 .mmd — 그림 보기가 기본', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await row(page, 'flow.mmd').dblclick()
    await expect(page.locator('[data-doc="mmd-view"] [data-doc="mermaid"] svg')).toBeVisible({ timeout: 30_000 })
  } finally {
    rmDir(root)
  }
})

test('P3B-6 새 탭 옴니박스 — [+] 에서 파일 열기, 열린 파일은 탭 줄로, ? 는 검색만, [에이전트 고르기…] = 피커', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await row(page, 'data.csv').dblclick()
    await page.click('[data-aiws="agent-add"]')
    const omni = page.locator('[data-aiws="omnibox"]')
    await expect(omni).toBeVisible()
    await page.fill('[data-field="omnibox"]', 'data')
    // 이미 열린 data.csv 는 파일 줄이 아니라 열린 탭 줄로만.
    await expect(omni.locator('[data-omni^="file-tab:"]')).toHaveCount(1)
    await expect(omni.locator('[data-omni="file:data.csv"]')).toHaveCount(0)
    await page.fill('[data-field="omnibox"]', 'flow')
    await expect(omni.locator('[data-omni="file:flow.mmd"]')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('.aiws-tab[data-file-tab="flow.mmd"]')).toBeVisible()
    await page.click('[data-aiws="agent-add"]')
    await page.fill('[data-field="omnibox"]', '?flow')
    await expect(omni.locator('.qo-item')).toHaveCount(1)
    await expect(omni.locator('[data-omni="search"]')).toBeVisible()
    await page.fill('[data-field="omnibox"]', '')
    await omni.locator('[data-omni="pick"]').click()
    await expect(page.locator('[data-aiws="agent-picker"]')).toBeVisible()
  } finally {
    rmDir(root)
  }
})
