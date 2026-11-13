// 원격 3차 R0 다른 계정으로 이어서 — 화면(목업 mockups/v3/serve/5-switch.html, 준영님 확정: 채팅 보기 = A 카드, 터미널 보기 = B 띠).
// 동작은 accountSwitch.ts 하나 — 카드·띠·탭 우클릭 메뉴가 같은 switchAccount 를 부른다.
// R3 원격 탭도 같다 — 계정 목록은 그 서버의 계정(useServerAccounts), [계정 추가…]는 설정 › 관리형 서버.
import { useState, type JSX } from 'react'
import { ArrowLeftRight, CircleStop, Gauge, Plus } from 'lucide-react'
import type { UsageState } from '@shared/usage'
import type { ServerAccounts } from '@shared/managedServers'
import { useServerAccounts } from '../managed/serverAccounts'
import { t } from '../../i18n'
import { resetAtText, useUsage } from '../../store/usage'
import { openSettings } from '../../store/settingsNav'
import { pushNote } from '../../store/notify'
import { ContextMenu, type MenuItem } from '../../interactions/ContextMenu'
import { useAgentStore, type AgentTab } from './agentStore'
import { accountChoices, accountProviderOf, limitOf, movedOf, switchAccount, type AccountChoice } from './accountRestart'
import type { DialogResult, DialogSpec } from '../../components/Dialog'
import './accountSwitch.css'

const SYSTEM_ID = '__system'
const ADD_ID = 'acct-add'
const idOf = (a: AccountChoice): string => a.id ?? SYSTEM_ID

/** 한도 글 — "업무 계정 A 가 한도에 걸렸습니다 · 15:00 에 풀림". */
function limitText(u: UsageState, tab: AgentTab, now: number, srv: ServerAccounts | null): string | null {
  const l = limitOf(u, tab, now, srv)
  if (!l) return null
  const base = t('aiws.acct.hit').replace('{name}', l.label)
  return l.resetsAt ? `${base} · ${t('aiws.acct.resets').replace('{at}', resetAtText(l.resetsAt, now))}` : base
}

/** 카드·띠·메뉴가 같이 쓰는 실행 — 바쁜 동안 막고 실패는 한 줄. */
function useSwitch(tab: AgentTab): { busy: string | null; err: string | null; run: (a: AccountChoice) => void } {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  return {
    busy,
    err,
    run: (a) => {
      if (busy) return
      setBusy(a.label)
      setErr(null)
      void switchAccount(tab.sessionId, a.id, a.label)
        .then((e) => setErr(e))
        .finally(() => setBusy(null))
    }
  }
}

/** 메뉴 항목(띠의 버튼·탭 우클릭이 같이 쓴다). 옮길 계정이 없으면 [계정 추가…]. */
export function accountMenuItems(u: UsageState, tab: AgentTab, srv: ServerAccounts | null = null): MenuItem[] {
  const list = accountChoices(u, tab, srv)
  return [...list.map((a): MenuItem => ({ id: idOf(a), label: a.label })), { id: ADD_ID, label: t('aiws.acct.add'), icon: <Plus /> }]
}

/** 메뉴에서 고른 것 실행(계정 추가면 설정 › 계정·사용량 — 원격 탭은 설정 › 관리형 서버). */
export function pickAccount(u: UsageState, tab: AgentTab, id: string, run: (a: AccountChoice) => void, srv: ServerAccounts | null = null): void {
  if (id === ADD_ID) return openSettings(tab.host ? 'managed' : 'usage')
  const a = accountChoices(u, tab, srv).find((x) => idOf(x) === id)
  if (a) run(a)
}

/** 탭 우클릭 메뉴 — 한도와 상관없이 늘 있다(로컬 Claude·Codex 탭). */
export function AgentTabMenu({ tab, x, y, ask, onClose }: { tab: AgentTab; x: number; y: number; ask?: (spec: DialogSpec) => Promise<DialogResult>; onClose: () => void }): JSX.Element {
  const u = useUsage()
  const srv = useServerAccounts(tab.host)
  const ok = !!accountProviderOf(tab) && !tab.exited && !tab.slept
  // 메뉴는 고르면 닫히므로(이 컴포넌트도 내려간다) 실패는 알림 센터로.
  const run = (a: AccountChoice): void =>
    void switchAccount(tab.sessionId, a.id, a.label).then((e) => e && pushNote({ kind: 'error', space: 'ai', title: t('aiws.acct.failed'), body: e }))
  const items: MenuItem[] = [
    ok
      ? { id: 'acct', label: t('aiws.acct.continue'), icon: <ArrowLeftRight />, submenu: accountMenuItems(u, tab, srv) }
      : { id: 'acct', label: t('aiws.acct.continue'), icon: <ArrowLeftRight />, disabled: true, title: t('aiws.acct.cannot') },
    // R1 결정 4 ⓑ — 탭 닫기(✕)는 이 PC 에서만. 서버의 에이전트까지 끝내는 것은 여기.
    ...(tab.host ? [{ id: 'endRemote', label: t('servers.end'), icon: <CircleStop />, danger: true, title: t('servers.end.tip') }] : [])
  ]
  return (
    <ContextMenu
      open
      x={x}
      y={y}
      items={items}
      onPick={(id) => {
        onClose()
        if (id === 'endRemote') return void endOnServer(tab, ask)
        pickAccount(u, tab, id, run, srv)
      }}
      onClose={onClose}
    />
  )
}

/** R1 "서버에서도 끝내기" — 다른 PC 의 탭도 닫힌다는 것을 묻고(목업 1-sessions 끝내기 확인) 끝낸다. */
async function endOnServer(tab: AgentTab, ask?: (spec: DialogSpec) => Promise<DialogResult>): Promise<void> {
  if (ask) {
    const r = await ask({ title: t('servers.end.ask'), message: t('servers.end.askMsg'), tone: 'danger', confirmLabel: t('servers.end.ok'), cancelLabel: t('managed.cancel') })
    if (r !== 'confirm') return
  }
  await useAgentStore.getState().endRemote(tab.sessionId)
}

/** 터미널 보기 — 탭 위 띠(목업 B). 걸림 → [다른 계정으로 이어서 ▾] · 바꾸는 중 · 이어 띄움 [닫기]. */
export function AccountLimitBand({ tab }: { tab: AgentTab }): JSX.Element | null {
  const u = useUsage()
  const srv = useServerAccounts(tab.host)
  const s = useSwitch(tab)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const now = Date.now()
  if (s.busy)
    return (
      <div className="aiws-note aiws-acct-band ai" role="status" data-aiws="acct-band-busy">
        <span>{t('aiws.acct.busy').replace('{name}', s.busy)}</span>
      </div>
    )
  if (tab.switched) return <SwitchedNote tab={tab} />
  const text = limitText(u, tab, now, srv)
  if (!text) return <MovedNote tab={tab} u={u} run={s.run} err={s.err} />
  return (
    <div className="aiws-note aiws-acct-band warn" role="alert" data-aiws="acct-band">
      <Gauge aria-hidden />
      <span>{text}</span>
      <span className="aiws-acct-sp" />
      {s.err && <span className="aiws-err">{s.err}</span>}
      <button
        type="button"
        className="btn pri"
        data-aiws="acct-band-switch"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu({ x: r.left, y: r.bottom })
        }}
      >
        <ArrowLeftRight aria-hidden />
        {t('aiws.acct.continue')}
      </button>
      {menu && (
        <ContextMenu
          open
          x={menu.x}
          y={menu.y}
          items={accountMenuItems(u, tab, srv)}
          onPick={(id) => {
            setMenu(null)
            pickAccount(u, tab, id, s.run, srv)
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** 채팅 보기 — 대화 끝 카드(목업 A). 계정 고르기 → [그 계정으로 이어서]. */
export function AccountSwitchCard({ tab }: { tab: AgentTab }): JSX.Element | null {
  const u = useUsage()
  const srv = useServerAccounts(tab.host)
  const s = useSwitch(tab)
  const [pick, setPick] = useState<string | null>(null)
  const now = Date.now()
  if (s.busy)
    return (
      <div className="aiws-note aiws-acct-band ai" role="status" data-aiws="acct-card-busy">
        <span>{t('aiws.acct.busy').replace('{name}', s.busy)}</span>
      </div>
    )
  if (tab.switched) return <SwitchedNote tab={tab} />
  const text = limitText(u, tab, now, srv)
  if (!text) return <MovedNote tab={tab} u={u} run={s.run} err={s.err} />
  const list = accountChoices(u, tab, srv)
  const chosen = list.find((a) => idOf(a) === pick) ?? list[0]
  return (
    <div className="ag-ask" role="group" aria-label={t('aiws.acct.continue')} data-aiws="acct-card">
      <div className="ag-ask-head">
        <Gauge aria-hidden className="aiws-acct-warn" />
        <span>{text}</span>
      </div>
      <p className="ag-ask-q">{t('aiws.acct.ask')}</p>
      <div className="ag-ask-opts" role="radiogroup">
        {list.map((a) => (
          <button key={idOf(a)} type="button" role="radio" aria-checked={a === chosen} className={'ag-ask-opt' + (a === chosen ? ' on' : '')} data-aiws="acct-option" onClick={() => setPick(idOf(a))}>
            <span className="ag-ask-rd" aria-hidden />
            <span className="ag-ask-ot">
              <b>{a.label}</b>
            </span>
          </button>
        ))}
      </div>
      <span className="aiws-note">{t('aiws.acct.keep')}</span>
      {s.err && <span className="aiws-err">{s.err}</span>}
      <div className="aiws-new-foot">
        <button type="button" className="btn sec" onClick={() => openSettings(tab.host ? 'managed' : 'usage')}>
          <Plus aria-hidden />
          {t('aiws.acct.add')}
        </button>
        {chosen && (
          <button type="button" className="btn pri" data-aiws="acct-card-switch" onClick={() => s.run(chosen)}>
            <ArrowLeftRight aria-hidden />
            {t('aiws.acct.continueTo').replace('{name}', chosen.label)}
          </button>
        )}
      </div>
    </div>
  )
}

/** 이어 띄운 뒤 한 줄 — "업무 계정 B 로 이어서 띄웠습니다 · 대화 맥락은 그대로" [닫기]. */
function SwitchedNote({ tab }: { tab: AgentTab }): JSX.Element {
  return (
    <div className="aiws-note aiws-acct-band ok" role="status" data-aiws="acct-switched">
      <ArrowLeftRight aria-hidden />
      <span>{t('aiws.acct.switched').replace('{name}', tab.switched ?? '')}</span>
      <span className="aiws-acct-sp" />
      <button
        type="button"
        className="btn sec"
        onClick={() => useAgentStore.setState((st) => ({ tabs: st.tabs.map((x) => (x.sessionId === tab.sessionId ? { ...x, switched: undefined } : x)) }))}
      >
        {t('aiws.agent.close')}
      </button>
    </div>
  )
}

/** 닫은 안내(탭·고른 계정 짝) — 다시 바꾸면 또 뜬다. */
const movedClosed = new Set<string>()

/** 2.2.24 설정에서 계정을 바꾼 뒤 옛 계정으로 도는 탭 — "이 탭은 A 로 돌고 있습니다 · 새 에이전트는 B" [B(으)로 이어서] [닫기]. */
function MovedNote({ tab, u, run, err }: { tab: AgentTab; u: UsageState; run: (a: AccountChoice) => void; err: string | null }): JSX.Element | null {
  const [, redraw] = useState(0)
  const m = movedOf(u, tab)
  const key = `${tab.sessionId}|${m?.to.id ?? ''}`
  if (!m || movedClosed.has(key)) return null
  return (
    <div className="aiws-note aiws-acct-band ai" role="status" data-aiws="acct-moved">
      <ArrowLeftRight aria-hidden />
      <span>{t('aiws.acct.moved').replace('{from}', m.from).replace('{to}', m.to.label)}</span>
      <span className="aiws-acct-sp" />
      {err && <span className="aiws-err">{err}</span>}
      <button type="button" className="btn sec" data-aiws="acct-moved-switch" onClick={() => run(m.to)}>
        {t('aiws.acct.continueTo').replace('{name}', m.to.label)}
      </button>
      <button
        type="button"
        className="btn sec"
        data-aiws="acct-moved-close"
        onClick={() => {
          movedClosed.add(key)
          redraw((n) => n + 1)
        }}
      >
        {t('aiws.agent.close')}
      </button>
    </div>
  )
}
