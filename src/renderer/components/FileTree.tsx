import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRowKeys } from '../store/rowKeys'
import type { FileEntry, FileListResult, FileOpResult, SftpProgress, SftpXferResult } from '@shared/ipc'
import { ContextMenu } from '../interactions/ContextMenu'
import { fileMenu, type FileActionId } from '../interactions/actions'
import { planCrossPanelTransfer } from '../store/explorerTransfer'
import { deletePrompt } from '../store/deletePrompt'
import { HelpTip } from './ctrShared'
import {
  IconBack,
  IconClose,
  IconCopy,
  IconCut,
  IconFile,
  IconFilePlus,
  IconFolder,
  IconFolderPlus,
  IconForward,
  IconLinkFile,
  IconLinkFolder,
  IconPaste,
  IconPencil,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUp,
  IconUpload
} from './icons'
import {
  IconAud,
  IconCode,
  IconExcel,
  IconExe,
  IconImg,
  IconPdf,
  IconPpt,
  IconTxt,
  IconVid,
  IconWord,
  IconZip,
  type FileIconKind
} from './fileIcons'
import { crumbs, humanSize, joinPath, relTime } from './filePath'
import { DEFAULT_SORT, EMPTY_HISTORY, nextSort, pushHistory, viewEntries, type SortSpec } from '../store/fileView'
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

// serverKey: 삭제 확인창이 **어느 서버인지** 찍는 데 쓴다(2026-08-16). 원격 삭제는 영구이고,
// 하단과 작업대가 서로 다른 서버를 볼 수 있는 구조라 대상을 밝히지 않으면 안 된다.
export type ActiveFileSession = { id: string; type: 'local' | 'ssh'; serverKey?: string } | null

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

/**
 * 확장자 → 아이콘 종류. **순수 함수 — 단위 테스트 대상.**
 *
 * 2026-08-22 준영님 제보 25번("실제 엑셀·mp4·ppt 등 다양한 확장자에 맞게") → 7·8번("색상이 없는
 * 아이콘이다 보니 구분이 잘 안 감")으로 이어졌다. 이제 갈래마다 **색 있는 실제 아이콘**이 붙는다
 * (components/fileIcons.tsx — material-icon-theme 에서 쓸 것만 인라인).
 *
 * 확장자를 다 적지 않는다: 한눈에 갈려야 하는 것은 "무슨 종류인가"이지 "무슨 프로그램이 여는가"가
 * 아니다. 열한 갈래로 묶고 나머지는 기본 종이로 둔다 — 갈래가 늘수록 각 아이콘의 뜻이 흐려진다.
 * 코드는 언어별로 쪼개지 않았다(js·py·go 를 눈으로 가릴 일보다 "이건 코드다"가 먼저다).
 */
const EXT_KIND: Record<string, FileIconKind> = {
  xlsx: 'sheet', xls: 'sheet', xlsm: 'sheet', csv: 'sheet', tsv: 'sheet', ods: 'sheet',
  // 워드 계열과 그냥 글 파일을 가른다 — 아이콘이 실제로 다르고, 여는 프로그램도 다르다.
  docx: 'word', doc: 'word', hwp: 'word', hwpx: 'word', rtf: 'word', odt: 'word',
  txt: 'text', md: 'text', log: 'text', readme: 'text',
  pptx: 'slide', ppt: 'slide', odp: 'slide', key: 'slide',
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image', webp: 'image', svg: 'image', ico: 'image', tif: 'image', tiff: 'image', psd: 'image',
  mp4: 'video', avi: 'video', mkv: 'video', mov: 'video', wmv: 'video', flv: 'video', webm: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio', wma: 'audio',
  zip: 'zip', tar: 'zip', gz: 'zip', tgz: 'zip', bz2: 'zip', xz: 'zip', rar: 'zip', '7z': 'zip', jar: 'zip',
  exe: 'exe', msi: 'exe', appx: 'exe', dmg: 'exe', deb: 'exe', rpm: 'exe',
  js: 'code', ts: 'code', tsx: 'code', jsx: 'code', mjs: 'code', cjs: 'code', json: 'code', xml: 'code',
  html: 'code', htm: 'code', css: 'code', scss: 'code', py: 'code', java: 'code', kt: 'code', go: 'code',
  rs: 'code', rb: 'code', php: 'code', c: 'code', h: 'code', cpp: 'code', cs: 'code', sh: 'code', bash: 'code',
  zsh: 'code', ps1: 'code', bat: 'code', sql: 'code', yml: 'code', yaml: 'code', toml: 'code', ini: 'code', conf: 'code'
}

export function fileIconKind(name: string): FileIconKind {
  // 숨김 파일(.gitignore)은 앞의 점이 확장자 구분자가 아니다 — 1번 위치부터 찾는다.
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'plain'
  return EXT_KIND[name.slice(dot + 1).toLowerCase()] ?? 'plain'
}

const KIND_ICON: Record<FileIconKind, JSX.Element> = {
  sheet: <IconExcel />,
  word: <IconWord />,
  text: <IconTxt />,
  slide: <IconPpt />,
  pdf: <IconPdf />,
  image: <IconImg />,
  video: <IconVid />,
  audio: <IconAud />,
  zip: <IconZip />,
  code: <IconCode />,
  exe: <IconExe />,
  // 모르는 확장자에는 색을 쓰지 않는다 — 색은 "무슨 종류인지 안다"는 말이다.
  plain: <IconFile />
}

/** 행 아이콘 — 폴더·링크는 종류가 정하고, 보통 파일만 확장자를 본다. */
function rowIcon(kind: RowKind, name: string): JSX.Element {
  return kind === 'file' ? KIND_ICON[fileIconKind(name)] : ROW_ICON[kind]
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

// 앱 안의 파일 클립보드(Ctrl+C / Ctrl+X). 모듈 스코프인 이유: 트리는 세션을 바꾸면 통째로 다시
// 그려지는데, "여기서 복사해서 저기에 붙여넣기"는 그 경계를 넘어야 쓸모가 있다.
// mode='cut' 은 **로컬 안에서만** 담긴다(#88 R2) — 원격이 끼면 이동이 아니라 전송이고, 반쯤 올라간
// 파일을 원본 삭제로 갚을 수 없다.
type FileClip = { session: ActiveFileSession; dir: string; entries: FileEntry[]; mode: 'copy' | 'cut'; at: number }
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
  onTerminalHere,
  onAskAiPaths,
  onReveal,
  ask,
  askText,
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
  /** #88 R1: 지금 보고 있는 폴더에서 새 셸을 연다(로컬=내 PC, 원격=그 서버). */
  onTerminalHere?: (absPath: string) => void
  /** #88 R1: 고른 파일·폴더를 아라 입력창에 얹는다(경로만 — 내용은 사용자가 물으며 붙인다). */
  onAskAiPaths?: (paths: string[]) => void
  // F14: 터미널 Ctrl+V 업로드가 시작될 때 이 탭을 펼쳐 달라고 상위에 요청(전송 큐가 여기 있다).
  onReveal?: () => void
  // 삭제 확인·새 폴더 이름 입력. Shell 의 단일 Dialog 인스턴스를 그대로 쓴다(네이티브 confirm 금지).
  ask: (spec: DialogSpec) => Promise<DialogResult>
  askText: (spec: DialogSpec & { input: NonNullable<DialogSpec['input']> }) => Promise<string | null>
  // (#88 R2 에서 onLocate·sendLabel·onSend·reloadToken 을 지웠다 — 탐색기 2패널 모드가 #91 에서
  //  사라지면서 넘기는 곳이 없어졌다. 죽은 소품은 다음 사람이 "쓰는 데가 있겠지" 하고 지키게 된다.
  //  패널 사이 복사/이동은 pasteHere 의 planCrossPanelTransfer 가 그대로 맡는다.)
  // 작업대(#91) [파일] 탭에서만 켠다 — 이 트리의 **넓은 판**이다.
  //   · 툴바 한 줄(새 폴더·새 파일·복사·잘라내기·붙여넣기·이름·삭제)
  //   · 경로 줄의 자리 먹는 것들(뒤로/앞으로·이름 검색·드라이브) — #88 R2
  // 사이드바 [파일] 탭(280px)은 곁눈질용이라 이것들을 얹으면 브레드크럼이 눌리지 않을 만큼
  // 짓눌린다(실측: FILE-4 가 "path-bar 가 클릭을 가로챈다"로 잡았다). **기능이 갈리는 게 아니라
  // 자리가 갈린다** — 정렬·숨김·상태 표시줄처럼 폭을 안 쓰는 것은 양쪽에 그대로 있다.
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
  // 경로가 칸보다 길면 **끝**(현재 폴더)이 보여야 한다. 왼쪽 정렬로 바꾸면서(제보 5번) direction:rtl
  // 이 하던 일을 여기서 대신한다 — 경로가 바뀔 때마다 오른쪽 끝으로 민다.
  // **훅은 전부 여기 위쪽에 모은다**: 아래에 `if (!backend) return` 이 있어서 그 뒤에 훅을 두면
  // 렌더마다 훅 개수가 달라져 React 가 통째로 죽는다(2026-08-22 실측 — 스모크가 부팅에서 멎었다).
  const crumbRef = useRef<HTMLDivElement>(null)
  // 경로 직접 입력 중일 때의 문자열(null = 브레드크럼 표시). 경로 자체(path)와 갈라 둔다 —
  // 입력을 취소하면 원래 자리에 그대로 남아야 한다.
  const [pathEdit, setPathEdit] = useState<string | null>(null)
  useEffect(() => {
    const el = crumbRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [path, pathEdit])
  // ── #88 R2 보기 상태 ──
  // 숨김은 **보이는 것이 기본**이다. 탐색기는 감추는 쪽이 기본이지만 여기 오는 사람은 `.git`·`.env`
  // 를 찾으러 온다 — 기본값을 뒤집으면 지금까지 보이던 것이 갑자기 사라진다(원격도 같은 트리다).
  const [showHidden, setShowHidden] = useState(true)
  const [sort, setSort] = useState<SortSpec>(DEFAULT_SORT)
  const [filter, setFilter] = useState('')
  const [filterOn, setFilterOn] = useState(false)
  // 방문 이력(뒤로/앞으로). 브레드크럼·[상위로]가 못 하는 것: 멀리 갔다가 **왔던 자리로** 돌아오기.
  const [hist, setHist] = useState(EMPTY_HISTORY)
  const [drives, setDrives] = useState<{ path: string; label: string }[]>([])
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
    // fromHist: 뒤로/앞으로로 온 이동. 이력에 다시 쌓지 않는다(쌓으면 뒤로가 제자리를 맴돈다).
    async (p: string, fromHist = false) => {
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
        // 폴더를 옮기면 검색어는 털어 낸다 — 이전 폴더의 검색어가 남으면 새 폴더가 비어 보인다.
        setFilter('')
        setFilterOn(false)
        // #92 의 "받았습니다" 줄도 함께 턴다(2026-08-16). 지우는 곳이 ✕ 버튼 하나뿐이라
        // 다른 폴더로 가도, 다른 서버로 갈아타도 남아서 **지금 위치와 무관한 파일**을 계속 가리켰다.
        //
        // 2026-08-17 정정: 조건 없이 지웠더니 **같은 폴더 새로고침에도** 지워졌다. 받기가 끝나면
        // 목록을 다시 읽는데, 그 새로고침이 방금 띄운 안내를 그 자리에서 도로 걷어 갔다
        // (SFTP-4 가 잡았다 — "어디 갔는지 알려 준다"가 통째로 죽어 있었다).
        // 지워야 하는 것은 **자리를 옮겼을 때**다. 제자리 새로고침은 옮긴 것이 아니다.
        if (res.path !== target.current) setGot(null)
        if (!fromHist) setHist((h) => pushHistory(h, res.path))
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
    setHist(EMPTY_HISTORY)
    if (!backend) {
      setEntries([])
      setError(null)
    }
  }, [backend])

  // #88 R2 드라이브 목록(내 PC). 로컬일 때만 한 번 읽는다 — 세션 중에 드라이브가 꽂히는 일은
  // 흔치 않고, 흔치 않은 것을 위해 폴링을 돌리지는 않는다([새로고침]이 다시 읽는 길이다).
  useEffect(() => {
    if (!backend || backend.remote) return setDrives([])
    void window.ev.fs.drives().then(setDrives)
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

  const refresh = useCallback(() => void load(path, true), [load, path])
  const goUp = useCallback(() => void load(parent), [load, parent])
  // 뒤로/앞으로 — 이력 위치만 옮기고 그 경로를 다시 읽는다(fromHist=true 라 이력이 늘지 않는다).
  // **setHist 의 updater 안에서 load 를 부르지 않는다**: updater 는 렌더 중에 실행되고
  // (StrictMode 에서는 두 번), 거기서 부작용을 내면 조용히 두 번 읽거나 아예 안 읽는다
  // (#91 CON-17 이 정확히 그 버그였다). 최신 값은 ref 로 읽는다.
  const histRef = useRef(hist)
  histRef.current = hist
  const goHist = useCallback(
    (delta: -1 | 1) => {
      const h = histRef.current
      const idx = h.idx + delta
      if (idx < 0 || idx >= h.stack.length) return
      histRef.current = { ...h, idx }
      setHist(histRef.current)
      void load(h.stack[idx], true)
    },
    [load]
  )

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

  // #88 R2: 화면에 실제로 나가는 목록. 선택·범위 선택·전체 선택이 전부 **이것**을 기준으로 돈다 —
  // 안 보이는 항목이 선택돼 있으면 [삭제]가 보이지 않는 파일을 지운다.
  const shown = useMemo(() => viewEntries(entries, { showHidden, sort, filter }), [entries, showHidden, sort, filter])

  // ── 선택 ──
  const clickRow = useCallback(
    (e: React.MouseEvent, idx: number) => {
      const name = shown[idx].name
      if (e.shiftKey && anchor !== null) {
        const [a, b] = anchor <= idx ? [anchor, idx] : [idx, anchor]
        setSel(shown.slice(a, b + 1).map((x) => x.name))
        return
      }
      setAnchor(idx)
      if (e.ctrlKey || e.metaKey) setSel((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]))
      else setSel([name])
    },
    [shown, anchor]
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

  const selectedEntries = useCallback(() => shown.filter((e) => sel.includes(e.name)), [shown, sel])

  // #92(2026-08-16): 받는 곳을 **묻지 않는다.** 대신 어디로 갔는지 알려 준다.
  //
  // 왜 바꿨나: 2026-08-09 에 "원격 → 우리는 다운로드(위치를 직접 고른다)"로 못 박은 것은
  // 붙여넣기가 **조용히** 떨어져 어디 갔는지 몰랐기 때문이다(explorerTransfer.ts 머리주석).
  // 막아야 했던 것은 "조용히"지 "빠른"이 아니다 — 브라우저처럼 정해진 곳에 받고 경로를 보여 주면
  // 그 문제가 없다. 방향 규칙(붙여넣기로는 안 받는다)은 그대로다. 받는 길은 여전히 하나다.
  //
  // 위치를 고르고 싶으면 우클릭 [다른 위치에 받기] — 아래 askWhere=true 가 예전 경로 그대로다.
  // andOpen: 받고 나서 **연결 프로그램으로 연다**(2026-08-22 준영님 제보 25번 — 원격 파일도
  // 로컬과 같은 손이 되게. "다운로드 경로에 다운로드되며 열리게" 하자는 준영님 안 그대로다).
  const download = useCallback(
    async (targets: FileEntry[], askWhere = false, andOpen = false) => {
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
              if (r.ok) {
                setGot({ name, localPath })
                // 더블클릭으로 온 길이면 여기서 연다. 실패(연결 프로그램 없음)는 삼키지 않는다 —
                // 받기는 됐는데 안 열린 것과 아무 일도 안 일어난 것은 다른 상황이다.
                if (andOpen) void window.ev.fs.openPath(localPath).then((o) => !o.ok && setError(o.message))
              }
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

  // #88 R2 새 파일. 로컬 전용 — SFTP 쪽에는 "빈 파일 만들기" 계약이 없고, 원격은 현행 유지다.
  const newFile = useCallback(async () => {
    const name = await askText({
      title: t('file.newFile.title'),
      message: t('file.newFile.msg'),
      input: { placeholder: t('file.newFile.ph') },
      confirmLabel: t('file.newFile'),
      cancelLabel: t('dlg.cancel')
    })
    if (!name) return
    applyOp(await window.ev.fs.newFile(path, name))
  }, [path, askText, applyOp])

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
        // 2026-08-16: 대상을 먼저 밝힌다. 예전엔 파일명과 개수뿐이라 **어느 서버 어느 폴더**의
        // 그 파일인지 알 수 없었다 — 원격은 영구 삭제이고, 하단과 작업대가 서로 다른 서버를
        // 볼 수 있는 구조라 더 그렇다.
        ...(backend.remote && session?.serverKey ? [{ label: t('conn.fail.server'), value: session.serverKey }] : []),
        { label: t('sftp.path.edit'), value: path },
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

  // ── Ctrl+C / Ctrl+V ── (준영님 제보: 드래그&드롭은 되는데 복사·붙여넣기가 안 된다)
  // 붙여넣기 우선순위: ① OS 클립보드에 파일이 있으면 드롭과 똑같이 처리한다(사용자 기대가 그것이다)
  //                    ② 없으면 앱 안에서 Ctrl+C 한 항목을 이 폴더로 복사한다.
  const copySelection = useCallback(
    (mode: 'copy' | 'cut' = 'copy') => {
      const entries = selectedEntries()
      if (entries.length === 0) return
      fileClip = { session, dir: path, entries, mode, at: Date.now() }
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
    },
    [selectedEntries, session, path]
  )

  const pasteHere = useCallback(async () => {
    const dir = target.current
    // 지난 결과를 먼저 지운다 — 같은 오류가 남아 있으면 다시 눌러도 화면이 안 바뀌어
    // "아무 반응 없다"로 읽힌다(2026-08-22 준영님 제보 26번).
    setError(null)
    const os = await window.ev.clipboard.readFiles().catch(() => ({ paths: [] as string[] }))
    const src = pasteSource(os.paths, osClipAtCopy, fileClip !== null)

    // ① OS 클립보드(윈도 탐색기에서 Ctrl+C 한 파일)
    if (src === 'os') {
      if (backend?.remote) return void uploadPaths(os.paths)
      const r = await window.ev.fs.copy(os.paths, dir)
      return applyOp(r)
    }
    // ② 앱 안에서 복사한 항목. 붙여넣을 것이 없으면 **그렇다고 말한다** — 예전엔 조용히 끝나
    // 눌렀는지도 알 수 없었다(제보 26번).
    if (src === 'none' || !fileClip) return setError(t('file.paste.empty'))
    // #88 R2 잘라내기. 로컬→로컬만 이동으로 처리한다 — 원격이 끼면 그건 전송이고, 반쯤 올라간 파일을
    // 원본 삭제로 갚을 수 없다. 사용자에게 "복사한 뒤 원본을 지우라"고 말하는 편이 정직하다.
    if (fileClip.mode === 'cut') {
      const clip = fileClip
      if (clip.session?.type === 'ssh' || backend?.remote) return setError(t('file.cut.localOnly'))
      const r = await window.ev.fs.move(clip.entries.map((e) => joinPath(clip.dir, e.name)), dir)
      // 붙여넣고 나면 클립보드를 비운다 — 이동은 한 번뿐이다(두 번째 붙여넣기는 원본이 없어 실패한다).
      if (r.ok) fileClip = null
      return applyOp(r)
    }
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

  // ── 우클릭 메뉴 ──
  const openMenu = useCallback(
    (e: React.MouseEvent, idx: number | null) => {
      e.preventDefault()
      e.stopPropagation()
      if (idx === null) setSel([])
      else if (!sel.includes(shown[idx].name)) {
        // 선택 밖의 행을 우클릭하면 그 행만 선택된다(탐색기 관례).
        setSel([shown[idx].name])
        setAnchor(idx)
      }
      setMenu({ x: e.clientX, y: e.clientY })
    },
    [sel, shown]
  )

  const onMenuPick = useCallback(
    (id: string) => {
      setMenu(null)
      const targets = selectedEntries()
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
        case 'file.terminal':
          onTerminalHere?.(path)
          return
        case 'file.askAi':
          // 경로만 넘긴다 — 내용을 통째로 싣지 않는다(#80 예산 · 무엇이 가는지 사용자가 본다).
          if (targets.length > 0) onAskAiPaths?.(targets.map((e) => joinPath(path, e.name)))
          return
        case 'file.aicli':
          // #88 R1: 폴더를 골랐으면 그 폴더, 아니면 **지금 보고 있는 폴더**([여기서 터미널]과 같은 규칙).
          onAiCli?.(targets[0] && targets[0].type === 'dir' ? joinPath(path, targets[0].name) : path)
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
        // ── #88 R2 ──
        case 'file.newFile':
          void newFile()
          return
        case 'file.cut':
          copySelection('cut')
          return
        case 'file.copy':
          copySelection()
          return
        case 'file.paste':
          void pasteHere()
          return
        case 'file.sort.name':
          return setSort((s) => nextSort(s, 'name'))
        case 'file.sort.ext':
          return setSort((s) => nextSort(s, 'ext'))
        case 'file.sort.size':
          return setSort((s) => nextSort(s, 'size'))
        case 'file.sort.mtime':
          return setSort((s) => nextSort(s, 'mtime'))
        case 'file.hidden':
          return setShowHidden((v) => !v)
        case 'file.reveal':
          // #88 R3: 압축·속성·보안 탭은 따라 그리지 않는다. 진짜 탐색기로 넘긴다 —
          // 고른 게 있으면 그것을, 없으면 지금 폴더를 연다.
          void window.ev.fs.reveal(targets[0] ? joinPath(path, targets[0].name) : path)
          return
        case 'file.view':
          return // 서브메뉴만 여는 항목 — 여기로 오지 않는다
        case 'file.delete':
          void removeSelected()
          return
      }
    },
    [
      selectedEntries,
      enterDir,
      download,
      newFolder,
      newFile,
      removeSelected,
      copySelection,
      pasteHere,
      onTailFile,
      onSaveWork,
      onAiCli,
      onTerminalHere,
      onAskAiPaths,
      path,
      backend,
      session
    ]
  )


  // 트리에 포커스가 있을 때만 잡는다(터미널·검색창의 Ctrl+C 를 가로채면 안 된다).
  // Ctrl+V 는 여기서 잡지 않는다 — 가로채면 브라우저 paste 이벤트가 오지 않아 Windows 에서
  // 파일이 하나만 잡힌다(A-3). 아래 registerPasteTarget 이 진짜 paste 에서 받는다.
  const onTreeKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
      const k = e.key.toLowerCase()
      // #88 R2: 잘라내기(Ctrl+X)·전체 선택(Ctrl+A). Ctrl+A 는 **보이는 것만** 고른다 —
      // 숨김·검색으로 걸러진 항목까지 고르면 [삭제]가 화면에 없는 파일을 지운다.
      if (k === 'x') {
        if (backend?.remote) return // 원격 잘라내기는 없다(현행 유지) — 조용히 아무 일도 안 한다
        e.preventDefault()
        e.stopPropagation()
        return copySelection('cut')
      }
      if (k === 'a') {
        e.preventDefault()
        e.stopPropagation()
        return setSel(shown.map((x) => x.name))
      }
      if (k !== 'c') return
      e.preventDefault()
      e.stopPropagation()
      copySelection()
    },
    [copySelection, backend, shown]
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
      // **파일 드래그만 받는다** (2026-08-22 준영님 제보 19번: "탭 드래그하여 좌측 사이드바에
      // 가져가면 왜 영역이 잡혀?"). 탭 드래그는 `text/plain` 에 세션 id 를 싣는데, 여기서
      // preventDefault 를 무조건 부르면 그것도 "여기에 놓을 수 있다"로 보인다.
      // OS 파일 드롭은 `Files` 타입이 붙는다 — 그것만 받으면 탭은 지나간다.
      if (!e.dataTransfer.types.includes('Files')) return
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
  // #88 R2 상태 표시줄 · 드라이브. 숨겨진 개수는 **감춘 만큼만** 센다(검색으로 걸러진 것은 별도 문구다).
  const hiddenCount = showHidden ? 0 : entries.length - entries.filter((e) => !e.name.startsWith('.')).length
  const selBytes = selectedEntries().reduce((n, e) => n + (e.type === 'dir' ? 0 : e.size), 0)
  const curDrive = drives.find((d) => path.toUpperCase().startsWith(d.path.toUpperCase()))?.path ?? ''

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
        {/* #88 R2 뒤로/앞으로 — 브레드크럼·[상위로]가 못 하는 것 하나를 맡는다: 멀리 갔다가
            **왔던 자리로** 돌아오기. 갈 곳이 없으면 비활성이라 눌러 보고 알 필요가 없다.
            **작업대에만 있다**: 이 줄에 아이콘을 더 얹었더니 사이드바(280px)에서 브레드크럼이
            눌리지 않을 만큼 짓눌렸다(FILE-4 가 "path-bar 가 클릭을 가로챈다"로 잡았다).
            자리를 차지하는 탐색 도구는 넓은 쪽에, 자리를 안 쓰는 규칙(정렬·숨김·상태 표시줄)은
            양쪽에 — design-system §4.8 의 모양 기준을 그대로 적용한 것이다. */}
        {toolbar && (
          <>
            <button
              type="button"
              className="sb-act"
              data-action="hist.back"
              title={t('file.back')}
              disabled={hist.idx <= 0}
              onClick={() => goHist(-1)}
            >
              <IconBack />
            </button>
            <button
              type="button"
              className="sb-act"
              data-action="hist.fwd"
              title={t('file.forward')}
              disabled={hist.idx < 0 || hist.idx >= hist.stack.length - 1}
              onClick={() => goHist(1)}
            >
              <IconForward />
            </button>
          </>
        )}
        <div className="sb-act" title={t('sftp.up')} onClick={goUp}>
          <IconUp />
        </div>
        {/* #88 R2 이름 검색 — **이 폴더 안**만 훑는다(하위 폴더까지 뒤지는 검색은 [윈도우 탐색기에서
            보기]로 넘긴다). 아이콘을 누르면 입력이 펴지고, 폴더를 옮기면 저절로 접힌다. */}
        {toolbar && filterOn && (
          <input
            className="ffil"
            data-field="filter"
            autoFocus
            spellCheck={false}
            placeholder={t('file.filter.ph')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilter('')
                setFilterOn(false)
              }
              e.stopPropagation()
            }}
          />
        )}
        {toolbar && (
          <div
            className={'sb-act' + (filterOn ? ' on' : '')}
            data-action="file.filter"
            title={t('file.filter')}
            onClick={() => {
              if (filterOn) setFilter('')
              setFilterOn((v) => !v)
            }}
          >
            <IconSearch />
          </div>
        )}
        {/* 드라이브(내 PC). 로컬에만 있다 — 원격은 루트 하나뿐이라 고를 것이 없다. */}
        {toolbar && !backend.remote && drives.length > 0 && (
          <select
            className="fdrv"
            data-field="drive"
            title={t('file.drive')}
            value={curDrive}
            onChange={(e) => void load(e.target.value)}
          >
            {/* 현재 위치가 어느 드라이브에도 안 걸리면(네트워크 경로 등) 빈 칸을 보여 준다 —
                없는 값으로 select 를 두면 브라우저가 멋대로 첫 항목을 고른 것처럼 그린다. */}
            {curDrive === '' && <option value="" />}
            {drives.map((d) => (
              <option key={d.path} value={d.path}>
                {d.label}
              </option>
            ))}
          </select>
        )}
        {backend.remote && (
          <div className="sb-act" title={t('sftp.upload')} onClick={pickAndUpload}>
            <IconUpload />
          </div>
        )}
        {/* 2026-08-24 준영님: 자동 동기 안내가 **줄 하나를 상주로 잡아먹고** 있었다.
            한 번 읽으면 그만인 글이라 새로고침 옆 물음표 뒤로 넣는다(하단 표들과 같은 방식).
            안내가 필요한 상태(cwd 이벤트를 한 번도 못 받은 원격 셸)에서만 나타난다. */}
        {backend.remote && !autoSynced && <HelpTip text={t('sftp.bestEffort')} />}
        <div className="sb-act" title={t('sftp.refresh')} onClick={refresh}>
          <IconRefresh />
        </div>
      </div>

      {/* 경로는 **자기 줄**을 갖는다 (2026-08-22 준영님 제보 12번 — "하나의 바에 뒤로가기·경로 수정·
          경로·파일올리기·새로고침 등 많은 기능이 한 줄에 있음. 경로만 하단에 새로운 바에 넣어주고
          클릭하면 수정할 수 있는 줄 알게 인풋창 형식처럼 보여줘야 함. 그래서 경로 수정 버튼 제거").

          [경로 수정] 연필 버튼이 사라진 자리를 **줄 자체**가 대신한다: 칸처럼 생겼으니 눌러서 고치는
          것임이 보이고, 빈 자리 아무 데나 눌러도 편집이 된다. 예전엔 이 줄이 아이콘들과 한 칸을
          나눠 쓰느라 direction:rtl 이었고 "남는 자리가 왼쪽에 생겨 누를 곳이 안 보인다"는 이유로
          빈자리 클릭을 못 썼는데, 줄을 나누면서 그 제약이 사라졌다.
          세그먼트 클릭(상위로 한 번에)은 그대로다 — 클릭이 겹치지 않게 세그먼트가 먼저 먹는다. */}
      <div className="fpath-row">
        {pathEdit === null ? (
          <div
            className="fpath-box"
            data-action="path.edit"
            title={t('sftp.path.edit')}
            role="button"
            tabIndex={0}
            onClick={() => setPathEdit(path)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setPathEdit(path)
              }
            }}
          >
            {/* 넘치면 끝(현재 폴더)이 보이게 스크롤을 오른쪽 끝으로 — direction:rtl 로 하던 일을
                여기서 한다(제보 5번: 짧은 경로가 오른쪽에 붙어 보이던 것). */}
            <div className="fcrumb" title={path} ref={crumbRef}>
              {crumbList.map((c, i) => (
                <span key={c.path}>
                  {i > 0 && <span className="sepr">/</span>}
                  <span
                    className="seg"
                    onClick={(e) => {
                      e.stopPropagation() // 세그먼트는 "이동"이다 — 줄의 "편집"으로 새지 않게
                      void load(c.path)
                    }}
                  >
                    {c.label}
                  </span>
                </span>
              ))}
            </div>
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
      </div>

      {toolbar && (
        <div className="ftool">
          <button type="button" className="ftb" title={t('conn.menu.file.mkdir')} onClick={() => void newFolder()}>
            <IconFolderPlus />
            <span>{t('conn.menu.file.mkdir')}</span>
          </button>
          {!backend.remote && (
            <button type="button" className="ftb" title={t('file.newFile')} onClick={() => void newFile()}>
              <IconFilePlus />
              <span>{t('file.newFile')}</span>
            </button>
          )}
          <span className="ftsep" />
          <button type="button" className="ftb" disabled={sel.length === 0} title={t('file.copy')} onClick={() => copySelection()}>
            <IconCopy />
            <span>{t('file.copy')}</span>
          </button>
          {!backend.remote && (
            <button type="button" className="ftb" disabled={sel.length === 0} title={t('file.cut')} onClick={() => copySelection('cut')}>
              <IconCut />
              <span>{t('file.cut')}</span>
            </button>
          )}
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
      {/* 2026-08-22 준영님 제보 9번: "좌측 사이드바도 클릭하면 뭔가 시각적으로 선택됬다는 걸
          보여줘야 해." 붙여넣기 대상은 사실 **지금 보고 있는 폴더**라 빈 공간을 고를 필요가
          없는데, 그게 보이지 않아 빈자리를 찾아 클릭하고 계셨다(파일이 많으면 빈자리도 없다).
          클릭하면 포커스가 여기로 오고 테두리가 서서 "이 목록이 지금 대상"임을 말한다.
          빈 자리를 눌렀을 때만 선택을 비운다 — 행 클릭은 그 행이 처리한다. */}
      <div
        className="ftree"
        ref={listRef}
        role="listbox"
        aria-label={t('sidebar.tab.file')}
        {...listKeys}
        onMouseDown={(e) => {
          // preventScroll 이 없으면 **목록이 맨 위로 튄다**(2026-08-23 준영님 제보 3번).
          // 스크롤되는 요소에 focus() 를 걸면 브라우저가 "포커스 대상을 보이게" 하려고 스크롤을
          // 그 요소의 시작(=맨 위)으로 되돌린다 — 정작 눌린 행은 이미 화면 안에 있었다.
          e.currentTarget.focus({ preventScroll: true })
          if (e.target === e.currentTarget) setSel([])
        }}
        onContextMenu={(e) => openMenu(e, null)}
      >
        {loading && <div className="sftp-empty">{t('sftp.loading')}</div>}
        {!loading && shown.length === 0 && !error && <div className="sftp-empty">{t('sftp.empty')}</div>}
        {!loading &&
          shown.map((entry, idx) => {
            // 링크는 대상 종류로 동작한다: 폴더 링크는 더블클릭하면 그 대상 폴더로 들어간다
            // (경로는 서버가 realpath 로 풀어 주므로 브레드크럼도 실제 경로가 된다).
            // 끊긴 링크는 들어갈 데가 없으니 안내만 한다.
            const kind = rowKind(entry)
            const isDir = kind === 'dir' || kind === 'linkDir'
            const icon = rowIcon(kind, entry.name)
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
                // 더블클릭 = **연다**(2026-08-22 준영님 제보 25번). 로컬은 연결 프로그램으로 바로,
                // 원격은 다운로드 폴더에 받은 뒤 같은 방식으로 연다(준영님이 통일성을 이유로 고른 안).
                // 그전에 로컬 더블클릭은 `download()` 를 불렀는데 그 함수는 원격 전용이라 첫 줄에서
                // 되돌아왔다 — **로컬에서는 더블클릭이 아무 일도 안 했다.**
                onDoubleClick={() => {
                  if (kind === 'broken') return setError(t('file.brokenLink'))
                  if (isDir) return enterDir(entry.name)
                  if (backend.remote) return void download([entry], false, true)
                  void window.ev.fs.openPath(joinPath(path, entry.name)).then((r) => !r.ok && setError(r.message))
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

      {/* #88 R2 상태 표시줄 — 탐색기 아래줄과 같은 자리, 같은 내용. 검색·숨김으로 목록이 줄면
          **왜 줄었는지**를 여기서 말한다(안 그러면 파일이 사라진 것으로 보인다). */}
      <div className="fstat">
        <span>{t('file.stat.items').replace('{n}', String(shown.length))}</span>
        {hiddenCount > 0 && <span className="fs-dim">{t('file.stat.hidden').replace('{n}', String(hiddenCount))}</span>}
        {filter.trim() !== '' && <span className="fs-dim">{t('file.stat.filtered').replace('{q}', filter.trim())}</span>}
        <span className="fs-gap" />
        {sel.length > 0 && (
          <span>{t('file.stat.sel').replace('{n}', String(sel.length)).replace('{s}', humanSize(selBytes))}</span>
        )}
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
            // #90 부터 로컬에도 붙는다(내 PC 에서도 AI CLI 를 시작할 수 있다).
            canAiCli: Boolean(onAiCli),
            canTerminal: Boolean(onTerminalHere),
            canAskAi: Boolean(onAskAiPaths),
            // #88 R2·R3: 잘라내기·새 파일·[윈도우 탐색기에서 보기]는 로컬만. 원격은 현행 유지.
            local: !backend.remote,
            sort,
            showHidden
          })
        ]}
        onPick={onMenuPick}
        onClose={() => setMenu(null)}
      />
    </div>
  )
}
