// M6 R2 WS-06 빠른 열기 · WS-09 전체 검색 — 퍼지 점수·순위, rg --json 파서, rg 경로 계산, 실제 rg(node_modules 의 것)로 목록·검색·상한·취소.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QUICK_OPEN_RESULT_LIMIT,
  SEARCH_LINE_MAX,
  SEARCH_MAX_RESULTS,
  buildSearchArgs,
  ingestRgJsonLine,
  newSearchAcc,
  normalizeRgPath,
  rankQuickOpen,
  scoreQuickOpen,
  type SearchFile
} from '../src/shared/codeSearch'
import { listFiles, rgBinPath, searchText } from '../src/main/code/search'

describe('빠른 열기 퍼지 점수(Orca fuzzyMatchIndexedFile)', () => {
  it('안 맞으면 null, 글자 순서가 맞으면 숫자', () => {
    expect(scoreQuickOpen('xyz', 'src/a.ts')).toBeNull()
    expect(scoreQuickOpen('sat', 'src/a.ts')).not.toBeNull()
    expect(scoreQuickOpen('tas', 'src/a.ts')).toBeNull() // 순서가 거꾸로
  })
  it('파일 이름에 통째로 있으면 경로에 흩어진 것보다 낫다', () => {
    const name = scoreQuickOpen('order', 'src/OrderRetryPolicy.java')!
    const scattered = scoreQuickOpen('order', 'o/r/d/e/r.txt')!
    expect(name).toBeLessThan(scattered)
  })
  it('경계(/ . -) 바로 뒤에서 맞으면 점수가 좋아진다', () => {
    expect(scoreQuickOpen('ap', 'x/api.ts')!).toBeLessThan(scoreQuickOpen('ap', 'xapi.ts')!)
  })
  it('공백 = 여러 단어, 모두 맞아야 한다 · \\ 는 / 로', () => {
    expect(scoreQuickOpen('src policy', 'src/OrderRetryPolicy.java')).not.toBeNull()
    expect(scoreQuickOpen('src nope', 'src/OrderRetryPolicy.java')).toBeNull()
    expect(scoreQuickOpen('src\\order', 'src/OrderRetryPolicy.java')).not.toBeNull()
  })
})

describe('빠른 열기 순위(최근 연 파일 먼저)', () => {
  const files = ['src/a.ts', 'src/b.ts', 'lib/order.ts', 'docs/readme.md']
  it('최근 것 중 맞는 것을 최근 순서대로 먼저, 그다음 점수 순', () => {
    expect(rankQuickOpen('', files, ['src/b.ts', 'docs/readme.md']).slice(0, 2)).toEqual(['src/b.ts', 'docs/readme.md'])
    expect(rankQuickOpen('order', files, ['src/b.ts'])).toEqual(['lib/order.ts'])
  })
  it('목록에 없는 최근 파일(지워졌거나 무시됨)은 뺀다 · 중복 없음', () => {
    const r = rankQuickOpen('', files, ['gone.ts', 'src/a.ts'])
    expect(r).not.toContain('gone.ts')
    expect(r.filter((p) => p === 'src/a.ts')).toHaveLength(1)
  })
  it(`상한 ${QUICK_OPEN_RESULT_LIMIT}개`, () => {
    const many = Array.from({ length: 500 }, (_, i) => `f${i}.ts`)
    expect(rankQuickOpen('f', many, [])).toHaveLength(QUICK_OPEN_RESULT_LIMIT)
  })
})

describe('rg 경로·인자', () => {
  it('normalizeRgPath — ./ 떼기 · \\ → / · 루트 밖 거름', () => {
    expect(normalizeRgPath('./src/a.ts')).toBe('src/a.ts')
    expect(normalizeRgPath('src\\a.ts')).toBe('src/a.ts')
    expect(normalizeRgPath('../x')).toBeNull()
    expect(normalizeRgPath('')).toBeNull()
  })
  it('설치본(app.asar)이면 app.asar.unpacked 의 rg, 개발이면 저장소 node_modules 그대로', () => {
    const packed = rgBinPath('C:\\ARA\\resources\\app.asar', 'win32', 'x64').replace(/\\/g, '/')
    expect(packed).toBe('C:/ARA/resources/app.asar.unpacked/node_modules/@vscode/ripgrep-universal/bin/win32-x64/rg.exe')
    const mac = rgBinPath('/Applications/ARA.app/Contents/Resources/app.asar', 'darwin', 'arm64').replace(/\\/g, '/')
    expect(mac).toBe('/Applications/ARA.app/Contents/Resources/app.asar.unpacked/node_modules/@vscode/ripgrep-universal/bin/darwin-arm64/rg')
    // 이름만 비슷한 폴더(app.asarx)는 건드리지 않는다.
    expect(rgBinPath('/x/app.asarx', 'linux', 'x64').replace(/\\/g, '/')).toBe('/x/app.asarx/node_modules/@vscode/ripgrep-universal/bin/linux-x64/rg')
  })
  it('양성 대조 — 개발 경로에 이 플랫폼 rg 가 실제로 있다', () => {
    expect(existsSync(rgBinPath(process.cwd(), process.platform, process.arch))).toBe(true)
  })
  it('검색 인자 — 검색어는 -- 뒤 · 정규식 아니면 고정 문자열 · 대소문자 · 글롭', () => {
    const a = buildSearchArgs({ query: '-rf', regex: false, caseSensitive: false, include: 'src/**, *.ts', exclude: '*.test.ts' }, false)
    expect(a.slice(-3)).toEqual(['--', '-rf', '.'])
    expect(a).toContain('--fixed-strings')
    expect(a).toContain('--ignore-case')
    expect(a.join(' ')).toContain('--glob src/** --glob *.ts --glob !*.test.ts')
    const b = buildSearchArgs({ query: 'a.c', regex: true, caseSensitive: true, include: '', exclude: '' }, true)
    expect(b).not.toContain('--fixed-strings')
    expect(b).not.toContain('--ignore-case')
    expect(b.join(' ')).toContain('--path-separator /')
  })
})

const match = (path: string, text: string, subs: [number, number][], line = 1): string =>
  JSON.stringify({ type: 'match', data: { path: { text: path }, lines: { text: text + '\n' }, line_number: line, submatches: subs.map(([start, end]) => ({ match: { text: '' }, start, end })) } })

describe('rg --json 파서(Orca ingestRgJsonLine)', () => {
  it('match 만 모은다 — 파일별 묶음, begin·end·summary 는 넘긴다', () => {
    const acc = newSearchAcc()
    ingestRgJsonLine(JSON.stringify({ type: 'begin', data: { path: { text: './a.ts' } } }), acc)
    ingestRgJsonLine(match('./a.ts', 'const foo = foo', [[6, 9], [12, 15]], 3), acc)
    ingestRgJsonLine(match('./a.ts', 'foo()', [[0, 3]], 7), acc)
    ingestRgJsonLine(JSON.stringify({ type: 'summary', data: {} }), acc)
    expect([...acc.files.keys()]).toEqual(['a.ts'])
    expect(acc.files.get('a.ts')!.matches).toEqual([
      { line: 3, text: 'const foo = foo', ranges: [[6, 9], [12, 15]] },
      { line: 7, text: 'foo()', ranges: [[0, 3]] }
    ])
    expect(acc.total).toBe(3)
  })
  it('submatch 자리는 UTF-8 바이트 — 한글 줄은 글자 자리로 바꾼다', () => {
    const acc = newSearchAcc()
    const text = '주문 재시도 retry'
    const start = Buffer.byteLength('주문 재시도 ')
    ingestRgJsonLine(match('k.md', text, [[start, start + 5]]), acc)
    const m = acc.files.get('k.md')!.matches[0]
    expect(m.text.slice(m.ranges[0][0], m.ranges[0][1])).toBe('retry')
  })
  it('UTF-8 이 아닌 줄(bytes, base64)도 읽는다 · 경로가 bytes 면 빼고 truncated', () => {
    const acc = newSearchAcc()
    ingestRgJsonLine(JSON.stringify({ type: 'match', data: { path: { text: 'b.txt' }, lines: { bytes: Buffer.from('hit\n').toString('base64') }, line_number: 1, submatches: [{ start: 0, end: 3 }] } }), acc)
    expect(acc.files.get('b.txt')!.matches[0].text).toBe('hit')
    ingestRgJsonLine(JSON.stringify({ type: 'match', data: { path: { bytes: 'AAA=' }, lines: { text: 'x' }, line_number: 1, submatches: [] } }), acc)
    expect(acc.truncated).toBe(true)
    expect(acc.files.size).toBe(1)
  })
  it(`긴 줄은 ${SEARCH_LINE_MAX}자 창으로 자르고 맞은 자리를 따라 옮긴다`, () => {
    const acc = newSearchAcc()
    const text = 'a'.repeat(3000) + 'NEEDLE' + 'b'.repeat(3000)
    ingestRgJsonLine(match('long.js', text, [[3000, 3006]]), acc)
    const m = acc.files.get('long.js')!.matches[0]
    expect(m.text.length).toBeLessThanOrEqual(SEARCH_LINE_MAX + 2)
    expect(m.text.startsWith('…') && m.text.endsWith('…')).toBe(true)
    expect(m.text.slice(m.ranges[0][0], m.ranges[0][1])).toBe('NEEDLE')
  })
  it('상한에서 stop + truncated, 그 뒤 줄은 안 받는다 · 깨진 JSON 은 truncated', () => {
    const acc = newSearchAcc()
    expect(ingestRgJsonLine(match('a', 'x', [[0, 1]]), acc, 2)).toBe('continue')
    expect(ingestRgJsonLine(match('a', 'x', [[0, 1]], 2), acc, 2)).toBe('stop')
    expect(acc.truncated).toBe(true)
    expect(ingestRgJsonLine(match('a', 'x', [[0, 1]], 3), acc, 2)).toBe('stop')
    expect(acc.files.get('a')!.matches).toHaveLength(2)
    const bad = newSearchAcc()
    ingestRgJsonLine('{not json', bad)
    expect(bad.truncated).toBe(true)
  })
})

describe('실제 rg — 목록·검색·상한·취소(임시 git 저장소)', () => {
  const rg = rgBinPath(process.cwd(), process.platform, process.arch)
  const make = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'ara-search-'))
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' })
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, '.gitignore'), 'ignored.log\n')
    writeFileSync(join(root, 'src', 'OrderRetryPolicy.java'), 'class OrderRetryPolicy {\n  int max = 3;\n}\n')
    writeFileSync(join(root, 'ignored.log'), 'max = 3\n')
    writeFileSync(join(root, 'node_modules', 'x', 'i.js'), 'max\n')
    writeFileSync(join(root, '.hidden', 'h.txt'), 'hidden max\n')
    return root
  }

  it('목록 — .gitignore 존중 · 숨김 파일 포함 · node_modules 제외 · / 경로', async () => {
    const root = make()
    try {
      const r = await listFiles(rg, root)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.files.sort()).toEqual(['.gitignore', '.hidden/h.txt', 'src/OrderRetryPolicy.java'])
      expect(r.truncated).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('검색 — 묶음으로 오고 합치면 전부 · 결과를 누르면 열 경로·줄', async () => {
    const root = make()
    try {
      const got: SearchFile[] = []
      const r = await searchText(rg, root, { query: 'max', regex: false, caseSensitive: false, include: '', exclude: '' }, new AbortController().signal, (b) => got.push(...b))
      // 검색은 Orca 처럼 .gitignore 만 따른다(목록의 도구 폴더 제외는 안 건다) — 이 저장소는 node_modules 를 무시 목록에 안 넣었다.
      expect(r).toEqual({ ok: true, total: 3, truncated: false, cancelled: false })
      const byPath = Object.fromEntries(got.map((f) => [f.path, f.matches.map((m) => m.line)]))
      expect(byPath).toEqual({ 'src/OrderRetryPolicy.java': [2], '.hidden/h.txt': [1], 'node_modules/x/i.js': [1] })
      // 포함 글롭 · 대소문자
      const inc: SearchFile[] = []
      await searchText(rg, root, { query: 'MAX', regex: false, caseSensitive: true, include: 'src/**', exclude: '' }, new AbortController().signal, (b) => inc.push(...b))
      expect(inc).toEqual([])
      await searchText(rg, root, { query: 'max', regex: false, caseSensitive: true, include: 'src/**', exclude: '' }, new AbortController().signal, (b) => inc.push(...b))
      expect(inc.map((f) => f.path)).toEqual(['src/OrderRetryPolicy.java'])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('정규식 오류는 rg 의 말로 실패 · 고정 문자열이면 같은 글자를 그대로 찾는다', async () => {
    const root = make()
    try {
      const bad = await searchText(rg, root, { query: 'max(', regex: true, caseSensitive: false, include: '', exclude: '' }, new AbortController().signal, () => {})
      expect(bad.ok).toBe(false)
      const lit = await searchText(rg, root, { query: '{', regex: false, caseSensitive: false, include: '', exclude: '' }, new AbortController().signal, () => {})
      expect(lit).toMatchObject({ ok: true, total: 1 })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it(`상한 ${SEARCH_MAX_RESULTS}개에서 멈추고 truncated`, async () => {
    const root = make()
    try {
      writeFileSync(join(root, 'many.txt'), 'hit\n'.repeat(SEARCH_MAX_RESULTS + 500))
      let n = 0
      const r = await searchText(rg, root, { query: 'hit', regex: false, caseSensitive: false, include: '', exclude: '' }, new AbortController().signal, (b) => (n += b.reduce((s, f) => s + f.matches.length, 0)))
      expect(r).toEqual({ ok: true, total: SEARCH_MAX_RESULTS, truncated: true, cancelled: false })
      expect(n).toBe(SEARCH_MAX_RESULTS)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('취소 — 끊으면 cancelled 로 바로 끝난다', async () => {
    const root = make()
    try {
      const ac = new AbortController()
      const p = searchText(rg, root, { query: 'max', regex: false, caseSensitive: false, include: '', exclude: '' }, ac.signal, () => {})
      ac.abort()
      expect(await p).toMatchObject({ ok: true, cancelled: true })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
