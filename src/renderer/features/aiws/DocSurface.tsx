// 3차 R1-B 코드 보기 3차 — 글 파일의 다른 보기 갈래(CodeEditor 가 lazy 로 부른다). 보기마다 또 따로 지연 로드:
// 리치 마크다운(Tiptap)·Mermaid 는 무거워서 그 보기를 처음 열 때만 청크가 불린다(켜는 시간·메모리 게이트).
// 출처: stablyai/orca @ec112c6b01 (MIT) components/editor/EditorMarkdownFileSurface.tsx(보기 갈래)·markdown-render-mode.ts(판정).
import { lazy, type JSX } from 'react'
import { markdownRenderMode, markdownRichUnsupported, type DocKind, type DocView } from '@shared/docView'
import { t } from '../../i18n'
import type { CodeFile } from './codeStore'
import './docViews.css'

const RichMarkdownEditor = lazy(() => import('./RichMarkdownEditor'))
const MarkdownPreview = lazy(() => import('./MarkdownPreview'))
const CsvView = lazy(() => import('./CsvView'))
const MermaidView = lazy(() => import('./MermaidView'))
const HtmlPreview = lazy(() => import('./HtmlPreview'))

/** 다른 보기가 읽고 쓰는 손잡이(CodeEditor 가 Monaco 모델로 만든다). get 은 LF. */
export type DocModel = {
  readOnly: boolean
  get: () => string
  set: (text: string) => void
  onChange: (cb: () => void) => () => void
}

export type DocProps = { file: CodeFile; model: DocModel }

export default function DocSurface({ file, kind, view, model }: { file: CodeFile; kind: DocKind; view: DocView; model: DocModel }): JSX.Element {
  if (kind === 'csv') return <CsvView file={file} model={model} />
  if (kind === 'mermaid') return <MermaidView file={file} model={model} />
  if (kind === 'html') return <HtmlPreview file={file} model={model} />
  // 마크다운 — Orca getMarkdownRenderMode. 크기 넘침은 CodeEditor 가 원문(Monaco)으로 보인다. 여기선 리치가 못 지키는 문법이면 미리 보기(이유를 띠로).
  const unsupported = view === 'rich' ? markdownRichUnsupported(model.get()) : null
  const mode = markdownRenderMode({ view, tooBig: false, unsupported: unsupported !== null })
  return (
    <>
      {unsupported && (
        <div className="code-bar" role="status" data-doc="rich-unsupported" data-reason={unsupported}>
          <span>{t('doc.md.unsupported.' + unsupported)}</span>
        </div>
      )}
      {mode === 'rich' ? <RichMarkdownEditor file={file} model={model} /> : <MarkdownPreview file={file} model={model} />}
    </>
  )
}
