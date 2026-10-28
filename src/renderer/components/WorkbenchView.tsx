// 서버 작업대 (#91, 2026-08-16) — 옛 [파일 탐색기] 창과 [서버 콘솔] 런치패드를 하나로 합친 창.
//
// 준영님 관찰(2026-08-16): "이 독립적인 런치패드와 파일 탐색기를 융합한다면 어떨까? 둘다
// 독립적이고 좌측에 서버정보 나오고." 실제로 두 창의 구조가 같았고, 콘솔 쪽에는 이미 [파일]
// 도구까지 있었다(부분 융합이 진행돼 있던 셈이다).
//
// 목업 `mockups/workbench-fusion.html` 에서 **B안** 확정:
//   좌측 = 대상 하나(내 PC · 접속 중 · 저장된 서버) · 상단 = 그 대상의 도구 탭 · 본문 = 도구.
//
// ## 위치 탭을 버렸다 — 그래도 복사는 산다
// 옛 탐색기는 탭 하나가 위치 하나였다(서버 둘을 나란히 두고 복사). 준영님 확인: "서버 두 대를
// 동시에 여는 일이 실제로 엄청 많지는 않을것 같아. 하지만 서버와 로컬은 파일이 왔다갔다할일은 많아."
// 잃는 것은 **나란히 보기**뿐이다 — 앱 안 파일 클립보드(`fileClip`)가 모듈 스코프라
// "여기서 복사 → 좌측에서 대상 바꾸기 → 붙여넣기"는 그대로 된다(FileTree.tsx 머리주석).
// 로컬↔서버 왕래는 윈도우 탐색기와 같이 띄워서 한다(드롭 업로드 · 더블클릭 받기 #92).
//
// ## [홈] 은 격자다
// 준영님이 원하신 "카드 형식의 런치패드"가 이 자리다. 도구를 고르면 그 탭이 열리고, [홈] 은
// 첫 자리에 남는다 — 돌아갈 곳이 없어지면 안 된다(#69 가 세운 규칙).
//
// ## 창 안에서 여는 것과 밖에서 여는 것
// 표를 창 안에도 그리고 하단에도 그리는 것이 중복 아니냐 — 맥락이 다르다.
// **하단은 지금 붙어 있는 세션의 서버**(세션 탭이 정한다), **여기는 아무 서버나**(접속 안 한 것도).
// 다만 포트·시스템은 활성 세션 telemetry 구독에 매여 있어 여기서 다시 구독하지 않는다 —
// 그 둘과 [터미널] 은 ↗ 를 달아 밖에서 열린다고 미리 알린다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Boxes,
  Ship,
  FolderOpen,
  Gauge,
  HardDrive,
  Monitor,
  Network,
  Package,
  Server,
  Star,
  TerminalSquare
} from 'lucide-react'
import type { ConnectionProfile, WorkProfile } from '@shared/types'
import type { Session } from '../store/sessions'
import { FileTree, type ActiveFileSession } from './FileTree'
import { ServerTool, type ServerToolId } from './ServerTool'
import { ServerOverview } from './ServerOverview'
import { IconClose } from './icons'
import { TitleBar } from './TitleBar'
import type { DialogSpec, DialogResult } from './Dialog'
import { LOCAL_TARGET, sameTarget, type ExpTarget } from '../store/explorerTabs'
import { t } from '../i18n'
import { ContextMenu } from '../interactions/ContextMenu'
import { treeMenu, type TreeActionId } from '../interactions/actions'

// FileTree 계약상 session:null 은 "백엔드 없음"(플레이스홀더)이지 로컬을 뜻하지 않는다 — 로컬을
// 보려면 항상 이 sentinel 을 넘긴다(backendFor 가 type 으로만 분기한다).
const LOCAL_SESSION: ActiveFileSession = { id: 'local', type: 'local' }

/** 창 **안**에서 열리는 도구. 'files' 말고는 전부 원격 전용이다. */
type WbToolId = 'files' | ServerToolId
/** 창 **밖**에서 열리는 칸 — 하단 패널(포트·시스템) 또는 새 세션. ↗ 로 미리 알린다. */
type WbLaunchId = 'port' | 'sys' | 'term'

type Card = { id: WbToolId | WbLaunchId; Icon: typeof Activity; ext: boolean; localToo: boolean }

// 격자 순서는 쓰임새 순. localToo=false 인 칸은 [내 PC] 를 고르면 아예 나오지 않는다 —
// 내 PC 에 원격 프로세스·서비스는 없다. **흐리게 남기지 않는다**: 대상이 다르면 할 수 있는 일이
// 다른 것이 자연스럽고, 회색 칸 다섯을 늘 띄워 두는 쪽이 오히려 이상하다(#91 설계 판단).
const CARDS: readonly Card[] = [
  { id: 'files', Icon: FolderOpen, ext: false, localToo: true },
  { id: 'ps', Icon: Activity, ext: false, localToo: false },
  { id: 'svc', Icon: Server, ext: false, localToo: false },
  { id: 'disk', Icon: HardDrive, ext: false, localToo: false },
  { id: 'pkg', Icon: Package, ext: false, localToo: false },
  { id: 'ctr', Icon: Boxes, ext: false, localToo: false },
  // 2026-08-24: 쿠버는 컨테이너와 다른 칸이다(한 서버에 둘 다 깔릴 수 있다).
  { id: 'k8s', Icon: Ship, ext: false, localToo: false },
  { id: 'port', Icon: Network, ext: true, localToo: false },
  { id: 'sys', Icon: Gauge, ext: true, localToo: true },
  { id: 'term', Icon: TerminalSquare, ext: true, localToo: true }
]

const isTool = (id: WbToolId | WbLaunchId): id is WbToolId => !CARDS.find((c) => c.id === id)?.ext

// 2026-10-28: 본창 안 떠 있는 창(.exp-win)이 아니라 **진짜 OS 창**에 산다(ExplorerWindow.tsx).
// 그래서 창 껍데기(끌기·최대화·닫기)는 여기 없다 — 머리는 본창과 같은 TitleBar, 나머지는 OS 가 쥔다.
// 아래 콜백은 그 창이 main 을 거쳐 본창(Shell)으로 올려 보낸다(shared/explorerWin.ts 의 ExplorerAct).
type Props = {
  /** 창이 보이는가. 숨은 창(× = 숨김)에서는 어떤 도구도 원격에 명령을 보내지 않는다. */
  visible?: boolean
  sessions: Session[]
  profiles: ConnectionProfile[]
  workProfiles: WorkProfile[]
  /** 프로필로 접속. 새 세션은 sessions 목록으로 돌아온다. */
  onConnect: (profileId: string) => void
  ask: (spec: DialogSpec) => Promise<DialogResult>
  askText: (spec: DialogSpec & { input: NonNullable<DialogSpec['input']> }) => Promise<string | null>
  onAskAi: (text: string) => void
  /** 지금 세션 터미널로 한 줄(컨테이너 접속처럼 대화형인 것만). */
  onSendInput: (text: string) => void
  /** ↗ 칸 — 하단 패널의 그 탭을 열거나 새 세션을 만든다. cwd 는 [여기서 터미널]이 넘긴다. */
  onLaunch: (id: WbLaunchId, profileId: string | null, cwd?: string) => void
  /** #88 R1: 그 폴더가 채워진 AI CLI 시작 창(#90 부터 내 PC 도 대상이 된다). */
  onAiCli: (profileId: string | null, path: string) => void
  /**
   * [작업 프로필로 저장] — 즐겨찾기 목록의 주인은 Shell 이라 여기서 만들지 않고 올려보낸다
   * (사이드바 트리의 같은 메뉴와 **같은 함수**에 도착해야 한다).
   * 대상을 함께 넘기는 이유: 이 창은 활성 터미널과 다른 서버를 보고 있을 수 있다.
   */
  onSaveWork: (profileId: string | null, path: string) => void
  /** 바깥에서 건네는 "이 서버의 이 폴더를 열어라". at 이 바뀔 때만 한 번 반응한다. */
  reveal?: { profileId: string; path: string; at: number } | null
  /**
   * 2026-08-17 제보 ①: 즐겨찾기 행 우클릭(이름 변경·삭제). 목록의 주인은 Shell 이라 여기서
   * 고치지 않고 올려보낸다 — 사이드바 트리의 같은 메뉴와 **같은 함수**에 도착해야 한다.
   * ([열기]는 올리지 않는다. 이 창에서 연 것은 이 창 안에서 열려야 한다.)
   */
  onWorkAction?: (id: TreeActionId, workId: string) => void
}

export function WorkbenchView({
  visible = true,
  sessions,
  profiles,
  workProfiles,
  onConnect,
  ask,
  askText,
  onAskAi,
  onSendInput,
  onLaunch,
  onAiCli,
  onSaveWork,
  reveal,
  onWorkAction
}: Props): JSX.Element {
  // 좌측이 정하는 대상 하나(B안). 옛 위치 탭을 대신한다.
  const [target, setTarget] = useState<ExpTarget>(LOCAL_TARGET)
  // 열어 둔 도구. [홈](격자)은 목록에 없고 항상 맨 앞이며 닫을 수 없다.
  const [tools, setTools] = useState<WbToolId[]>([])
  const [active, setActive] = useState<'home' | WbToolId>('home')
  // 즐겨찾기·reveal 이 준 시작 폴더. 한 번 쓰고 나면 FileTree 가 자기 경로를 갖는다.
  const [goto, setGoto] = useState<string | null>(null)
  // 즐겨찾기 행 우클릭 위치(제보 ①). 사이드바 트리와 **같은 메뉴 정의**를 쓴다.
  const [favMenu, setFavMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  // 아직 접속 중인 프로필 — 세션이 뜨면 그 대상으로 넘어간다.
  const pending = useRef<{ profileId: string; goto?: string } | null>(null)

  const sshProfiles = useMemo(
    () => profiles.filter((p): p is Extract<ConnectionProfile, { type: 'ssh' }> => p.type === 'ssh'),
    [profiles]
  )

  // 프로필 → 살아 있는 SSH 세션(있으면). 파일 탐색은 세션 하나면 되므로 가장 최근 것을 쓴다.
  const sessionOf = useCallback(
    (profileId: string): Session | undefined => {
      let found: Session | undefined
      for (const s of sessions) if (s.type === 'ssh' && s.profileId === profileId) found = s
      return found
    },
    [sessions]
  )

  // 지금 대상 — setState updater 안에서 비교하면 **렌더 중 부수효과**가 된다(updater 가 두 번
  // 불릴 수 있고 그 안의 setTools/setActive 가 뒤엉킨다. 실제로 [탐색기로 열기]가 파일 탭을
  // 열지 못했다 — e2e CON-17 이 잡았다). 비교용 값은 ref 로 따로 들고 간다.
  const targetRef = useRef(target)
  targetRef.current = target

  // 대상을 바꾸면 도구를 접고 [홈] 으로 돌아간다 — dev 의 프로세스 탭이 db-01 을 고른 뒤에도
  // 열려 있으면 어느 서버 것인지 헷갈린다(제목줄 하나로 두 대를 가리킬 수 없다).
  const pick = useCallback((next: ExpTarget, startAt?: string) => {
    const changed = !sameTarget(targetRef.current, next)
    targetRef.current = next
    setTarget(next)
    if (changed) {
      setTools([])
      setActive('home')
    }
    setGoto(startAt ?? null)
    // 폴더를 지정해 들어왔으면 파일을 바로 연다 — 즐겨찾기·[탐색기로 열기]의 뜻이 그것이다.
    // 위에서 비운 직후라도 setState 는 순서대로 쌓여 결과는 ['files'] 다.
    if (startAt !== undefined) {
      setTools((cur) => (cur.includes('files') ? cur : [...cur, 'files']))
      setActive('files')
    }
  }, [])

  // 서버 고르기: 세션이 있으면 바로, 없으면 접속을 걸어 두고 세션이 뜨면 넘어간다.
  const pickServer = useCallback(
    (p: { id: string; name: string }, startAt?: string) => {
      if (sessionOf(p.id)) return pick({ kind: 'ssh', profileId: p.id }, startAt)
      pending.current = { profileId: p.id, goto: startAt }
      onConnect(p.id)
    },
    [sessionOf, pick, onConnect]
  )

  useEffect(() => {
    const want = pending.current
    if (!want) return
    if (!sessionOf(want.profileId)) return
    pending.current = null
    pick({ kind: 'ssh', profileId: want.profileId }, want.goto)
  }, [sessions, sessionOf, pick])

  // at 을 기억해 두는 이유: 세션 목록이 바뀔 때마다 이 효과가 다시 도는데, 그때마다 열면
  // 사용자가 옮겨 간 폴더를 도로 끌어당긴다.
  const revealedAt = useRef(0)
  useEffect(() => {
    if (!reveal || reveal.at === revealedAt.current) return
    revealedAt.current = reveal.at
    const p = profiles.find((x) => x.id === reveal.profileId)
    if (p) pickServer({ id: p.id, name: p.name }, reveal.path)
  }, [reveal, profiles, pickServer])

  // 즐겨찾기(작업 프로필) — 서버+폴더를 한 번에. profileId 가 없으면 로컬 폴더다.
  const openWork = useCallback(
    (w: WorkProfile) => {
      if (!w.profileId) return pick(LOCAL_TARGET, w.path)
      const p = profiles.find((x) => x.id === w.profileId)
      if (p) pickServer({ id: p.id, name: p.name }, w.path)
    },
    [pick, pickServer, profiles]
  )

  const isLocal = target.kind === 'local'
  const session = isLocal ? undefined : sessionOf(target.profileId)
  const sessionId = session?.id ?? null
  const fileSession: ActiveFileSession = isLocal
    ? LOCAL_SESSION
    : // 세션이 닫혔으면 백엔드 없음 — FileTree 가 안내를 띄운다(대상은 남겨 둔다).
      session
      ? { id: session.id, type: 'ssh' as const, serverKey: session.serverKey }
      : null
  const targetName = isLocal
    ? t('explorer.nav.thisPc')
    : (profiles.find((p) => p.id === target.profileId)?.name ?? '')

  const openTool = (id: WbToolId): void => {
    setTools((cur) => (cur.includes(id) ? cur : [...cur, id]))
    setActive(id)
  }
  const closeTool = (id: WbToolId): void => {
    setTools((cur) => cur.filter((x) => x !== id))
    // 보고 있던 것을 닫으면 [홈] 으로 — 돌아갈 곳은 늘 거기다.
    setActive((cur) => (cur === id ? 'home' : cur))
  }

  const cards = CARDS.filter((c) => c.localToo || !isLocal)
  // 보고 있는 도구만 활성이다 — 숨은 탭이 원격에 명령을 보내면 안 된다.
  const shown = (id: WbToolId): boolean => visible && active === id

  // 어느 대상을 만지고 있는지가 늘 보여야 한다 — 창 하나가 여러 서버를 오간다.
  // 작업표시줄·Alt+Tab 에도 같은 문구가 뜨게 document.title 도 맞춘다.
  const winTitle = `${t('wb.title')} — ${targetName}`
  useEffect(() => {
    document.title = winTitle
  }, [winTitle])

  return (
    <>
    <TitleBar title={winTitle} />
    <div className="wb-win" aria-label={t('wb.title')}>
      <div className="exp-tabs">
        <div
          className={'exp-tab' + (active === 'home' ? ' on' : '')}
          data-tab="home"
          onClick={() => setActive('home')}
        >
          <span className="exp-tab-nm">{t('wb.home')}</span>
        </div>
        {tools.map((id) => (
          <div
            key={id}
            className={'exp-tab' + (active === id ? ' on' : '')}
            data-tab={id}
            onClick={() => setActive(id)}
          >
            <span className="exp-tab-nm">{t('console.tool.' + id)}</span>
            <span
              className="exp-tab-x"
              title={t('explorer.tab.close')}
              onClick={(e) => {
                e.stopPropagation()
                closeTool(id)
              }}
            >
              <IconClose />
            </span>
          </div>
        ))}
      </div>

      <div className="exp-body">
        <div className="exp-nav">
          {workProfiles.length > 0 && <div className="exp-grp">{t('explorer.nav.favorites')}</div>}
          {workProfiles.map((w) => (
            <div
              key={w.id}
              className="exp-node"
              title={w.path}
              onClick={() => openWork(w)}
              onContextMenu={(e) => {
                e.preventDefault()
                setFavMenu({ x: e.clientX, y: e.clientY, id: w.id })
              }}
            >
              {/* 이 셋(즐겨찾기·내 PC·서버)은 **한 목록 안에 나란히** 선다 — 하나만 글리프로
                  남으면 그 줄만 굵기가 다르다. 크기·정렬은 `.exp-node .ic`(15px 칸 + place-items)가 정한다. */}
              <span className="ic">
                <Star />
              </span>
              <span className="nm">{w.name}</span>
            </div>
          ))}

          <div className="exp-grp">{t('explorer.nav.thisPc')}</div>
          <div className={'exp-node' + (isLocal ? ' on' : '')} onClick={() => pick(LOCAL_TARGET)}>
            {/* 🖴(U+1F5B4)는 번들 폰트에 없어 OS 이모지로 폴백하던 자리다. HardDrive 는 [디스크]
                도구 카드가 이미 쓰고 있어 쓰지 않는다 — 같은 그림이 두 뜻이면 둘 다 안 읽힌다. */}
            <span className="ic">
              <Monitor />
            </span>
            <span className="nm">{t('explorer.nav.home')}</span>
          </div>

          <div className="exp-grp">{t('explorer.nav.servers')}</div>
          {sshProfiles.length === 0 && <div className="exp-none">{t('explorer.nav.noServers')}</div>}
          {sshProfiles.map((p) => {
            const live = Boolean(sessionOf(p.id))
            const on = !isLocal && target.profileId === p.id
            return (
              <div
                key={p.id}
                className={'exp-node' + (on ? ' on' : '')}
                data-server={p.id}
                title={`${p.username}@${p.host}${live ? '' : ' · ' + t('explorer.nav.willConnect')}`}
                onClick={() => pickServer(p)}
              >
                {/* 🖧(U+1F5E7)도 번들 폰트 밖이다. */}
                <span className="ic">
                  <Server />
                </span>
                <span className="nm">{p.name}</span>
                <span className={'exp-dot' + (live ? ' live' : '')} />
              </div>
            )
          })}
        </div>

        <div className="exp-main">
          {/* [홈] — 카드 격자. 준영님이 말씀하신 "카드 형식의 런치패드"가 이 자리다. */}
          <div className="con-pad wb-pad" style={active === 'home' ? undefined : { display: 'none' }}>
            {!isLocal && <ServerOverview sessionId={sessionId} active={visible && active === 'home'} />}
            {cards.map(({ id, Icon, ext }) => (
              <button
                key={id}
                type="button"
                className={'con-app' + (ext ? ' ext' : '')}
                data-tool={id}
                title={ext ? t('console.ext.hint') : undefined}
                onClick={() =>
                  isTool(id) ? openTool(id) : onLaunch(id as WbLaunchId, isLocal ? null : target.profileId)
                }
              >
                <span className="ic">
                  <Icon />
                </span>
                <span className="nm">{t('console.tool.' + id)}</span>
                <span className="sm">{t('console.tool.' + id + '.sub')}</span>
                {ext && (
                  <span className="ext-mark" aria-label={t('console.ext.hint')}>
                    ↗
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* 열어 둔 도구는 마운트를 유지한다(검색어·정렬·경로를 잊지 않게).
              숨은 것은 active=false 라 원격에 명령을 보내지 않는다. */}
          {tools.map((id) => (
            <div key={id} className="exp-pane" style={active === id ? undefined : { display: 'none' }}>
              {id === 'files' ? (
                <FileTree
                  session={fileSession}
                  active={shown(id)}
                  cwd={goto}
                  ask={ask}
                  askText={askText}
                  toolbar
                  // #88 R1 아라 연결점 — 탐색기에 없는 것들이다(준영님: "차이점은 우리 아라와
                  // 연결된다는 점"). 대상이 로컬이든 서버든 같은 자리에서 이어진다.
                  onTerminalHere={(p) => onLaunch('term', isLocal ? null : target.profileId, p)}
                  onAiCli={(p) => onAiCli(isLocal ? null : target.profileId, p)}
                  onSaveWork={(p) => onSaveWork(isLocal ? null : target.profileId, p)}
                  onAskAiPaths={(paths) => onAskAi(paths.join('\n'))}
                />
              ) : (
                <ServerTool
                  id={id}
                  active={shown(id)}
                  sessionId={sessionId}
                  isSsh={!isLocal && sessionId !== null}
                  server={session?.serverKey}
                  ask={ask}
                  onAskAi={onAskAi}
                  onOpenExplorer={(path) => pick(target, path)}
                  onSendInput={onSendInput}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 제보 ①: 즐겨찾기 우클릭. [열기]는 여기서, 이름 변경·삭제는 목록 주인(Shell)에게. */}
      <ContextMenu
        open={favMenu !== null}
        x={favMenu?.x ?? 0}
        y={favMenu?.y ?? 0}
        items={treeMenu('fav')}
        onPick={(id) => {
          const m = favMenu
          setFavMenu(null)
          if (!m) return
          const w = workProfiles.find((x) => x.id === m.id)
          if (id === 'work.goto') {
            if (w) openWork(w)
            return
          }
          onWorkAction?.(id as TreeActionId, m.id)
        }}
        onClose={() => setFavMenu(null)}
      />
    </div>
    </>
  )
}
