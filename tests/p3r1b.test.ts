// 3차 R1-B 코드 보기 3차 — 순수 규칙(보기 종류·리치 판정·머리말·CSV·옴니박스·마크다운 리뷰 주석 형식·리치 원문 보존·HTML 미리 보기 허가/CSP).
import { describe, expect, it, vi } from 'vitest'
import { posix } from 'node:path'

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }, app: { getAppPath: () => '', on: vi.fn() }, webContents: { getAllWebContents: () => [] } }))

import {
  csvBodyView,
  defaultDocView,
  detectCsvDelimiter,
  docKindOf,
  exceedsUtf8ByteLimit,
  markdownRenderMode,
  markdownRichUnsupported,
  nextCsvSort,
  omniboxPrefersSearch,
  omniboxUrlOf,
  parseCsv,
  parseOmniboxQuery,
  splitFrontMatter
} from '../src/shared/docView'
import { formatDiffComments, normalizeDiffComment, type DiffComment } from '../src/shared/diffComments'
import { mergeMarkdownBlocks, splitMarkdownBlocks } from '../src/renderer/features/aiws/richMarkdownSource'

describe('보기 종류', () => {
  it('확장자 → 종류·첫 보기(Orca: 마크다운 리치, CSV 표, .mmd 그림, HTML 원문)', () => {
    expect(docKindOf('C:\\r\\README.MD')).toBe('markdown')
    expect(docKindOf('/a/b.tsv')).toBe('csv')
    expect(docKindOf('/a/flow.mmd')).toBe('mermaid')
    expect(docKindOf('/a/index.htm')).toBe('html')
    expect(docKindOf('/a/main.ts')).toBeNull()
    expect(docKindOf('/a/.md')).toBeNull()
    expect(defaultDocView('markdown')).toBe('rich')
    expect(defaultDocView('csv')).toBe('table')
    expect(defaultDocView('mermaid')).toBe('diagram')
    expect(defaultDocView('html')).toBe('source')
  })
})

describe('마크다운 리치 판정(Orca markdown-render-mode·rich-mode)', () => {
  it('원문 고름 > 미리 보기 고름 > 큼 → 원문 > 못 지키는 문법 → 미리 보기', () => {
    expect(markdownRenderMode({ view: 'source', tooBig: false, unsupported: false })).toBe('source')
    expect(markdownRenderMode({ view: 'preview', tooBig: true, unsupported: true })).toBe('preview')
    expect(markdownRenderMode({ view: 'rich', tooBig: true, unsupported: false })).toBe('source')
    expect(markdownRenderMode({ view: 'rich', tooBig: false, unsupported: true })).toBe('preview')
    expect(markdownRenderMode({ view: 'rich', tooBig: false, unsupported: false })).toBe('rich')
  })
  it('HTML·참조 링크·각주는 리치 불가, 코드 안의 것은 셈하지 않는다', () => {
    expect(markdownRichUnsupported('# a\n\n<div class="x">hi</div>\n')).toBe('html-or-jsx')
    expect(markdownRichUnsupported('a <!-- note --> b')).toBe('html-or-jsx')
    expect(markdownRichUnsupported('see [x]\n\n[x]: https://e.com\n')).toBe('reference-links')
    expect(markdownRichUnsupported('a[^1]\n\n[^1]: foot\n')).toBe('footnotes')
    expect(markdownRichUnsupported('```html\n<div>ok</div>\n```\n\n`<b>` 와 <https://e.com>\n')).toBeNull()
    expect(markdownRichUnsupported('# 제목\n\n- [ ] 할 일\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')).toBeNull()
  })
  it('머리말 분리(YAML·TOML) — 머리말 안의 <태그>는 판정에 안 들어간다', () => {
    const { front, body } = splitFrontMatter('---\ntitle: <x>\n---\n\n# Hi\n')
    expect(front).toBe('---\ntitle: <x>\n---\n')
    expect(body).toBe('\n# Hi\n')
    expect(markdownRichUnsupported('---\ntitle: <x>\n---\n# Hi\n')).toBeNull()
    expect(splitFrontMatter('+++\na = 1\n+++\nbody').front).toBe('+++\na = 1\n+++\n')
    expect(splitFrontMatter('# no front\n---\n').front).toBe('')
  })
  it('UTF-8 바이트 상한(한글 3바이트)', () => {
    expect(exceedsUtf8ByteLimit('가'.repeat(10), 30)).toBe(false)
    expect(exceedsUtf8ByteLimit('가'.repeat(11), 30)).toBe(true)
    expect(exceedsUtf8ByteLimit('a'.repeat(31), 30)).toBe(true)
  })
})

describe('리치 마크다운 원문 보존(richMarkdownSource)', () => {
  const doc = '# Title\n\n* one\n* two\n\nSome __bold__ text.\n\n\n```js\nx()\n```\n'
  it('블록 줄 번호와 그대로 이으면 원문과 같다', () => {
    const { blocks, tail } = splitMarkdownBlocks(doc)
    expect(blocks.map((b) => [b.start, b.end])).toEqual([
      [1, 1],
      [3, 4],
      [6, 6],
      [9, 11]
    ])
    const base = blocks.map((b) => 'S' + b.raw)
    expect(mergeMarkdownBlocks(blocks, base, tail, base)).toBe(doc)
  })
  it('고친 블록만 새 직렬화, 나머지는 원문(* 목록·__굵게__ 유지)', () => {
    const { blocks, tail } = splitMarkdownBlocks(doc)
    const base = ['# Title\n', '- one\n- two\n', 'Some **bold** text.\n', '```js\nx()\n```\n']
    const out = mergeMarkdownBlocks(blocks, base, tail, ['# New title\n', base[1], base[2], base[3]])
    expect(out).toBe('# New title\n\n* one\n* two\n\nSome __bold__ text.\n\n\n```js\nx()\n```\n')
    // 블록을 지우면 그 블록만 빠진다
    expect(mergeMarkdownBlocks(blocks, base, tail, [base[0], base[2], base[3]])).toBe('# Title\n\nSome __bold__ text.\n\n\n```js\nx()\n```\n')
    // 새 블록을 끝에 더함
    expect(mergeMarkdownBlocks(blocks, base, tail, [...base, 'New para\n'])).toBe(doc + '\nNew para\n')
  })
  it('진짜 Tiptap(리치 에디터와 같은 확장): 맨 위 노드 수 = 블록 수, 안 고치면 원문 그대로, 제목만 고치면 나머지 서식 유지', async () => {
    const { Editor } = await import('@tiptap/core')
    const { default: StarterKit } = await import('@tiptap/starter-kit')
    const { Markdown } = await import('@tiptap/markdown')
    const { TaskItem, TaskList } = await import('@tiptap/extension-list')
    const { Table, TableCell, TableHeader, TableRow } = await import('@tiptap/extension-table')
    const { default: Image } = await import('@tiptap/extension-image')
    const ed = new Editor({
      element: null,
      extensions: [StarterKit.configure({ trailingNode: false }), TaskList, TaskItem.configure({ nested: true }), Table, TableRow, TableHeader, TableCell, Image, Markdown],
      content: { type: 'doc', content: [{ type: 'paragraph' }] }
    } as never)
    const body = '# Title\n\n* one\n* two\n\nSome __bold__ text.\n\n- [ ] task\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n---\n\n```js\nx()\n```\n'
    ed.commands.setContent(ed.markdown!.parse(body))
    const sersOf = (): string[] => {
      const out: string[] = []
      ed.state.doc.forEach((n) => out.push(ed.markdown!.serialize({ type: 'doc', content: [n.toJSON()] })))
      return out
    }
    const base = sersOf()
    const { blocks, tail } = splitMarkdownBlocks(body)
    expect(blocks.length).toBe(ed.state.doc.childCount)
    expect(mergeMarkdownBlocks(blocks, base, tail, base)).toBe(body)
    ed.commands.setTextSelection(3)
    ed.commands.insertContent({ type: 'text', text: 'X' })
    expect(mergeMarkdownBlocks(blocks, base, tail, sersOf())).toBe(body.replace('# Title', '# TiXtle'))
    ed.destroy()
  })
  it('머리말 뒤 빈 줄(첫 블록 앞)을 지킨다', () => {
    const body = '\n# Hi\n'
    const { blocks, tail } = splitMarkdownBlocks(body)
    expect(mergeMarkdownBlocks(blocks, ['# Hi\n'], tail, ['# Hi\n'])).toBe(body)
    expect(mergeMarkdownBlocks(blocks, ['# Hi\n'], tail, ['# Ho\n'])).toBe('\n# Ho\n')
  })
})

describe('마크다운 리뷰 주석 → 에이전트(Orca markdown-review-notes 형식, M7 과 같은 저장)', () => {
  const note: DiffComment = { id: 'n1', filePath: 'docs/a.md', startLine: 3, lineNumber: 5, body: 'say "why"\nplease', createdAt: 1, source: 'markdown', selectedText: 'first\nsecond' }
  it('File · Source: markdown · Lines · Excerpt · User comment(따옴표·줄바꿈 이스케이프)', () => {
    expect(formatDiffComments([note])).toBe('File: docs/a.md\nSource: markdown\n\nLines 3-5\nExcerpt:\n> first\n> second\nUser comment: "say \\"why\\"\\nplease"')
    // diff 줄 주석 형식은 그대로
    expect(formatDiffComments([{ id: 'd', filePath: 'x.ts', lineNumber: 2, body: 'b', createdAt: 1 }])).toBe('File: x.ts\nLine: 2\nUser comment: "b"')
  })
  it('저장 → 읽기에서 source·selectedText 가 살아남고, 다른 값은 버린다', () => {
    expect(normalizeDiffComment(JSON.parse(JSON.stringify(note)))).toEqual(note)
    const bad = normalizeDiffComment({ ...note, source: 'other', selectedText: 'x' })
    expect(bad?.source).toBeUndefined()
    expect(bad?.selectedText).toBeUndefined()
  })
})

describe('CSV/TSV(Orca csv-parse·delimiter-detection)', () => {
  it('따옴표·"" 이스케이프·CRLF·BOM·따옴표 안 줄바꿈', () => {
    expect(parseCsv('\ufeffa,b\r\n"x, y","say ""hi"""\n"multi\nline",2\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', '2']
    ])
    expect(parseCsv('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })
  it('구분자 — .tsv 는 탭, 세미콜론이 이기면 ;, 아니면 , 또는 탭', () => {
    expect(detectCsvDelimiter('/x.tsv', 'a,b')).toBe('\t')
    expect(detectCsvDelimiter('/x.csv', '\n\na;b;c\n1;2;3')).toBe(';')
    expect(detectCsvDelimiter('/x.csv', 'a\tb\tc')).toBe('\t')
    expect(detectCsvDelimiter('/x.csv', '"a;b",c')).toBe(',')
  })
  it('검색(어느 칸이든·대소문자 무시)·정렬(숫자는 숫자로, 오름 → 내림 → 없음)', () => {
    const rows = [['name', 'n'], ['b', '10'], ['A', '9'], ['c', '100']]
    expect(csvBodyView(rows, 'a', null).map((r) => r.index)).toEqual([2])
    expect(csvBodyView(rows, '', { col: 1, dir: 'asc' }).map((r) => r.row[1])).toEqual(['9', '10', '100'])
    expect(csvBodyView(rows, '', { col: 0, dir: 'desc' }).map((r) => r.row[0])).toEqual(['c', 'b', 'A'])
    expect(nextCsvSort(null, 1)).toEqual({ col: 1, dir: 'asc' })
    expect(nextCsvSort({ col: 1, dir: 'asc' }, 1)).toEqual({ col: 1, dir: 'desc' })
    expect(nextCsvSort({ col: 1, dir: 'desc' }, 1)).toBeNull()
    expect(nextCsvSort({ col: 1, dir: 'desc' }, 0)).toEqual({ col: 0, dir: 'asc' })
  })
})

describe('새 탭 옴니박스(Orca tab-create-entry)', () => {
  it('? 는 곧장 검색, 여러 낱말이면 검색이 위로', () => {
    expect(parseOmniboxQuery('?  foo bar ')).toEqual({ forced: true, query: 'foo bar' })
    expect(parseOmniboxQuery(' foo ')).toEqual({ forced: false, query: 'foo' })
    expect(omniboxPrefersSearch('how to x')).toBe(true)
    expect(omniboxPrefersSearch('readme')).toBe(false)
  })
  it('URL 판정 — 스킴·도메인·localhost/IP 는 URL, 파일 이름·낱말은 아님', () => {
    expect(omniboxUrlOf('https://example.com/a')).toBe('https://example.com/a')
    expect(omniboxUrlOf('example.com')).toBe('https://example.com/')
    expect(omniboxUrlOf('localhost:3000/x')).toBe('http://localhost:3000/x')
    expect(omniboxUrlOf('10.0.0.5:8080')).toBe('http://10.0.0.5:8080/')
    expect(omniboxUrlOf('README.md')).toBeNull()
    expect(omniboxUrlOf('src/main.ts')).toBeNull()
    expect(omniboxUrlOf('hello')).toBeNull()
    expect(omniboxUrlOf('two words.com')).toBeNull()
  })
})

describe('HTML 미리 보기 허가(main/code/docPreview)', async () => {
  const { mintDocGrant, docPathOf, docPreviewCsp, docMimeOf } = await import('../src/main/code/docPreview')
  it('허가 = 문서 폴더 아래만(.. 로 위로 못 나감), 없는 허가는 거절', () => {
    const url = mintDocGrant('/srv/repo/docs/site/index.html', 'host-a', false)
    expect(url).toMatch(/^ara-doc:\/\/[0-9a-f]{32}\/index\.html$/)
    const id = new URL(url).hostname
    expect(docPathOf(url)?.path).toBe('/srv/repo/docs/site/index.html')
    expect(docPathOf(`ara-doc://${id}/img/a%20b.png`)?.path).toBe(posix.join('/srv/repo/docs/site', 'img/a b.png'))
    // URL 이 .. 를 먼저 접는다 — 허가 폴더 위로 못 간다
    expect(docPathOf(`ara-doc://${id}/../secret.txt`)?.path).toBe('/srv/repo/docs/site/secret.txt')
    expect(docPathOf(`ara-doc://${id}/%2e%2e/secret.txt`)?.path).toBe('/srv/repo/docs/site/secret.txt')
    // 인코딩한 / 로 .. 를 숨겨도 풀어 본 경로가 폴더 밖이면 거절
    expect(docPathOf(`ara-doc://${id}/a%2F..%2F..%2Fsecret.txt`)).toBeNull()
    expect(docPathOf(`ara-doc://${'0'.repeat(32)}/index.html`)).toBeNull()
    expect(docPathOf(`ara-doc://${id}/`)).toBeNull()
  })
  it('CSP — 기본은 http(s) 없음, 원격 허용이면 더한다. form·base 는 늘 막음', () => {
    const off = docPreviewCsp(false)
    expect(off).not.toMatch(/https?:/)
    expect(off).toContain("default-src 'none'")
    expect(off).toContain("form-action 'none'")
    expect(docPreviewCsp(true)).toContain('img-src ara-doc: data: blob: https: http:')
    expect(docMimeOf('a/b.CSS')).toBe('text/css; charset=utf-8')
    expect(docMimeOf('a/b.bin')).toBe('application/octet-stream')
  })
})
