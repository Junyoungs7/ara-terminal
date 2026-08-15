import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRowKeys } from '../store/rowKeys'
import type { FileEntry, FileListResult, FileOpResult, SftpProgress, SftpXferResult } from '@shared/ipc'
import { ContextMenu } from '../interactions/ContextMenu'
import { fileMenu, type FileActionId } from '../interactions/actions'
import { planCrossPanelTransfer } from '../store/explorerTransfer'
import { deletePrompt } from '../store/deletePrompt'
import {
  IconClose,
  IconCopy,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconLinkFile,
  IconLinkFolder,
  IconPaste,
  IconPencil,
  IconRefresh,
  IconTrash,
  IconUp,
  IconUpload
} from './icons'
import { crumbs, humanSize, joinPath, relTime } from './filePath'
import { setUploader } from '../store/uploadBus'
import { filePaths, registerPasteTarget } from '../store/pasteFiles'
import type { DialogSpec, DialogResult } from './Dialog'
import { t } from '../i18n'

// [파일] 탭 파일 트리 (계획서 §C F7 + R7 / design-system 5.2).
// R7: SSH 전용이 아니다 — 활성 세션이 로컬이면 로컬 파일시스템(fs:*), SSH 면 원격(sftp:*)을 탐색한다.
// 두 백엔드는 같은 계약이라 아래 Backend 함수 테이블만 갈아끼우고 렌더 코드는 하나다(클래스 계층 없음).
//
// 조작: 클릭=선택(Shift 범위 / Ctrl 개별) · 폴더 더블클릭=진입 + 터미널 cd · 파일 더블클릭=다운로드(SFTP)
//       우클릭=열기/다운로드/이름 변경/새 폴더/삭제. 삭제는 항상 확인 다이얼로그를 거친다.

export type ActiveFileSession = { id: string; type: 'local' | 'ssh' } | null

// 행 종류 — 아이콘·안내문구·더블클릭 동작이 전부 이걸로 갈린다(순수 함수, 단위 테스트 대상).
// 링크는 **대상 종류**로 동작해야 한다: 폴더를 가리키는 링크가 파일로 보이면 들어갈 수가 없다.
export type RowKind = 'dir' | 'file' | 'linkDir' | 'linkFile' | 'broken'
export function rowKind(e: FileEntry): RowKind {
  if (e.link && e.broken) return 'broken'
  if (e.link) return e.type === 'dir' ? 'linkDir' : 'linkFile'
  return e.type
}
const ROW_ICON: Record<RowKind, JSX.Element> = {
  dir: <IconFolder />,
  file: <IconFile />,
  linkDir: <IconLinkFolder />,
  linkFile: <IconLinkFile />,
  broken: <IconLinkFile />
}

// 전송·삭제 큐 항목. pct=null 은 진행률을 알 수 없는 작업(재귀 삭제).
type QueueItem = { id: string; label: string; pct: number | null }

// 로컬 fs / 원격 SFTP 공통 백엔드. remote=true 인 쪽만 전송(다운·업로드)을 갖는다.
type Backend = {
  remote: boolean
  list(path: string): Promise<FileListResult>
  rename(path: string, name: string): Promise<FileOpResult>
  mkdir(dir: string, name: string): Promise<FileOpResult>
  remove(paths: string[], opId: string): Promise<FileOpResult>
  // 진행 중 작업 취소(전송·재귀 삭제 공통 id). 로컬 삭제는 취소 지점이 없어 no-op.
  cancel(opId: string): void
}

function backendFor(session: ActiveFileSession): Backend | null {
  if (!session) return null
  const sid = session.id
  if (session.type === 'ssh') {
    return {
      remote: true,
      list: (p) => window.ev.sftp.list(sid, p),
      rename: (p, n) => window.ev.sftp.rename(sid, p, n),
      mkdir: (d, n) => window.ev.sftp.mkdir(sid, d, n),
      remove: (paths, opId) => window.ev.sftp.remove(sid, opId, paths),
      cancel: (opId) => void window.ev.sftp.cancel(opId)
    }
  }
  return {
    remote: false,
    list: (p) => window.ev.fs.list(p),
    rename: (p, n) => window.ev.fs.rename(p, n),
    mkdir: (d, n) => window.ev.fs.mkdir(d, n),
    // #89: 로컬은 **휴지통**으로 간다(원격은 영구 — 서버에 휴지통이 없다). 확인 문구가 그 차이를 말한다.
    remove: (paths) => window.ev.fs.trash(paths),
    // ponytail: 로컬 삭제는 동기에 가까워 취소 지점이 없다. 느린 네트워크 드라이브가 문제가 되면
    // fs:trash 에도 opId 를 붙여 SFTP 와 같은 취소 토큰을 쓰면 된다.
    cancel: () => {}
  }
}

const newId = (p: string) => p + Math.random().toString(36).slice(2)

// 앱 안의 파일 클립보드(Ctrl+C). 모듈 스코프인 이유: 트리는 세션을 바꾸면 통째로 다시 그려지는데,
// "여기서 복사해서 저기에 붙여넣기"는 그 경계를 넘어야 쓸모가 있다.
type FileClip = { session: ActiveFileSession; dir: string; entries: FileEntry[]; at: number }
let fileClip: FileClip | null = null
// 앱 안에서 복사할 당시의 OS 파일 클립보드 내용. 붙여넣기 때 이것과 비교해 **어느 쪽이 더 최근인지**
// 가린다 — OS 클립보드에는 변경 시각이 없어서 이 스냅샷이 유일한 단서다.
let osClipAtCopy: string[] | null = null

/** 두 경로 목록이 같은가(순서 포함 — OS 클립보드는 순서를 유지한다). */
export function sameClipList(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * 붙여넣기 출처 고르기(순수 — 단위 테스트 대상).
 *  · OS 클립보드가 비어 있으면 앱 클립보드.
 *  · 앱에서 복사한 뒤 OS 클립보드가 **바뀌었으면** 그게 더 최근이다 → OS.
 *  · 앱에서 복사한 뒤 OS 클립보드가 그대로면 앱 복사가 더 최근이다 → 앱.
 *    (툴바 [복사]를 누르고 [붙여넣기]를 눌렀는데 몇 시간 전 탐색기에서 복사한 파일이 올라가던 문제)
 */
export function pasteSource(osPaths: readonly string[], snapshotAtCopy: readonly string[] | null, hasAppClip: boolean): 'os' | 'app' | 'none' {
  if (osPaths.length > 0 && (!hasAppClip || !sameClipList(snapshotAtCopy, osPaths))) return 'os'
  return hasAppClip ? 'app' : 'none'
}

export function FileTree({
  session,
  active,
  cwd,
  onCdTerminal,
  onTailFile,
  onSaveWork,
  onAiCli,
  onReveal,
  ask,
  askText,
  onLocate,
  sendLabel,
  onSend,
  reloadToken,
  toolbar
}: {
  session: ActiveFileSession
  // [파일] 탭이 실제로 보이는지. 숨어 있으면 파일시스템을 읽지 않는다(사이드바가 두 패널을 함께 렌더한다).
  active: boolean
  cwd: string | null
  // 트리 폴더 더블클릭 → 터미널에 cd 전송(트리→터미널 동기). Shell 이 활성 세션에 input.
  onCdTerminal?: (absPath: string) => void
  // W1 F13: 원격 파일 우클릭 [tail로 보기] → 메인 영역 로그 뷰어. 절대 경로를 넘긴다.
  onTailFile?: (absPath: string) => void
  // 지금 보고 있는 폴더를 작업 프로필로 저장(서버+경로 즐겨찾기). 상위가 이름을 물어본다.
  onSaveWork?: (absPath: string) => void
  // F27: 원격 폴더 우클릭 [이 폴더에서 AI CLI 시작] → 그 폴더가 채워진 창을 상위(Shell)가 연다.
  onAiCli?: (absPath: string) => void
  // F14: 터미널 Ctrl+V 업로드가 시작될 때 이 탭을 펼쳐 달라고 상위에 요청(전송 큐가 여기 있다).
  onReveal?: () => void
  // 삭제 확인·새 폴더 이름 입력. Shell 의 단일 Dialog 인스턴스를 그대로 쓴다(네이티브 confirm 금지).
  ask: (spec: DialogSpec) => Promise<DialogResult>
  askText: (spec: DialogSpec & { input: NonNullable<DialogSpec['input']> }) => Promise<string | null>
  // W4sat F20: 탐색기 2패널 모드 전용(옵션 — 사이드바 [파일] 탭에서는 안 넘어온다, 동작 불변).
  // 현재 세션·경로가 바뀔 때마다 상위(ExplorerView)에 알린다 — 다른 패널로 보낼 때 "여기가 출발지" 를 안다.
  onLocate?: (loc: { session: ActiveFileSession; path: string }) => void
  // 있으면 우클릭 메뉴에 "다른 패널로 복사/이동" 두 항목이 추가된다. 라벨은 목적지 패널 설명(예: "우측 패널").
  sendLabel?: string
  onSend?: (targets: FileEntry[], mode: 'copy' | 'move') => void
  // 값이 바뀌면 현재 경로를 다시 읽는다(다른 패널에서 이 패널로 들어온 전송 직후 새로고침용).
  reloadToken?: number
  // 탐색기 창(E1)에서만 켠다 — 툴바 한 줄(새 폴더·복사·붙여넣기·이름 바꾸기·삭제)을 덧붙인다.
  // 사이드바 [파일] 탭은 폭이 좁아 우클릭 메뉴로 충분하므로 기본 꺼짐. 동작은 우클릭 메뉴와 같은
  // 함수를 부른다 — 여기에 두 번째 구현을 만들지 않는다.
  toolbar?: boolean
}) {
  const [path, setPath] = useState('.')
  const [parent, setParent] = useState('.')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 다중 선택(이름 목록) + Shift 범위의 기준 행.
  // #82: 파일 목록 키보드 조작(↑↓ 이동 · Enter 선택).
  const listRef = useRef<HTMLDivElement>(null)
  const listKeys = useRowKeys(listRef, { selector: '[role="option"]' })
  const [sel, setSel] = useState<string[]>([])
  const [anchor, setAnchor] = useState<number | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueItem[]>([])
  // #92: 방금 받은 파일. 받는 곳을 묻지 않는 대신 **어디로 갔는지**를 이 줄이 말한다.
  const [got, setGot] = useState<{ name: string; localPath: string } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // best-effort 안내: cwd 이벤트를 한 번도 못 받은 세션은 자동 동기 미지원 가능성(수동 새로고침 폴백, C-4).
  const [autoSynced, setAutoSynced] = useState(false)
  // 경로 직접 입력 중일 때의 문자열(null = 브레드크럼 표시). 경로 자체(path)와 갈라 둔다 —
  // 입력을 취소하면 원래 자리에 그대로 남아야 한다.
  const [pathEdit, setPathEdit] = useState<string | null>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  // 큐에서 취소된 항목 id — 아직 시작하지 않은 항목은 루프가 건너뛴다.
  const canceled = useRef<Set<string>>(new Set())

  // 세션 객체는 상위에서 매 렌더 새로 만들어지므로 id·type 으로만 기억한다 —
  // 백엔드 정체성이 매 렌더 바뀌면 아래 로드 이펙트가 무한히 다시 돈다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const backend = useMemo(() => backendFor(session), [session?.id, session?.type])
  // 세션 id 도 같은 이유로 따로 뽑는다 — 업로드 콜백이 매 렌더 새로 만들어지면 전송 큐 등록이
  // 렌더마다 갈아 끼워진다.
  const sid = session?.id ?? null

  // 다음에 읽을 경로와 "읽어야 함" 표시. [파일] 탭은 숨어 있어도 마운트된 채라(사이드바가 두 패널을
  // 같이 렌더한다) 조건 없이 읽으면 세션을 만들 때마다 보이지도 않는 트리가 홈 디렉토리를 훑는다.
  const target = useRef('.')
  const dirty = useRef(true)

  const load = useCallback(
    async (p: string) => {
      if (!backend) return
      setLoading(true)
      setError(null)
      const res = await backend.list(p).catch((e: Error) => ({ ok: false as const, message: e.message }))
      setLoading(false)
      setSel([])
      setAnchor(null)
      setEditing(null)
      if (res.ok) {
        setEntries(res.entries)
        setPath(res.path)
        setParent(res.parent)
        // target 은 "지금 가리키는 디렉토리"의 단일 소스다. 브레드크럼·폴더 진입도 여기 반영해야
        // 터미널 Ctrl+V 업로드(F14)가 화면과 같은 곳으로 올라간다.
        target.current = res.path
      } else {
        setError(res.message)
        setEntries([])
      }
    },
    [backend]
  )

  // 세션 전환 → 홈('.')부터 다시. 세션이 없으면 초기화.
  useEffect(() => {
    target.current = '.'
    dirty.current = true
    setQueue([])
    setAutoSynced(false)
    if (!backend) {
      setEntries([])
      setError(null)
    }
  }, [backend])

  // 터미널 → 트리 동기(OSC7 cwd 변경). Shell 이 활성 세션의 cwd 를 주입한다(로컬·SSH 공통).
  useEffect(() => {
    if (backend && cwd) {
      setAutoSynced(true)
      target.current = cwd
      dirty.current = true
    }
  }, [cwd, backend])

  // 실제 읽기는 탭이 보일 때만. 숨은 동안 쌓인 cwd 변경은 다시 보일 때 한 번에 반영된다.
  useEffect(() => {
    if (!backend || !active || !dirty.current) return
    dirty.current = false
    void load(target.current)
  }, [backend, active, cwd, load])

  // W4sat F20: 탐색기 2패널 모드에서 상위가 "이 패널이 지금 어디를 보고 있는지" 알아야 다른 패널로
  // 보내는 복사/이동의 출발지·목적지를 조립할 수 있다. 사이드바 [파일] 탭에서는 onLocate 가 없다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onLocate?.({ session, path }), [session?.id, session?.type, path])

  const refresh = useCallback(() => void load(path), [load, path])
  const goUp = useCallback(() => void load(parent), [load, parent])

  // W4sat F20: 다른 패널에서 이 패널로 들어온 전송이 끝나면 상위가 reloadToken 을 올려 최신 목록을 보여준다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (reloadToken !== undefined) refresh()
  }, [reloadToken])
  // 폴더 진입 + 터미널에 cd 전송(트리→터미널 동기).
  const enterDir = useCallback(
    (name: string) => {
      const next = joinPath(path, name)
      void load(next)
      onCdTerminal?.(next)
    },
    [load, path, onCdTerminal]
  )

  // 조작 결과 공통 처리: 실패는 트리 상단 오류줄, 성공은 목록 갱신.
  const applyOp = useCallback(
    (res: FileOpResult) => {
      if (res.ok) refresh()
      else setError(res.message)
    },
    [refresh]
  )

  // ── 선택 ──
  const clickRow = useCallback(
    (e: React.MouseEvent, idx: number) => {
      const name = entries[idx].name
      if (e.shiftKey && anchor !== null) {
        const [a, b] = anchor <= idx ? [anchor, idx] : [idx, anchor]
        setSel(entries.slice(a, b + 1).map((x) => x.name))
        return
      }
      setAnchor(idx)
      if (e.ctrlKey || e.metaKey) setSel((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]))
      else setSel([name])
    },
    [entries, anchor]
  )

  // ── 전송 큐(SFTP 전용): 순차 실행 · 항목별 진행률 · 개별 취소 ──
  const runQueue = useCallback(
    async (jobs: { label: string; run: (transferId: string) => Promise<SftpXferResult> }[]) => {
      if (jobs.length === 0) return
      const items: QueueItem[] = jobs.map((j) => ({ id: newId('x-'), label: j.label, pct: 0 }))
      setQueue(items)
      for (let i = 0; i < jobs.length; i++) {
        const item = items[i]
        if (canceled.current.has(item.id)) continue
        const off = window.ev.sftp.onProgress(item.id, (p: SftpProgress) => {
          const pct = p.total > 0 ? Math.min(100, Math.round((p.transferred / p.total) * 100)) : 0
          setQueue((cur) => cur.map((x) => (x.id === item.id ? { ...x, pct } : x)))
        })
        const res = await jobs[i].run(item.id)
        off()
        setQueue((cur) => cur.filter((x) => x.id !== item.id))
        canceled.current.delete(item.id)
        if (!res.ok) {
          if (res.canceled) setError(res.cleaned === false ? t('sftp.cleanFail') : t('sftp.canceled'))
          else setError(res.message || t('sftp.failed'))
        }
      }
      setQueue([])
      refresh()
    },
    [refresh]
  )

  // 큐 항목 취소: 진행 중이면 main 에 취소 요청, 대기 중이면 루프가 건너뛴다.
  const cancelItem = useCallback(
    (id: string) => {
      canceled.current.add(id)
      backend?.cancel(id)
      setQueue((cur) => cur.filter((x) => x.id !== id))
    },
    [backend]
  )

  const selectedEntries = useCallback(() => entries.filter((e) => sel.includes(e.name)), [entries, sel])

  // #92(2026-08-16): 받는 곳을 **묻지 않는다.** 대신 어디로 갔는지 알려 준다.
  //
  // 왜 바꿨나: 2026-08-09 에 "원격 → 우리는 다운로드(위치를 직접 고른다)"로 못 박은 것은
  // 붙여넣기가 **조용히** 떨어져 어디 갔는지 몰랐기 때문이다(explorerTransfer.ts 머리주석).
  // 막아야 했던 것은 "조용히"지 "빠른"이 아니다 — 브라우저처럼 정해진 곳에 받고 경로를 보여 주면
  // 그 문제가 없다. 방향 규칙(붙여넣기로는 안 받는다)은 그대로다. 받는 길은 여전히 하나다.
  //
  // 위치를 고르고 싶으면 우클릭 [다른 위치에 받기] — 아래 askWhere=true 가 예전 경로 그대로다.
  const download = useCallback(
    async (targets: FileEntry[], askWhere = false) => {
      if (!session || !backend?.remote) return
      const files = targets.filter((e) => e.type === 'file')
      if (files.length === 0) return
      const sid = session.id
      // 묻지 않는 길: 받는 곳에 빈 이름을 잡아 바로 받는다. 덮어쓰기는 하지 않는다(freeName).
      if (!askWhere) {
        const dir = await window.ev.fs.downloadsDir()
        await runQueue(
          files.map((f) => ({
            label: `${t('sftp.downloading')} ${f.name}`,
            run: async (transferId: string) => {
              const name = await window.ev.fs.freeName(dir, f.name)
              // joinPath 는 구분자를 경로에서 추론한다 — 받는 곳이 Windows 경로면 '\' 로 붙는다.
              const localPath = joinPath(dir, name)
              const r = await window.ev.sftp.download({
                sessionId: sid,
                transferId,
                remotePath: joinPath(path, f.name),
                localPath,
                size: f.size
              })
              // 마지막으로 받은 것을 알린다 — 여러 개면 폴더만 열어도 다 보인다.
              if (r.ok) setGot({ name, localPath })
              return r
            }
          }))
        )
        return
      }
      // 여러 개면 받을 폴더를 한 번만 고른다(파일마다 저장 대화상자를 띄우지 않는다).
      if (files.length === 1) {
        const localPath = await window.ev.sftp.pickSavePath(files[0].name)
        if (!localPath) return
        await runQueue([
          {
            label: `${t('sftp.downloading')} ${files[0].name}`,
            run: (transferId) =>
              window.ev.sftp.download({
                sessionId: sid,
                transferId,
                remotePath: joinPath(path, files[0].name),
                localPath,
                size: files[0].size
              })
          }
        ])
        return
      }
      const dir = await window.ev.sftp.pickSaveDir()
      if (!dir) return
      await runQueue(
        files.map((f) => ({
          label: `${t('sftp.downloading')} ${f.name}`,
          run: (transferId: string) =>
            window.ev.sftp.download({
              sessionId: sid,
              transferId,
              remotePath: joinPath(path, f.name),
              localPath: joinPath(dir, f.name),
              size: f.size
            })
        }))
      )
    },
    [session, backend, path, runQueue]
  )

  // 올릴 곳은 target.current — 트리가 보여 주는 디렉토리이자, 탭이 숨어 있을 때는 터미널의
  // OSC7 cwd 다. path 상태를 쓰면 [파일] 탭을 한 번도 안 연 세션에서 홈으로 올라가 버린다(F14).
  const uploadPaths = useCallback(
    async (localPaths: string[]) => {
      if (!sid || !backend?.remote || localPaths.length === 0) return
      const dir = target.current
      await runQueue(
        localPaths.map((localPath) => ({
          label: `${t('sftp.uploading')} ${localPath.split(/[\\/]/).pop() || localPath}`,
          run: (transferId: string) => window.ev.sftp.upload({ sessionId: sid, transferId, localPath, remoteDir: dir })
        }))
      )
    },
    [sid, backend, runQueue]
  )

  // F14: 터미널 Ctrl+V(파일) → 이 큐. 원격 세션일 때만 등록하고, 세션이 바뀌면 즉시 갈아 끼운다
  // (등록이 남아 있으면 이전 서버로 올라간다).
  useEffect(() => {
    if (!sid || !backend?.remote) return
    setUploader({ sessionId: sid, upload: (paths) => void uploadPaths(paths), reveal: () => onReveal?.() })
    return () => setUploader(null)
  }, [sid, backend, uploadPaths, onReveal])

  const pickAndUpload = useCallback(async () => {
    const paths = await window.ev.sftp.pickUploadPaths()
    await uploadPaths(paths)
  }, [uploadPaths])

  // ── 파일 조작 ──
  const commitRename = useCallback(
    (name: string, value: string | null) => {
      setEditing(null)
      if (!backend || value === null || !value.trim() || value.trim() === name) return
      void backend.rename(joinPath(path, name), value.trim()).then(applyOp)
    },
    [backend, path, applyOp]
  )

  const newFolder = useCallback(async () => {
    if (!backend) return
    const name = await askText({
      title: t('file.mkdir.title'),
      message: t('file.mkdir.msg'),
      input: { placeholder: t('file.mkdir.placeholder') },
      confirmLabel: t('file.mkdir.btn'),
      cancelLabel: t('dlg.cancel')
    })
    if (!name) return
    applyOp(await backend.mkdir(path, name))
  }, [backend, path, askText, applyOp])

  const removeSelected = useCallback(async () => {
    if (!backend) return
    const targets = selectedEntries()
    if (targets.length === 0) return
    const dirs = targets.filter((e) => e.type === 'dir')
    // #89: 로컬=휴지통 / 원격=영구. 문구가 실제 동작과 어긋나면 그다음부터 확인 창을 안 읽는다.
    const prompt = deletePrompt({ remote: backend.remote, dirCount: dirs.length })
    const r = await ask({
      title: t('file.del.title'),
      message: t(prompt.messageKey),
      detail: [
        { label: t('file.del.items'), value: targets.map((e) => e.name).join(', ') },
        { label: t('file.del.count'), value: `${targets.length}${dirs.length > 0 ? ` (${t('file.del.folders')} ${dirs.length})` : ''}` }
      ],
      tone: 'danger',
      confirmLabel: t(prompt.confirmKey),
      cancelLabel: t('dlg.cancel')
    })
    if (r !== 'confirm') return
    const opId = newId('rm-')
    // 재귀 삭제는 오래 걸릴 수 있어 큐에 진행 항목으로 띄운다(취소 가능 — SFTP 는 실제로 멈춘다).
    setQueue([{ id: opId, label: `${t('file.del.progress')} ${targets.length}`, pct: null }])
    const res = await backend.remove(targets.map((e) => joinPath(path, e.name)), opId)
    setQueue([])
    canceled.current.delete(opId)
    applyOp(res)
  }, [backend, selectedEntries, ask, path, applyOp])

  // ── 우클릭 메뉴 ──
  const openMenu = useCallback(
    (e: React.MouseEvent, idx: number | null) => {
      e.preventDefault()
      e.stopPropagation()
      if (idx === null) setSel([])
      else if (!sel.includes(entries[idx].name)) {
        // 선택 밖의 행을 우클릭하면 그 행만 선택된다(탐색기 관례).
        setSel([entries[idx].name])
        setAnchor(idx)
      }
      setMenu({ x: e.clientX, y: e.clientY })
    },
    [sel, entries]
  )

  // W4sat F20: 사이드바 registry(interactions/actions.tsx) 를 건드리지 않고 이 두 항목만 로컬에서
  // 덧붙인다 — onSend 가 없는 호출측(사이드바 [파일] 탭)은 이 id 들이 존재조차 하지 않는다.
  const SEND_COPY = 'file.sendCopy'
  const SEND_MOVE = 'file.sendMove'

  const onMenuPick = useCallback(
    (id: string) => {
      setMenu(null)
      const targets = selectedEntries()
      if (id === SEND_COPY || id === SEND_MOVE) {
        if (targets.length > 0) onSend?.(targets, id === SEND_COPY ? 'copy' : 'move')
        return
      }
      switch (id as FileActionId) {
        case 'file.open':
          if (targets[0]) enterDir(targets[0].name)
          return
        case 'file.edit':
          // 편집기 창은 main 이 띄운다(파일당 창 하나). 원격이면 세션 id 를 넘겨 그 커넥션으로 읽는다.
          if (targets[0]) {
            const remote = session?.type === 'ssh' ? session.id : null
            void window.ev.editor.open(remote, joinPath(path, targets[0].name))
          }
          return
        case 'file.openWith':
          // #89: 실패(연결 프로그램 없음 등)를 삼키지 않는다 — 아무 일도 안 일어나면 고장으로 보인다.
          if (targets[0]) {
            void window.ev.fs.openPath(joinPath(path, targets[0].name)).then((r) => !r.ok && setError(r.message))
          }
          return
        case 'file.download':
          void download(targets)
          return
        case 'file.downloadAs':
          void download(targets, true)
          return
        case 'file.saveWork':
          onSaveWork?.(path)
          return
        case 'file.aicli':
          // 대상은 우클릭한 폴더다(지금 보고 있는 폴더가 아니라 — file.saveWork 와 다른 점).
          if (targets[0]) onAiCli?.(joinPath(path, targets[0].name))
          return
        case 'file.tail':
          if (targets[0]) onTailFile?.(joinPath(path, targets[0].name))
          return
        case 'file.rename':
          if (targets[0]) setEditing(targets[0].name)
          return
        case 'file.mkdir':
          void newFolder()
          return
        case 'file.delete':
          void removeSelected()
          return
      }
    },
    [selectedEntries, enterDir, download, newFolder, removeSelected, onTailFile, onSaveWork, onAiCli, onSend, path, backend, session]
  )

  // ── Ctrl+C / Ctrl+V ── (준영님 제보: 드래그&드롭은 되는데 복사·붙여넣기가 안 된다)
  // 붙여넣기 우선순위: ① OS 클립보드에 파일이 있으면 드롭과 똑같이 처리한다(사용자 기대가 그것이다)
  //                    ② 없으면 앱 안에서 Ctrl+C 한 항목을 이 폴더로 복사한다.
  const copySelection = useCallback(() => {
    const entries = selectedEntries()
    if (entries.length === 0) return
    fileClip = { session, dir: path, entries, at: Date.now() }
    // 지금 OS 클립보드에 무엇이 있었는지 찍어 둔다 — 붙여넣기 때 "그 뒤로 바뀌었는지"를 이걸로 판단한다.
    void window.ev.clipboard
      .readFiles()
      .then((r) => {
        osClipAtCopy = r.paths
      })
      .catch(() => {
        osClipAtCopy = []
      })
    // 붙여넣을 곳이 앱 밖일 수도 있다 — 절대경로를 텍스트로도 올려 둔다(터미널·편집기에 그대로 붙는다).
    void navigator.clipboard?.writeText(entries.map((e) => joinPath(path, e.name)).join('\n')).catch(() => {})
  }, [selectedEntries, session, path])

  const pasteHere = useCallback(async () => {
    const dir = target.current
    const os = await window.ev.clipboard.readFiles().catch(() => ({ paths: [] as string[] }))
    const src = pasteSource(os.paths, osClipAtCopy, fileClip !== null)

    // ① OS 클립보드(윈도 탐색기에서 Ctrl+C 한 파일)
    if (src === 'os') {
      if (backend?.remote) return void uploadPaths(os.paths)
      const r = await window.ev.fs.copy(os.paths, dir)
      return applyOp(r)
    }
    // ② 앱 안에서 복사한 항목
    if (src === 'none' || !fileClip) return
    // 같은 서버 안이면 서버에서 cp 를 돌린다 — 내려받았다 올리면 같은 디스크 복사에 네트워크를 두 번 탄다.
    if (fileClip.session?.type === 'ssh' && session?.type === 'ssh' && fileClip.session.id === session.id) {
      const paths = fileClip.entries.map((e) => joinPath(fileClip!.dir, e.name))
      return applyOp(await window.ev.sftp.copyRemote(session.id, paths, dir))
    }
    const plan = planCrossPanelTransfer({ session: fileClip.session, path: fileClip.dir }, { session, path: dir }, fileClip.entries, 'copy')
    if (plan.kind === 'local') return applyOp(await window.ev.fs.copy(plan.paths, plan.destDir))
    if (plan.kind === 'localToRemote') {
      // 폴더는 업로드 스트림이 다루지 못한다(파일 하나 = 스트림 하나) — planner 가 걸러 준다.
      if (plan.files.length === 0) return setError(t('file.paste.dirOnly'))
      return void uploadPaths(plan.files.map((f) => f.localPath))
    }
    if (plan.kind === 'remoteToRemote') {
      // 폴더는 스트림으로 못 옮긴다(파일 하나 = 스트림 하나) — 걸러진 게 있으면 그것만 알린다.
      if (plan.files.length === 0) return setError(t('file.paste.dirOnly'))
      await runQueue(
        plan.files.map((f) => ({
          label: `${t('sftp.copying')} ${f.name}`,
          run: (transferId: string) =>
            window.ev.sftp.copyBetween({
              srcSessionId: plan.srcSessionId,
              destSessionId: plan.destSessionId,
              transferId,
              remotePath: f.remotePath,
              destDir: plan.destDir,
              size: f.size
            })
        }))
      )
      return refresh()
    }
    setError(
      t(
        plan.reason === 'useDownload'
          ? 'file.paste.useDownload'
          : plan.reason === 'sameRemote'
            ? 'file.paste.sameRemote'
            : 'file.paste.empty'
      )
    )
  }, [backend, uploadPaths, applyOp, session, runQueue, refresh])

  // 트리에 포커스가 있을 때만 잡는다(터미널·검색창의 Ctrl+C 를 가로채면 안 된다).
  // Ctrl+V 는 여기서 잡지 않는다 — 가로채면 브라우저 paste 이벤트가 오지 않아 Windows 에서
  // 파일이 하나만 잡힌다(A-3). 아래 registerPasteTarget 이 진짜 paste 에서 받는다.
  const onTreeKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== 'c') return
      e.preventDefault()
      e.stopPropagation()
      copySelection()
    },
    [copySelection]
  )

  // 붙여넣기는 전부 여기로 온다. 편집 불가 요소(트리)는 paste 이벤트가 요소가 아니라 document 로만
  // 오기 때문에(실측) React 의 onPaste 로는 못 받는다.
  //   · 파일이 있으면 → 업로드/복사. **여러 개가 다 온다**(예전 clipboard API 는 첫 개만, A-3).
  //   · 없으면 → 앱 안에서 복사한 항목 붙여넣기(pasteHere).
  useEffect(() => {
    const el = dropRef.current
    if (!el) return
    return registerPasteTarget({
      el,
      onFiles: (files) => {
        const paths = filePaths(files)
        if (paths.length === 0) {
          void pasteHere()
          return true
        }
        if (backend?.remote) void uploadPaths(paths)
        else void window.ev.fs.copy(paths, target.current).then(applyOp)
        return true
      }
    })
  }, [backend, uploadPaths, applyOp, pasteHere])

  // OS 파일탐색기 → 트리 드롭 업로드(SFTP 전용). Electron: File.path 로 로컬 경로 확보.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dropRef.current?.classList.remove('drag-over')
      if (!backend?.remote) return
      const paths = [...e.dataTransfer.files].map((f) => (f as File & { path?: string }).path).filter((p): p is string => Boolean(p))
      void uploadPaths(paths)
    },
    [backend, uploadPaths]
  )
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!backend?.remote) return
      e.preventDefault()
      dropRef.current?.classList.add('drag-over')
    },
    [backend]
  )
  const onDragLeave = useCallback(() => dropRef.current?.classList.remove('drag-over'), [])

  if (!backend) {
    return <span className="sb-placeholder">{t('sidebar.file.placeholder')}</span>
  }

  const selFiles = selectedEntries().filter((e) => e.type === 'file').length
  const crumbList = crumbs(path)

  return (
    <div
      className="sftp-wrap"
      ref={dropRef}
      // 키보드 이벤트를 받으려면 포커스를 가질 수 있어야 한다(트리 어디를 클릭해도 여기로 올라온다).
      tabIndex={-1}
      onKeyDown={onTreeKey}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className="sftp-path-bar">
        <div className="sb-act" title={t('sftp.up')} onClick={goUp}>
          <IconUp />
        </div>
        <div className="sb-act" data-action="path.edit" title={t('sftp.path.edit')} onClick={() => setPathEdit(path)}>
          <IconPencil />
        </div>
        {/* 경로 줄. 평소에는 브레드크럼(세그먼트 클릭 = 그 상위로 한 번에), [경로 입력]을 누르면
            경로를 통째로 치거나 붙여넣는 입력이 된다(준영님 요청 2026-08-13).
            빈 자리 클릭으로 바꾸는 윈도우 관습은 쓰지 않았다 — 이 줄은 direction:rtl 이라
            남는 자리가 왼쪽에 생겨서, 누를 곳이 어디인지가 눈에 안 보인다. */}
        {pathEdit === null ? (
          <div className="fcrumb" title={path}>
            {crumbList.map((c, i) => (
              <span key={c.path}>
                {i > 0 && <span className="sepr">/</span>}
                <span className="seg" onClick={() => void load(c.path)}>
                  {c.label}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <input
            className="fpath-in"
            data-field="path"
            autoFocus
            spellCheck={false}
            value={pathEdit}
            onChange={(e) => setPathEdit(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const p = pathEdit.trim()
                setPathEdit(null)
                if (p && p !== path) void load(p)
              } else if (e.key === 'Escape') {
                setPathEdit(null)
              }
              // 트리 단축키(삭제·복사 등)가 입력 중에 발동하지 않게 여기서 끊는다.
              e.stopPropagation()
            }}
            onBlur={() => setPathEdit(null)}
          />
        )}
        {backend.remote && (
          <div className="sb-act" title={t('sftp.upload')} onClick={pickAndUpload}>
            <IconUpload />
          </div>
        )}
        <div className="sb-act" title={t('sftp.refresh')} onClick={refresh}>
          <IconRefresh />
        </div>
      </div>

      {toolbar && (
        <div className="ftool">
          <button type="button" className="ftb" title={t('conn.menu.file.mkdir')} onClick={() => void newFolder()}>
            <IconFolderPlus />
            <span>{t('conn.menu.file.mkdir')}</span>
          </button>
          <span className="ftsep" />
          <button type="button" className="ftb" disabled={sel.length === 0} title={t('file.copy')} onClick={copySelection}>
            <IconCopy />
            <span>{t('file.copy')}</span>
          </button>
          <button type="button" className="ftb" title={t('file.paste')} onClick={() => void pasteHere()}>
            <IconPaste />
            <span>{t('file.paste')}</span>
          </button>
          <span className="ftsep" />
          <button
            type="button"
            className="ftb"
            disabled={sel.length !== 1}
            title={t('conn.menu.file.rename')}
            onClick={() => setEditing(sel[0])}
          >
            <IconPencil />
            <span>{t('conn.menu.file.rename')}</span>
          </button>
          <button type="button" className="ftb danger" disabled={sel.length === 0} title={t('conn.menu.file.delete')} onClick={() => void removeSelected()}>
            <IconTrash />
            <span>{t('conn.menu.file.delete')}</span>
          </button>
          {sel.length > 0 && <span className="ftcount">{t('file.selected').replace('{n}', String(sel.length))}</span>}
        </div>
      )}

      {backend.remote && !autoSynced && <div className="sftp-note">{t('sftp.bestEffort')}</div>}
      {error && <div className="sftp-err">{error}</div>}
      {/* #92: 받는 곳을 묻지 않는 대신 어디로 갔는지 여기서 말한다. 경로 전문은 title 로 —
          한 줄에 다 넣으면 긴 경로가 트리를 밀어낸다. [폴더 열기]가 마지막 확인 수단이다. */}
      {got && (
        <div className="sftp-got">
          <span className="g-txt" title={got.localPath}>
            {t('sftp.got').replace('{n}', got.name)}
          </span>
          <button type="button" className="g-act" onClick={() => void window.ev.fs.reveal(got.localPath)}>
            {t('sftp.got.reveal')}
          </button>
          <button type="button" className="g-x" title={t('dlg.cancel')} onClick={() => setGot(null)}>
            <IconClose />
          </button>
        </div>
      )}

      {/* 빈 영역 우클릭 = 새 폴더. 행 우클릭은 openMenu 가 전파를 끊는다. */}
      {/* #82: 목록이라 트리가 아니라 listbox 다 — 여기서 펼치고 접는 것이 없다(폴더는 들어간다).
          ↑↓ 로 옮기고 Enter 로 고른다. 들어가는 것은 기존대로 더블클릭. */}
      <div
        className="ftree"
        ref={listRef}
        role="listbox"
        aria-label={t('sidebar.tab.file')}
        {...listKeys}
        onContextMenu={(e) => openMenu(e, null)}
      >
        {loading && <div className="sftp-empty">{t('sftp.loading')}</div>}
        {!loading && entries.length === 0 && !error && <div className="sftp-empty">{t('sftp.empty')}</div>}
        {!loading &&
          entries.map((entry, idx) => {
            // 링크는 대상 종류로 동작한다: 폴더 링크는 더블클릭하면 그 대상 폴더로 들어간다
            // (경로는 서버가 realpath 로 풀어 주므로 브레드크럼도 실제 경로가 된다).
            // 끊긴 링크는 들어갈 데가 없으니 안내만 한다.
            const kind = rowKind(entry)
            const isDir = kind === 'dir' || kind === 'linkDir'
            const icon = ROW_ICON[kind]
            const hint =
              kind === 'broken'
                ? t('file.brokenLink')
                : kind === 'linkDir'
                  ? t('file.linkDirHint')
                  : kind === 'linkFile'
                    ? t('file.linkFileHint')
                    : isDir
                      ? t('file.openHint')
                      : backend.remote
                        ? t('sftp.download')
                        : entry.name
            return (
              <div
                key={entry.name}
                className={
                  'frow' + (isDir ? ' dir' : '') + (entry.broken ? ' broken' : '') + (sel.includes(entry.name) ? ' sel' : '')
                }
                role="option"
                tabIndex={-1}
                aria-selected={sel.includes(entry.name)}
                title={hint}
                onClick={(e) => clickRow(e, idx)}
                onDoubleClick={() => {
                  if (kind === 'broken') return setError(t('file.brokenLink'))
                  if (isDir) enterDir(entry.name)
                  else void download([entry])
                }}
                onContextMenu={(e) => openMenu(e, idx)}
              >
                <span className="fi">{icon}</span>
                {editing === entry.name ? (
                  <input
                    className="fedit"
                    defaultValue={entry.name}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onBlur={(e) => commitRename(entry.name, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      // 편집 중에는 전역 단축키로 새어 나가면 안 된다.
                      e.stopPropagation()
                      if (e.key === 'Enter') commitRename(entry.name, e.currentTarget.value)
                      else if (e.key === 'Escape') commitRename(entry.name, null)
                    }}
                  />
                ) : (
                  <>
                    <span className="fn">{isDir ? entry.name + '/' : entry.name}</span>
                    <span className="fmt">{relTime(entry.mtime)}</span>
                    {/* 폴더도 빈 칸을 차지해야 mtime 열이 한 줄로 정렬된다. */}
                    <span className="fsz">{isDir ? '' : humanSize(entry.size)}</span>
                  </>
                )}
              </div>
            )
          })}
      </div>

      {queue.length > 0 && (
        <div className="sftp-xfer">
          {queue.map((item) => (
            <div key={item.id} className="xfer-item">
              <div className="xfer-row">
                <span className="xfer-label">{item.label}</span>
                <span className="xfer-cancel" title={t('sftp.cancel')} onClick={() => cancelItem(item.id)}>
                  <IconClose />
                </span>
              </div>
              <div className="xfer-bar">
                <div className={'xfer-fill' + (item.pct === null ? ' indet' : '')} style={item.pct === null ? undefined : { width: `${item.pct}%` }} />
              </div>
              {item.pct !== null && <span className="xfer-pct">{item.pct}%</span>}
            </div>
          ))}
        </div>
      )}

      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={[
          ...fileMenu({
            count: sel.length,
            isDir: sel.length === 1 && selectedEntries()[0]?.type === 'dir',
            canDownload: backend.remote && selFiles > 0,
            // #89: 로컬 파일 하나일 때만. 원격은 실체가 이 PC 에 없어 OS 가 열 수 없다.
            canOpenWith: !backend.remote && selFiles === 1 && sel.length === 1,
            canTail: backend.remote && Boolean(onTailFile),
            // 원격 폴더에만 붙는다 — 이 창은 "서버에 접속해 그 폴더에서 시작"이라 로컬에는 뜻이 없다.
            canAiCli: backend.remote && Boolean(onAiCli)
          }),
          // W4sat F20: 탐색기 2패널 모드에서만 존재(onSend 가 있을 때만) — 사이드바 [파일] 탭은 그대로.
          ...(onSend && sel.length > 0
            ? [
                { id: SEND_COPY, label: `${t('file.sendCopy')} ${sendLabel ?? ''}`.trim() },
                { id: SEND_MOVE, label: `${t('file.sendMove')} ${sendLabel ?? ''}`.trim() }
              ]
            : [])
        ]}
        onPick={onMenuPick}
        onClose={() => setMenu(null)}
      />
    </div>
  )
}
