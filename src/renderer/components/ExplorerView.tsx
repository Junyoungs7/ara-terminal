// 파일 탐색기 창 — 준영님이 고른 E1(정통 탐색기형) + 탭.
//
// 왜 이렇게 생겼나:
//  · **떠 있는 창**이다(전체를 덮지 않는다). 터미널을 보면서 파일을 만지는 게 이 기능의 쓰임이라
//    앱을 가려 버리면 창을 닫았다 열었다 하게 된다. 뒤쪽은 그대로 클릭된다(모달 아님).
//  · **탭 = 위치 하나**. 서버를 여러 개 열어 두고 오가며 복사·붙여넣기 한다(준영님 요구).
//  · **좌측 탐색 창**에 즐겨찾기(작업 프로필)·내 PC·서버 목록. 서버는 **접속 안 된 것도** 보이고
//    누르면 그 자리에서 접속한다 — 예전엔 "이미 열린 SSH 세션"만 고를 수 있었다.
//  · 파일 영역은 FileTree 를 그대로 쓴다. 다중 선택·Ctrl+C/V·같은 서버 cp·이름 변경·삭제가
//    이미 거기 있다 — 탐색기용으로 두 번째 구현을 만들지 않는다(툴바만 toolbar 옵션으로 켠다).
//
// 2패널(좌우 동시)은 없앴다. 열자마자 로컬이 두 개 뜨던 것이 그 구조 때문이었고(준영님 제보),
// 탭 + 복사/붙여넣기가 그 자리를 대신한다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionProfile, WorkProfile } from '@shared/types'
import type { Session } from '../store/sessions'
import { FileTree, type ActiveFileSession } from './FileTree'
import { IconClose, IconFolder } from './icons'
import type { DialogSpec, DialogResult } from './Dialog'
import { LOCAL_TARGET, closeTab, openTab, type ExpTab, type ExpTarget } from '../store/explorerTabs'
import { reorderById } from '../store/sessions'
import { useFloatWindow } from '../store/floatWindow'
import { t } from '../i18n'

// FileTree 계약상 session:null 은 "백엔드 없음"(플레이스홀더)이지 로컬을 뜻하지 않는다 — 로컬을
// 보려면 항상 이 sentinel 을 넘긴다(backendFor 가 type 으로만 분기한다).
const LOCAL_SESSION: ActiveFileSession = { id: 'local', type: 'local' }

let tabSeq = 0
const newTabId = (): string => `et-${(tabSeq += 1)}`

type Props = {
  sessions: Session[]
  profiles: ConnectionProfile[]
  workProfiles: WorkProfile[]
  /** 프로필로 접속(이미 접속돼 있어도 호출측이 알아서 처리). 새 세션 id 는 sessions 목록으로 돌아온다. */
  onConnect: (profileId: string) => void
  onClose: () => void
  ask: (spec: DialogSpec) => Promise<DialogResult>
  askText: (spec: DialogSpec & { input: NonNullable<DialogSpec['input']> }) => Promise<string | null>
  /** F26: 바깥(디스크 창)에서 건네는 "이 서버의 이 폴더를 열어라". at 이 바뀔 때만 한 번 반응한다. */
  reveal?: { profileId: string; path: string; at: number } | null
}

export function ExplorerView({ sessions, profiles, workProfiles, onConnect, onClose, ask, askText, reveal }: Props): JSX.Element {
  const [tabs, setTabs] = useState<ExpTab[]>(() => [{ id: newTabId(), target: LOCAL_TARGET, label: t('explorer.nav.thisPc') }])
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id)
  // 드래그 중인 탭 / 지금 위에 떠 있는 탭(놓을 자리 표시).
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  // 떠 있는 창의 이동·크기·최대화(서버 콘솔 창과 공유 — store/floatWindow.ts).
  const { rect, maximized, drag, toggleMax } = useFloatWindow()
  // 아직 접속 중인 프로필 — 세션이 뜨면 그 탭을 연다. goto 는 즐겨찾기로 들어온 시작 폴더.
  const pending = useRef<{ profileId: string; goto?: string } | null>(null)

  const sshProfiles = useMemo(() => profiles.filter((p): p is Extract<ConnectionProfile, { type: 'ssh' }> => p.type === 'ssh'), [profiles])

  // 프로필 → 살아 있는 SSH 세션(있으면). 파일 탐색은 세션 하나면 되므로 가장 최근 것을 쓴다.
  const sessionOf = useCallback(
    (profileId: string): Session | undefined => {
      let found: Session | undefined
      for (const s of sessions) if (s.type === 'ssh' && s.profileId === profileId) found = s
      return found
    },
    [sessions]
  )

  const open = useCallback((target: ExpTarget, label: string, goto?: string) => {
    setTabs((cur) => {
      const r = openTab(cur, { id: newTabId(), target, label, goto })
      setActiveId(r.activeId)
      return r.tabs
    })
  }, [])

  // 서버 열기: 세션이 있으면 바로 탭, 없으면 접속을 걸어 두고 세션이 뜨면 연다.
  const openServer = useCallback(
    (p: { id: string; name: string }, goto?: string) => {
      const s = sessionOf(p.id)
      if (s) return open({ kind: 'ssh', profileId: p.id }, p.name, goto)
      pending.current = { profileId: p.id, goto }
      onConnect(p.id)
    },
    [sessionOf, open, onConnect]
  )

  // 접속이 끝나 세션이 목록에 나타나면 그때 탭을 만든다(connectProfile 은 세션 id 를 돌려주지 않는다).
  useEffect(() => {
    const want = pending.current
    if (!want) return
    const s = sessionOf(want.profileId)
    if (!s) return
    pending.current = null
    open({ kind: 'ssh', profileId: want.profileId }, profiles.find((p) => p.id === want.profileId)?.name ?? s.title, want.goto)
  }, [sessions, sessionOf, open, profiles])

  // F26 디스크 창 → [탐색기로 열기]. 즐겨찾기(openWork)와 같은 경로를 탄다 — 서버 탭을 열고 그
  // 폴더로 보낸다. at 을 기억해 두는 이유: 세션 목록이 바뀔 때마다 이 효과가 다시 도는데, 그때마다
  // 열면 사용자가 옮겨 간 폴더를 도로 끌어당긴다.
  const revealedAt = useRef(0)
  useEffect(() => {
    if (!reveal || reveal.at === revealedAt.current) return
    revealedAt.current = reveal.at
    const p = profiles.find((x) => x.id === reveal.profileId)
    if (p) openServer({ id: p.id, name: p.name }, reveal.path)
  }, [reveal, profiles, openServer])

  // 즐겨찾기(작업 프로필) — 서버+폴더를 한 번에. profileId 가 없으면 로컬 폴더다.
  const openWork = useCallback(
    (w: WorkProfile) => {
      if (!w.profileId) return open(LOCAL_TARGET, t('explorer.nav.thisPc'), w.path)
      const p = profiles.find((x) => x.id === w.profileId)
      if (p) openServer({ id: p.id, name: p.name }, w.path)
    },
    [open, openServer, profiles]
  )

  const sessionFor = (tab: ExpTab): ActiveFileSession =>
    tab.target.kind === 'local' ? LOCAL_SESSION : (() => {
      const s = sessionOf(tab.target.profileId)
      // 세션이 닫혔으면 백엔드 없음 — FileTree 가 안내 문구를 띄운다(탭은 남겨 둔다, 다시 누르면 재접속).
      return s ? { id: s.id, type: 'ssh' as const } : null
    })()

  return (
    <div className="exp-win" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} role="dialog" aria-label={t('explorer.title')}>
      <div className="exp-title" onMouseDown={(e) => drag(e, 'move')} onDoubleClick={toggleMax}>
        <span className="exp-tico">
          <IconFolder />
        </span>
        <span className="exp-tname">{t('explorer.title')}</span>
        <span className="sb-tab-spacer" />
        {/* #71: div/span 이 아니라 진짜 버튼 — Tab·Enter 로 창을 닫을 수 있어야 한다. */}
        <button
          type="button"
          className="exp-wbtn"
          title={t(maximized ? 'explorer.restore' : 'explorer.maximize')}
          onClick={toggleMax}
        >
          {maximized ? '❐' : '▢'}
        </button>
        <button type="button" className="exp-wbtn x" title={t('explorer.close')} onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="exp-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={
              'exp-tab' +
              (tab.id === activeId ? ' on' : '') +
              (dragId === tab.id ? ' dragging' : '') +
              (overId === tab.id ? ' dropping' : '')
            }
            onClick={() => setActiveId(tab.id)}
            title={tab.label}
            // 순서 바꾸기 — 터미널 탭바(TermTabbar)와 같은 손놀림이다. 두 탭바가 다르게 움직이면
            // 사용자가 어느 쪽이 되는지를 외워야 한다.
            draggable
            onDragStart={(e) => {
              setDragId(tab.id)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', tab.id)
            }}
            onDragEnd={() => {
              setDragId(null)
              setOverId(null)
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === tab.id) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setOverId(tab.id)
            }}
            onDragLeave={() => setOverId((cur) => (cur === tab.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault()
              const from = dragId ?? e.dataTransfer.getData('text/plain')
              setDragId(null)
              setOverId(null)
              if (from) setTabs((cur) => reorderById(cur, from, tab.id))
            }}
          >
            <span className="exp-tab-ic">{tab.target.kind === 'local' ? '🖴' : '🖧'}</span>
            <span className="exp-tab-nm">{tab.label}</span>
            {tabs.length > 1 && (
              <span
                className="exp-tab-x"
                title={t('explorer.tab.close')}
                onClick={(e) => {
                  e.stopPropagation()
                  const r = closeTab(tabs, activeId, tab.id)
                  setTabs(r.tabs)
                  setActiveId(r.activeId)
                }}
              >
                <IconClose />
              </span>
            )}
          </div>
        ))}
        <span className="exp-tab add" title={t('explorer.tab.new')} onClick={() => open(LOCAL_TARGET, t('explorer.nav.thisPc'))}>
          ＋
        </span>
      </div>

      <div className="exp-body">
        <div className="exp-nav">
          {workProfiles.length > 0 && <div className="exp-grp">{t('explorer.nav.favorites')}</div>}
          {workProfiles.map((w) => (
            <div key={w.id} className="exp-node" title={w.path} onClick={() => openWork(w)}>
              <span className="ic">★</span>
              <span className="nm">{w.name}</span>
            </div>
          ))}

          <div className="exp-grp">{t('explorer.nav.thisPc')}</div>
          <div
            className={'exp-node' + (tabs.find((x) => x.id === activeId)?.target.kind === 'local' ? ' on' : '')}
            onClick={() => open(LOCAL_TARGET, t('explorer.nav.thisPc'))}
          >
            <span className="ic">🖴</span>
            <span className="nm">{t('explorer.nav.home')}</span>
          </div>

          <div className="exp-grp">{t('explorer.nav.servers')}</div>
          {sshProfiles.length === 0 && <div className="exp-none">{t('explorer.nav.noServers')}</div>}
          {sshProfiles.map((p) => {
            const live = Boolean(sessionOf(p.id))
            const cur = tabs.find((x) => x.id === activeId)?.target
            const on = cur?.kind === 'ssh' && cur.profileId === p.id
            return (
              <div
                key={p.id}
                className={'exp-node' + (on ? ' on' : '')}
                title={`${p.username}@${p.host}${live ? '' : ' · ' + t('explorer.nav.willConnect')}`}
                onClick={() => openServer(p)}
              >
                <span className="ic">🖧</span>
                <span className="nm">{p.name}</span>
                <span className={'exp-dot' + (live ? ' live' : '')} />
              </div>
            )
          })}
        </div>

        {/* 탭마다 FileTree 를 하나씩 마운트해 둔다 — 언마운트하면 그 탭이 보던 폴더를 잊는다.
            숨은 트리는 active=false 라 파일시스템을 읽지 않는다(사이드바 [파일] 탭과 같은 규칙). */}
        <div className="exp-main">
          {tabs.map((tab) => (
            <div key={tab.id} className="exp-pane" style={tab.id === activeId ? undefined : { display: 'none' }}>
              <FileTree
                session={sessionFor(tab)}
                active={tab.id === activeId}
                cwd={tab.goto ?? null}
                ask={ask}
                askText={askText}
                toolbar
              />
            </div>
          ))}
        </div>
      </div>

      <div className="exp-grip" title={t('explorer.resize')} onMouseDown={(e) => drag(e, 'resize')} />
    </div>
  )
}
