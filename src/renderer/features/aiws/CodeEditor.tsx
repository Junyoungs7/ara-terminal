import { lazy, Suspense, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ChevronDown, ChevronUp, GitMerge } from 'lucide-react'
import Editor from '@monaco-editor/react'
import { CODE_READONLY_BYTES, languageOf } from '@shared/codeFiles'
import { areWorktreePathsEqual } from '@shared/worktrees'
import type { DialogResult, DialogSpec } from '../../components/Dialog'
import { t } from '../../i18n'
import { monaco } from './monacoSetup'
import { PLATFORM, useCodeStore, type CodeFile } from './codeStore'
import { codeEditorOptions } from './editorOptions'
import { buildGitConflictDecorations, findGitConflictBlocks, getNextConflictNavigationIndex, hasGitConflictMarkers } from './conflictMarkers'
import { useEditorPrefs } from '../../store/editorPrefs'
import { watchAiLines } from './aiLines'
import { DOC_VIEWS, MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES, RICH_MARKDOWN_MAX_SIZE_BYTES, defaultDocView, docKindOf } from '@shared/docView'
import type { DocModel } from './DocSurface'
import './docViews.css'

// 3차 R1-B 글 파일의 다른 보기(마크다운·CSV·Mermaid·HTML) — 그 보기를 처음 고를 때만 불린다(Tiptap·mermaid 는 그 안에서 또 따로).
const DocSurface = lazy(() => import('./DocSurface'))
/** 크기 넘침 [그래도 열기]를 누른 마크다운(이번 실행 — 탭을 닫으면 editorOps.dispose 가 지운다). */
const richOverride = new Set<string>()

type AskFn = (spec: DialogSpec) => Promise<DialogResult>
type Model = ReturnType<typeof monaco.editor.createModel>

/**
 * M6 WS-07·08 — AI 작업 공간 가운데의 코드 에디터(Monaco). AgentPane 이 lazy 로 부른다 — 이 청크(+monacoSetup)가 Monaco 를 끌고 온다.
 * Orca components/editor/MonacoEditor.tsx·ExternalFileChangeBanner(orcaRef 7a7f46f8a3)의 1차 판: 파일마다 모델 하나(경로 = 모델 uri),
 * 더러움 = 저장한 뒤의 버전과 다름(VS Code 와 같은 alternativeVersionId), Ctrl+S 저장, 밖에서 바뀌면 띠로 안내.
 * 뺀 것: 비교(M7)·자동 저장·마크다운 미리보기·여러 분할. M12 R2: 설정 › 편집기 옵션·미리 보기 탭·충돌 표시(Orca 방식). M12 R3: AI 작성 줄 거터.
 */

const uriOf = (path: string) => monaco.Uri.file(path)
/** 모델별 "저장된 버전". 다르면 더럽다. */
const savedVersion = new Map<string, number>()
/** 모델에 마지막으로 넣은 loadSeq — 디스크에서 다시 읽은 글을 한 번만 넣는다. */
const appliedSeq = new Map<string, number>()
const keyOf = (m: Model): string => m.uri.toString()
const fileOf = (m: Model): CodeFile | undefined => useCodeStore.getState().files.find((f) => areWorktreePathsEqual(f.path, m.uri.fsPath, PLATFORM))

// 파일 모델이 생기면 저장 버전을 적고, 바뀔 때마다 더러움을 다시 잰다.
monaco.editor.onDidCreateModel((m) => {
  if (m.uri.scheme !== 'file') return
  savedVersion.set(keyOf(m), m.getAlternativeVersionId())
  m.onDidChangeContent(() => {
    const f = fileOf(m)
    if (f) useCodeStore.getState().setDirty(f.path, m.getAlternativeVersionId() !== savedVersion.get(keyOf(m)))
  })
  m.onWillDispose(() => {
    savedVersion.delete(keyOf(m))
    appliedSeq.delete(keyOf(m))
  })
})

const LANGS = monaco.languages.getLanguages()

export default function CodeEditor({ worktreeId, ask, hidden }: { worktreeId: string; ask: AskFn; hidden: boolean }): JSX.Element {
  const files = useCodeStore((s) => s.files)
  const activePath = useCodeStore((s) => s.activeByWorktree[worktreeId] ?? null)
  // M12: 뷰어 탭(media)은 MediaView 가 그린다 — 여기서는 글 파일만.
  const file = activePath ? files.find((f) => !f.media && f.worktreeId === worktreeId && areWorktreePathsEqual(f.path, activePath, PLATFORM)) : undefined
  const editorRef = useRef<ReturnType<typeof monaco.editor.create> | null>(null)
  const prefs = useEditorPrefs()
  const readOnly = !!file?.readOnly
  const kind = file ? docKindOf(file.path) : null
  const view = file && kind ? (file.docView ?? defaultDocView(kind)) : 'source'
  // Orca: 600KB 를 넘는 마크다운은 리치 대신 원문(Monaco)을 먼저 — [그래도 열기](1MB 까지)는 그 탭을 닫을 때까지.
  const [, bump] = useState(0)
  const richTooBig = kind === 'markdown' && view === 'rich' && !!file && file.bytes > RICH_MARKDOWN_MAX_SIZE_BYTES && !richOverride.has(file.path)
  const surface = view !== 'source' && !richTooBig
  // M12 R2 머지 충돌(Orca useEditorConflictNavigation) — 보이는 모델의 충돌 블록 시작 줄 · 마지막으로 간 블록.
  const [conflictLines, setConflictLines] = useState<number[]>([])
  const [conflictAt, setConflictAt] = useState<number | null>(null)
  const options = useMemo(() => ({ readOnly, automaticLayout: true, ...codeEditorOptions(prefs) }), [readOnly, prefs])
  const askRef = useRef(ask)
  askRef.current = ask

  const jumpConflict = (direction: 'previous' | 'next'): void => {
    const next = getNextConflictNavigationIndex({ currentIndex: conflictAt, direction, total: conflictLines.length })
    const ed = editorRef.current
    if (next === null || !ed) return
    setConflictAt(next)
    const line = conflictLines[next]
    const len = ed.getModel()?.getLineLength(line) ?? 0
    ed.revealLineInCenter(line)
    ed.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: len + 1 })
    ed.focus()
  }

  // 저장·정리 손잡이를 상태 저장소에 건다(탭 줄의 닫기 확인이 부른다 — 그쪽은 monaco 를 모른다).
  useEffect(() => {
    useCodeStore.setState({ editorOps: { save: (p) => save(p, askRef.current), dispose: (p) => {
          richOverride.delete(p)
          monaco.editor.getModel(uriOf(p))?.dispose()
        }
      }
    })
    return () => useCodeStore.setState({ editorOps: null })
  }, [])

  // 디스크에서 다시 읽은 글(loadSeq 가 오름)을 모델에 넣는다 — 실행 취소로 되돌릴 수 있게 편집으로 넣는다.
  useEffect(() => {
    for (const f of files) {
      if (f.media) continue
      const m = monaco.editor.getModel(uriOf(f.path))
      if (!m || (appliedSeq.get(keyOf(m)) ?? 0) >= f.loadSeq) continue
      appliedSeq.set(keyOf(m), f.loadSeq)
      if (m.getValue() !== f.text) m.pushEditOperations([], [{ range: m.getFullModelRange(), text: f.text }], () => null)
      savedVersion.set(keyOf(m), m.getAlternativeVersionId())
      useCodeStore.getState().setDirty(f.path, false)
    }
  }, [files])

  // 열 때 준 줄로(openFile(path, line)). 에디터가 아직 안 떴으면(처음 여는 파일) onMount 가 같은 일을 한다.
  useEffect(() => {
    if (!hidden) revealOf(editorRef.current, file)
  }, [file?.reveal?.seq, file?.path, hidden])

  return (
    <div className="code-ed" data-code="editor" hidden={hidden || !file}>
      {file?.conflict && (
        <div className="code-bar warn" role="alert" data-code="conflict" data-kind={file.conflict}>
          <span>{t(file.conflict === 'missing' ? 'code.conflict.missing' : 'code.conflict.changed')}</span>
          <button type="button" className="btn sec" data-code="keep-mine" onClick={() => useCodeStore.getState().setConflict(file.path, null)}>
            {t('code.conflict.keep')}
          </button>
          {file.conflict === 'changed' && (
            <button type="button" className="btn sec" data-code="take-disk" onClick={() => void useCodeStore.getState().reloadFromDisk(file.path)}>
              {t('code.conflict.take')}
            </button>
          )}
        </div>
      )}
      {file && conflictLines.length > 0 && (
        <div className="code-bar warn" role="status" data-code="merge-conflict" data-kind={file.gitConflict}>
          <GitMerge className="code-bar-ic" aria-hidden />
          <span>
            {file.gitConflict ? t('code.merge.kind.' + file.gitConflict) : t('code.merge.title')} · {(conflictAt ?? 0) + 1} / {conflictLines.length}
          </span>
          <span className="code-bar-hint">{t('code.merge.hint')}</span>
          <button type="button" className="aiws-ic" data-code="conflict-prev" title={t('code.merge.prev')} aria-label={t('code.merge.prev')} onClick={() => jumpConflict('previous')}>
            <ChevronUp />
          </button>
          <button type="button" className="aiws-ic" data-code="conflict-next" title={t('code.merge.next')} aria-label={t('code.merge.next')} onClick={() => jumpConflict('next')}>
            <ChevronDown />
          </button>
        </div>
      )}
      {file?.readOnly && (
        <div className="code-bar" role="status" data-code="readonly">
          {t('code.readonly').replace('{size}', mb(file.bytes)).replace('{limit}', mb(CODE_READONLY_BYTES))}
        </div>
      )}
      {file && kind && (
        <div className="code-bar doc-views" role="tablist" aria-label={t('doc.views')} data-code="doc-views">
          {DOC_VIEWS[kind].map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={v === view}
              className={'doc-view-btn' + (v === view ? ' on' : '')}
              data-doc-view={v}
              onClick={() => useCodeStore.getState().setDocView(file.path, v)}
            >
              {t('doc.view.' + v)}
            </button>
          ))}
        </div>
      )}
      {file && richTooBig && (
        <div className="code-bar" role="status" data-doc="too-big">
          <span>{t('doc.md.tooBig')}</span>
          {file.bytes <= MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES && (
            <button
              type="button"
              className="btn sec"
              data-doc="open-anyway"
              onClick={() => {
                richOverride.add(file.path)
                bump((n) => n + 1)
              }}
            >
              {t('doc.md.openAnyway')}
            </button>
          )}
        </div>
      )}
      {file && surface && kind && (
        <div
          className="doc-surface"
          data-code="doc-surface"
          data-kind={kind}
          data-view={view}
          onKeyDown={(e) => {
            // 리치 편집·표 안에서도 Ctrl+S 저장(Monaco 명령은 Monaco 에 포커스가 있을 때만 돈다).
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyS') {
              e.preventDefault()
              void save(file.path, askRef.current)
            }
          }}
        >
          <Suspense fallback={<div className="aiws-note">{t('code.loading')}</div>}>
            <DocSurface key={file.path + view} file={file} kind={kind} view={view} model={docModelOf(file)} />
          </Suspense>
        </div>
      )}
      {file && (
        <div className="code-monaco" hidden={surface}>
          <Editor
            path={uriOf(file.path).toString()}
            defaultValue={file.text}
            language={languageOf(file.path, LANGS)}
            theme="ara"
            keepCurrentModel
            // M12 R2 설정 › 편집기(줄바꿈·미니맵·글꼴) — 바꾸면 Editor 가 updateOptions 로 바로 따른다.
            options={options}
            onMount={(ed) => {
              editorRef.current = ed
              const st = useCodeStore.getState()
              const a = st.activeByWorktree[worktreeId]
              revealOf(ed, a ? st.files.find((f) => f.worktreeId === worktreeId && areWorktreePathsEqual(f.path, a, PLATFORM)) : undefined)
              watchConflicts(ed, setConflictLines, setConflictAt)
              // M12 R3 AI 작성 줄(로컬 파일만 — 원격 에이전트 훅은 이 PC 로 안 온다).
              watchAiLines(ed, () => {
                const m = ed.getModel()
                const f = m ? fileOf(m) : undefined
                return f && !f.host ? f.path : null
              })
              ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                const p = ed.getModel()?.uri.fsPath
                if (p) void save(p, askRef.current)
              })
            }}
          />
        </div>
      )}
    </div>
  )
}

/** 충돌 표시 줄을 장식하고(현재·공통 조상·들어오는 구역 색 + 표시 줄 라벨) 블록 시작 줄을 알린다. 모델이 바뀌면 다시, 고치면 150ms 묶어 다시. */
function watchConflicts(ed: ReturnType<typeof monaco.editor.create>, setLines: (l: number[]) => void, setAt: (i: number | null) => void): void {
  const deco = ed.createDecorationsCollection()
  let timer: ReturnType<typeof setTimeout> | null = null
  const labels = { current: t('code.merge.current'), base: t('code.merge.base'), incoming: t('code.merge.incoming'), end: t('code.merge.end') }
  const scan = (): void => {
    const text = ed.getModel()?.getValue() ?? ''
    const has = hasGitConflictMarkers(text)
    deco.set(has ? buildGitConflictDecorations(text, labels) : [])
    setLines(has ? findGitConflictBlocks(text).map((b) => b.startLine) : NO_LINES)
  }
  ed.onDidChangeModel(() => {
    setAt(null)
    scan()
  })
  ed.onDidChangeModelContent(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(scan, CONFLICT_SCAN_MS)
  })
  ed.onDidDispose(() => timer && clearTimeout(timer))
  scan()
}
const CONFLICT_SCAN_MS = 150
const NO_LINES: number[] = []

function revealOf(ed: ReturnType<typeof monaco.editor.create> | null, file: CodeFile | undefined): void {
  if (!ed || !file?.reveal) return
  ed.revealLineInCenter(file.reveal.line)
  ed.setPosition({ lineNumber: file.reveal.line, column: 1 })
  ed.focus()
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)

/**
 * 3차 R1-B 다른 보기가 읽고 쓰는 손잡이 — Monaco 모델이 글의 주인 그대로(더러움·저장·밖에서 바뀜이 한 길). 리치 편집은 모델에 써 넣는다.
 * 모델이 아직 없으면(처음부터 리치로 연 파일 — Editor 가 숨은 채 아직 안 떴다) 같은 uri 로 만든다(Editor 는 있는 모델을 쓴다).
 * 읽을 때 줄 끝은 LF 로(CRLF 파일도 보기 쪽은 LF 만 안다 — 써 넣으면 모델의 EOL 로 바뀐다).
 */
const lf = (m: Model): string => m.getLinesContent().join('\n')

function docModelOf(f: CodeFile): DocModel {
  const uri = uriOf(f.path)
  const model = (): Model => monaco.editor.getModel(uri) ?? monaco.editor.createModel(useCodeStore.getState().files.find((x) => x.path === f.path)?.text ?? f.text, languageOf(f.path, LANGS), uri)
  return {
    readOnly: f.readOnly,
    get: () => lf(model()),
    set: (text) => {
      const m = model()
      if (lf(m) !== text) m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null)
    },
    onChange: (cb) => {
      const d = model().onDidChangeContent(() => cb())
      return () => d.dispose()
    }
  }
}

/**
 * 저장(WS-08, Orca 규칙) — 모델의 지금 글을 쓰되, 읽은 뒤 디스크가 바뀌었으면(main 이 서명으로 판정) 덮어쓰기 전에 묻는다.
 * 지워졌으면 다시 만들지 묻는다. 쓰는 사이 더 친 글은 더러움으로 남는다(저장한 버전만 깨끗).
 */
async function save(path: string, ask: AskFn): Promise<boolean> {
  const f = useCodeStore.getState().files.find((x) => areWorktreePathsEqual(x.path, path, PLATFORM))
  const m = f ? monaco.editor.getModel(uriOf(f.path)) : null
  if (!f || !m || f.readOnly) return false
  const version = m.getAlternativeVersionId()
  const text = m.getValue()
  const req = { root: f.root, path: f.path, text, eol: f.eol, baseSig: f.sig, host: f.host }
  let r = await window.ev.code.write(req)
  if (!r.ok && 'conflict' in r) {
    const missing = r.conflict === 'missing'
    const yes = await ask({
      title: t(missing ? 'code.save.missingTitle' : 'code.save.changedTitle'),
      message: t(missing ? 'code.save.missingMsg' : 'code.save.changedMsg').replace('{path}', f.path),
      tone: 'danger',
      confirmLabel: t(missing ? 'code.save.recreate' : 'code.save.overwrite')
    })
    if (yes !== 'confirm') return false
    r = await window.ev.code.write({ ...req, force: true })
  }
  if (!r.ok) {
    await ask({ title: t('code.save.failTitle'), message: 'message' in r ? r.message : '', cancelLabel: null })
    return false
  }
  savedVersion.set(keyOf(m), version)
  useCodeStore.getState().markSaved(f.path, r.sig, text, m.getAlternativeVersionId() !== version)
  return true
}
