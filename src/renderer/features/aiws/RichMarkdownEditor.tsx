// 3차 R1-B 리치 마크다운 에디터(Tiptap) — DocSurface 가 lazy 로 부른다(Tiptap·ProseMirror 청크는 리치 보기를 처음 열 때만).
// 출처: stablyai/orca @ec112c6b01 (MIT) components/editor/RichMarkdownEditor.tsx·rich-markdown-extensions.ts(StarterKit + 표·할 일·이미지·링크 +
// @tiptap/markdown, trailingNode 끔)·RichMarkdownToolbar.tsx(머리글·굵게·기울임·취소선·코드·목록·할 일·인용·코드 블록·구분선·표)·
// rich-markdown-table-keyboard(Tab/Shift-Tab 칸 이동은 Tiptap 표 기본 키).
// 글의 주인은 Monaco 모델 그대로 — 고치면 원문으로 직렬화해 모델에 써 넣는다(더러움·Ctrl+S 저장·밖에서 바뀜이 원문 편집과 한 길).
// 안 고친 블록은 원문 그대로 둔다(richMarkdownSource — 한 글자 고쳤다고 문서 전체 서식이 바뀌지 않게).
// 뺀 것: 슬래시 메뉴(/)·[[ 문서 링크 자동 완성·이모지·접기 블록(details)·수식·코드 블록 언어 색·찾기 막대·목차·이미지 붙여넣기 저장.
import { useEffect, useMemo, useRef, type JSX } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Bold, Code, Heading1, Heading2, Heading3, Italic, List, ListChecks, ListOrdered, Minus, Quote, SquareCode, Strikethrough, Table as TableIcon } from 'lucide-react'
import { splitFrontMatter } from '@shared/docView'
import { t } from '../../i18n'
import type { DocProps } from './DocSurface'
import { mergeMarkdownBlocks, splitMarkdownBlocks, type SourceBlock } from './richMarkdownSource'
import { MarkdownReview } from './MarkdownReview'

/** 맨 위 노드 하나의 직렬화 — 노드는 안 바뀌면 같은 객체라(ProseMirror 불변) 캐시가 키 입력마다 문서 전체를 다시 직렬화하지 않게 한다. */
const serCache = new WeakMap<PmNode, string>()
function serializeNode(ed: Editor, node: PmNode): string {
  let s = serCache.get(node)
  if (s === undefined) {
    s = ed.markdown?.serialize({ type: 'doc', content: [node.toJSON()] }) ?? ''
    serCache.set(node, s)
  }
  return s
}
const topSers = (ed: Editor): string[] => {
  const out: string[] = []
  ed.state.doc.forEach((n) => {
    const s = serializeNode(ed, n)
    if (s.trim() !== '') out.push(s) // 빈 문단(새 줄만 친 것)은 원문에 아무것도 아니다
  })
  return out
}

type Base = { front: string; blocks: SourceBlock[]; tail: string; sers: string[] | null }

export default function RichMarkdownEditor({ file, model }: DocProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  /** 원문 기준 — 블록·각 블록의 직렬화(블록 수와 Tiptap 노드 수가 다르면 null → 문서 전체 직렬화). */
  const base = useRef<Base | null>(null)
  /** 마지막으로 모델에 써 넣은 글 — 그 변경 알림은 무시한다(되먹임 방지). */
  const written = useRef<string | null>(null)
  const initial = useMemo(() => model.get(), [model])
  // 머리말은 읽기 전용으로 위에(Orca) — 본문만 편집한다.
  const front = useMemo(() => splitFrontMatter(initial).front, [initial])

  const rebase = (ed: Editor, text: string): void => {
    const { front, body } = splitFrontMatter(text)
    const { blocks, tail } = splitMarkdownBlocks(body)
    let sers: string[] | null = []
    ed.state.doc.forEach((n) => sers?.push(serializeNode(ed, n)))
    if (sers.length !== blocks.length) sers = null
    base.current = { front, blocks, tail, sers }
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ trailingNode: false, link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Image,
      Markdown
    ],
    editable: !model.readOnly,
    // 본문은 만든 뒤 markdown.parse 로 넣는다(단위 시험 p3r1b 가 지나는 길과 같게 — 블록 수 맞춤·원문 보존을 거기서 확인).
    onCreate: ({ editor: ed }) => {
      ed.commands.setContent(ed.markdown?.parse(splitFrontMatter(initial).body) ?? '', { emitUpdate: false })
      rebase(ed, initial)
    },
    onUpdate: ({ editor: ed }) => {
      const b = base.current
      if (!b) return
      const body = b.sers ? mergeMarkdownBlocks(b.blocks, b.sers, b.tail, topSers(ed)) : ed.getMarkdown()
      const next = b.front + body
      written.current = next
      model.set(next)
    }
  })

  // 밖에서 바뀜(디스크에서 다시 읽음·다른 창) — 내가 쓴 것이 아니면 내용을 갈아 끼우고 기준을 다시.
  useEffect(() => {
    if (!editor) return
    return model.onChange(() => {
      const now = model.get()
      if (now === written.current) return
      written.current = null
      editor.commands.setContent(editor.markdown?.parse(splitFrontMatter(now).body) ?? '', { emitUpdate: false })
      rebase(editor, now)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, model])

  /** 리뷰 주석 — 고른 글의 앞뒤 끝이 든 맨 위 블록 → 원문 줄(머리말 줄 수를 더한다). */
  const resolve = (range: Range): { start: number; end: number } | null => {
    const b = base.current
    if (!editor || !b) return null
    const now = splitMarkdownBlocks(splitFrontMatter(model.get()).body).blocks
    if (now.length !== editor.state.doc.childCount) return null
    const at = (node: Node, off: number): number => {
      try {
        return editor.state.doc.resolve(editor.view.posAtDOM(node, off)).index(0)
      } catch {
        return -1
      }
    }
    const i = at(range.startContainer, range.startOffset)
    const j = Math.min(at(range.endContainer, range.endOffset), now.length - 1)
    if (i < 0 || j < i) return null
    const offset = b.front ? b.front.split('\n').length - 1 : 0
    return { start: now[i].start + offset, end: now[j].end + offset }
  }

  const btn = (key: string, Icon: typeof Bold, run: (e: Editor) => void, on?: (e: Editor) => boolean): JSX.Element => (
    <button
      key={key}
      type="button"
      className={'aiws-ic rmd-btn' + (editor && on?.(editor) ? ' on' : '')}
      data-rmd={key}
      title={t('doc.rmd.' + key)}
      aria-label={t('doc.rmd.' + key)}
      disabled={!editor || model.readOnly}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => editor && run(editor)}
    >
      <Icon />
    </button>
  )
  const chain = (e: Editor) => e.chain().focus()

  return (
    <div className="rmd" data-doc="rich">
      <div className="rmd-bar" role="toolbar" aria-label={t('doc.rmd.toolbar')}>
        {btn('h1', Heading1, (e) => chain(e).toggleHeading({ level: 1 }).run(), (e) => e.isActive('heading', { level: 1 }))}
        {btn('h2', Heading2, (e) => chain(e).toggleHeading({ level: 2 }).run(), (e) => e.isActive('heading', { level: 2 }))}
        {btn('h3', Heading3, (e) => chain(e).toggleHeading({ level: 3 }).run(), (e) => e.isActive('heading', { level: 3 }))}
        {btn('bold', Bold, (e) => chain(e).toggleBold().run(), (e) => e.isActive('bold'))}
        {btn('italic', Italic, (e) => chain(e).toggleItalic().run(), (e) => e.isActive('italic'))}
        {btn('strike', Strikethrough, (e) => chain(e).toggleStrike().run(), (e) => e.isActive('strike'))}
        {btn('code', Code, (e) => chain(e).toggleCode().run(), (e) => e.isActive('code'))}
        {btn('bullet', List, (e) => chain(e).toggleBulletList().run(), (e) => e.isActive('bulletList'))}
        {btn('ordered', ListOrdered, (e) => chain(e).toggleOrderedList().run(), (e) => e.isActive('orderedList'))}
        {btn('task', ListChecks, (e) => chain(e).toggleTaskList().run(), (e) => e.isActive('taskList'))}
        {btn('quote', Quote, (e) => chain(e).toggleBlockquote().run(), (e) => e.isActive('blockquote'))}
        {btn('codeBlock', SquareCode, (e) => chain(e).toggleCodeBlock().run(), (e) => e.isActive('codeBlock'))}
        {btn('hr', Minus, (e) => chain(e).setHorizontalRule().run())}
        {btn('table', TableIcon, (e) => chain(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
      </div>
      <div className="doc-scroll" ref={hostRef}>
        {front && (
          <pre className="doc-front" title={t('doc.md.front')}>
            {front.trimEnd()}
          </pre>
        )}
        <EditorContent editor={editor} className="md doc-md rmd-body" data-doc="rich-body" />
        <MarkdownReview file={file} hostRef={hostRef} resolve={resolve} />
      </div>
    </div>
  )
}
