import { useEffect, useRef, type JSX } from 'react'
import Editor from '@monaco-editor/react'
import { CODE_READONLY_BYTES, languageOf } from '@shared/codeFiles'
import { areWorktreePathsEqual } from '@shared/worktrees'
import type { DialogResult, DialogSpec } from '../../components/Dialog'
import { t } from '../../i18n'
import { monaco } from './monacoSetup'
import { PLATFORM, useCodeStore, type CodeFile } from './codeStore'

type AskFn = (spec: DialogSpec) => Promise<DialogResult>
type Model = ReturnType<typeof monaco.editor.createModel>

/**
 * M6 WS-07·08 — AI 작업 공간 가운데의 코드 에디터(Monaco). AgentPane 이 lazy 로 부른다 — 이 청크(+monacoSetup)가 Monaco 를 끌고 온다.
 * Orca components/editor/MonacoEditor.tsx·ExternalFileChangeBanner(orcaRef 7a7f46f8a3)의 1차 판: 파일마다 모델 하나(경로 = 모델 uri),
 * 더러움 = 저장한 뒤의 버전과 다름(VS Code 와 같은 alternativeVersionId), Ctrl+S 저장, 밖에서 바뀌면 띠로 안내.
 * 뺀 것: 비교(M7)·자동 저장·미니맵 설정·마크다운 미리보기·여러 분할.
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
  const file = activePath ? files.find((f) => f.worktreeId === worktreeId && areWorktreePathsEqual(f.path, activePath, PLATFORM)) : undefined
  const editorRef = useRef<ReturnType<typeof monaco.editor.create> | null>(null)
  const askRef = useRef(ask)
  askRef.current = ask

  // 저장·정리 손잡이를 상태 저장소에 건다(탭 줄의 닫기 확인이 부른다 — 그쪽은 monaco 를 모른다).
  useEffect(() => {
    useCodeStore.setState({ editorOps: { save: (p) => save(p, askRef.current), dispose: (p) => monaco.editor.getModel(uriOf(p))?.dispose() } })
    return () => useCodeStore.setState({ editorOps: null })
  }, [])

  // 디스크에서 다시 읽은 글(loadSeq 가 오름)을 모델에 넣는다 — 실행 취소로 되돌릴 수 있게 편집으로 넣는다.
  useEffect(() => {
    for (const f of files) {
      const m = monaco.editor.getModel(uriOf(f.path))
      if (!m || (appliedSeq.get(keyOf(m)) ?? 0) >= f.loadSeq) continue
      appliedSeq.set(keyOf(m), f.loadSeq)
      if (m.getValue() !== f.text) m.pushEditOperations([], [{ range: m.getFullModelRange(), text: f.text }], () => null)
      savedVersion.set(keyOf(m), m.getAlternativeVersionId())
      useCodeStore.getState().setDirty(f.path, false)
    }
  }, [files])

  // 열 때 준 줄로(openFile(path, line)).
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || !file?.reveal || hidden) return
    ed.revealLineInCenter(file.reveal.line)
    ed.setPosition({ lineNumber: file.reveal.line, column: 1 })
    ed.focus()
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
      {file?.readOnly && (
        <div className="code-bar" role="status" data-code="readonly">
          {t('code.readonly').replace('{size}', mb(file.bytes)).replace('{limit}', mb(CODE_READONLY_BYTES))}
        </div>
      )}
      {file && (
        <div className="code-monaco">
          <Editor
            path={uriOf(file.path).toString()}
            defaultValue={file.text}
            language={languageOf(file.path, LANGS)}
            theme="ara"
            keepCurrentModel
            options={{ readOnly: file.readOnly, automaticLayout: true, minimap: { enabled: false }, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono') }}
            onMount={(ed) => {
              editorRef.current = ed
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

const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)

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
  const req = { root: f.root, path: f.path, text, eol: f.eol, baseSig: f.sig }
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
