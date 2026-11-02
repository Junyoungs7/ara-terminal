// 3차 R1-B 마크다운 미리 보기 — 그린 글 + Mermaid 블록 + 리뷰 주석. DocSurface 가 lazy 로 부른다.
// 출처: stablyai/orca @ec112c6b01 (MIT) components/editor/MarkdownPreview.tsx·markdown-preview-plugins.ts(react-markdown + remark-gfm,
// raw HTML 은 안 살림)·MermaidBlock(```mermaid 를 그림으로)·markdown-preview-links(상대 링크 = 워크트리 파일 열기, 웹 링크 = 바깥 브라우저)·
// markdown-preview-local-images(로컬 이미지 = 파일에서 읽기).
// 아라 규칙(components/md.tsx): rehype-raw 를 넣지 않는다 — 문서 속 <script> 가 진짜 태그가 되지 않는다. 링크는 눌러도 이 창이 넘어가지 않는다.
// 뺀 것: 머리말 숨기기 메뉴, 목차 패널, 찾기 막대, 수식(KaTeX), 가상 스크롤(큰 문서는 600KB 상한에서 원문으로 간다).
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitFrontMatter } from '@shared/docView'
import { mediaOf } from '@shared/media'
import { t } from '../../i18n'
import { openFile, type CodeFile } from './codeStore'
import type { DocProps } from './DocSurface'
import { MermaidDiagram } from './MermaidDiagram'
import { MarkdownReview, resolveByLineAttrs } from './MarkdownReview'

/** 그리는 파일(링크·이미지가 상대 경로를 풀 때) + 머리말 줄 수(본문 줄 → 원문 줄). */
const Ctx = createContext<{ file: CodeFile; offset: number } | null>(null)

const dirOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')
/** 문서 기준 상대 경로 → 절대(워크트리 밖이면 openFile·main 이 거절한다). */
function resolveRel(file: CodeFile, href: string): string {
  const sep = file.path.includes('\\') ? '\\' : '/'
  const parts = dirOf(file.path).split(/[\\/]/)
  for (const seg of decodeURIComponent(href.split(/[?#]/)[0]).split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join(sep)
}

function Link({ href, children }: { href?: string; children?: React.ReactNode }): JSX.Element {
  const ctx = useContext(Ctx)
  const h = href ?? ''
  const web = /^https?:\/\//i.test(h)
  const local = !web && h !== '' && !h.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(h)
  return (
    <span
      className={'md-link' + (web || local ? ' doc-link' : '')}
      title={h}
      role={web || local ? 'link' : undefined}
      data-href={h}
      onClick={() => {
        if (web) void window.ev.oriel.open(h)
        else if (local && ctx) void openFile(resolveRel(ctx.file, h))
      }}
    >
      {children}
    </span>
  )
}

/** 로컬 이미지는 파일에서 읽어 Blob 으로(작업 단위 안·이미지 종류만 — main 이 거른다). 원격 주소는 불러오지 않는다(앱 CSP 도 막는다). */
function Img({ src, alt }: { src?: string; alt?: string }): JSX.Element {
  const ctx = useContext(Ctx)
  const s = typeof src === 'string' ? src : ''
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!ctx || !s || /^[a-z][a-z0-9+.-]*:/i.test(s)) return
    const abs = resolveRel(ctx.file, s)
    const m = mediaOf(abs)
    if (m?.kind !== 'image') return
    let live = true
    let u: string | null = null
    void window.ev.code.readBytes(ctx.file.root, abs, ctx.file.host).then((r) => {
      if (!live || !r.ok) return
      u = URL.createObjectURL(new Blob([r.data as BlobPart], { type: m.mime }))
      setUrl(u)
    })
    return () => {
      live = false
      if (u) URL.revokeObjectURL(u)
    }
  }, [ctx, s])
  if (url) return <img className="doc-img" src={url} alt={alt ?? ''} />
  if (s.startsWith('data:image/')) return <img className="doc-img" src={s} alt={alt ?? ''} />
  return (
    <span className="md-img" title={s}>
      {alt || s}
    </span>
  )
}

type Pos = { position?: { start: { line: number }; end: { line: number } } }
/** 블록마다 원문 줄(data-l1·l2) — 리뷰 주석이 고른 글을 원문 줄로 바꿀 때 읽는다. */
function useLines(node: Pos | undefined): { 'data-l1'?: number; 'data-l2'?: number } {
  const ctx = useContext(Ctx)
  const p = node?.position
  return p ? { 'data-l1': p.start.line + (ctx?.offset ?? 0), 'data-l2': p.end.line + (ctx?.offset ?? 0) } : {}
}

type HastText = { type: string; value?: string; children?: HastText[]; properties?: { className?: string[] } }
const textOf = (n: HastText | undefined): string => (n ? (n.value ?? (n.children ?? []).map(textOf).join('')) : '')

// 🔴 모듈 스코프(components/md.tsx 의 같은 이유 — 렌더마다 새로 만들면 노드가 통째로 다시 태어난다).
const COMPONENTS: Components = {
  p: ({ node, children }) => <p {...useLines(node)}>{children}</p>,
  h1: ({ node, children }) => <h1 {...useLines(node)}>{children}</h1>,
  h2: ({ node, children }) => <h2 {...useLines(node)}>{children}</h2>,
  h3: ({ node, children }) => <h3 {...useLines(node)}>{children}</h3>,
  h4: ({ node, children }) => <h4 {...useLines(node)}>{children}</h4>,
  h5: ({ node, children }) => <h5 {...useLines(node)}>{children}</h5>,
  h6: ({ node, children }) => <h6 {...useLines(node)}>{children}</h6>,
  li: ({ node, children, className }) => (
    <li className={className} {...useLines(node)}>
      {children}
    </li>
  ),
  blockquote: ({ node, children }) => (
    <div className="md-quote" {...useLines(node)}>
      {children}
    </div>
  ),
  hr: ({ node }) => <div className="md-hr" {...useLines(node)} />,
  table: ({ node, children }) => (
    <div className="md-tablewrap" {...useLines(node)}>
      <table className="md-table">{children}</table>
    </div>
  ),
  tr: ({ node, children }) => <tr {...useLines(node)}>{children}</tr>,
  code: ({ className, children }) => <code className={/language-/.test(className ?? '') ? 'md-blk ' + (className ?? '') : 'md-code'}>{children}</code>,
  // ```mermaid → 그림(Orca MermaidBlock). 나머지 코드 블록은 그대로.
  pre: ({ node, children }) => {
    const code = (node as HastText | undefined)?.children?.[0]
    if (code?.properties?.className?.includes('language-mermaid')) {
      return (
        <div className="md-mmd" {...useLines(node as Pos)}>
          <MermaidDiagram code={textOf(code)} />
        </div>
      )
    }
    return (
      <pre className="md-pre" {...useLines(node as Pos)}>
        {children}
      </pre>
    )
  },
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  img: ({ src, alt }) => <Img src={typeof src === 'string' ? src : undefined} alt={alt} />
}
const REMARK = [remarkGfm]

const Body = memo(function Body({ body }: { body: string }): JSX.Element {
  return (
    <ReactMarkdown remarkPlugins={REMARK} components={COMPONENTS}>
      {body}
    </ReactMarkdown>
  )
})

/** 고쳐 쓰는 동안 다시 그리기를 묶는다. */
const RERENDER_MS = 150

export default function MarkdownPreview({ file, model }: DocProps): JSX.Element {
  const [text, setText] = useState(() => model.get())
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = model.onChange(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setText(model.get()), RERENDER_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path])
  const { front, body } = useMemo(() => splitFrontMatter(text), [text])
  const offset = front ? front.split('\n').length - 1 : 0
  const ctx = useMemo(() => ({ file, offset }), [file, offset])
  return (
    <div className="doc-scroll" ref={hostRef} data-doc="md-preview">
      <div className="md doc-md">
        {front && (
          <pre className="doc-front" data-l1={1} data-l2={offset} title={t('doc.md.front')}>
            {front.trimEnd()}
          </pre>
        )}
        <Ctx.Provider value={ctx}>
          <Body body={body} />
        </Ctx.Provider>
      </div>
      <MarkdownReview file={file} hostRef={hostRef} resolve={resolveByLineAttrs} />
    </div>
  )
}
