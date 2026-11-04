import { useEffect, useState, type JSX } from 'react'
import type { ServerAccount, ServerAccountAgent } from '@shared/managedServers'
import type { ManagedAccountsRequest } from '@shared/ipc'
import { t } from '../../i18n'
import type { DialogResult, DialogSpec } from '../../components/Dialog'
import { TerminalPane } from '../../terminal/TerminalPane'
import { serverAccounts, useServerAccounts, useServerAccountsStore } from './serverAccounts'
import './servers.css'

/**
 * 원격 3차 R3 설정 › 관리형 서버 › 서버 계정(목업 mockups/v3/serve/4-accounts.html A — 설정 안에서 펼침 + 로그인 단계에만 그 자리 작은 원격 터미널).
 * 계정 = 서버의 ~/.ara-server/accounts/<id>/(700). 로그인은 그 계정 env 로 서버에서 `claude auth login`(Codex 는 `codex login`)을 돌리고,
 * 사람이 그 터미널에서 주소를 열고(Ctrl+클릭 → 이 PC 브라우저) 코드를 붙여 넣는다. 끝나면 셸이 닫혀 칸이 내려간다.
 * 지우기 = 그 계정 폴더만(공유 대화 기록은 남는다). 원격 탭은 기본 계정으로 뜬다(설정 없으면 서버 본래 로그인).
 */
export function ServerAccountsBox({ hostKey, ask }: { hostKey: string; ask: (spec: DialogSpec) => Promise<DialogResult> }): JSX.Element {
  const srv = useServerAccounts(hostKey)
  const loadErr = useServerAccountsStore((s) => {
    const e = s.byHost[hostKey]
    return e && 'error' in e ? e.error : null
  })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [agent, setAgent] = useState<ServerAccountAgent>('claude')
  const [label, setLabel] = useState('')
  const [agree, setAgree] = useState(false)
  const [login, setLogin] = useState<string | null>(null)

  const act = async (req: Omit<ManagedAccountsRequest, 'hostKey'>): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await serverAccounts({ hostKey, ...req })
      if (!r.ok) setMsg(r.error)
      else if (r.loginSession) setLogin(r.loginSession)
    } finally {
      setBusy(false)
    }
  }
  // 로그인 셸이 끝나면(로그인 마침·실패·사람이 exit) 칸을 내리고 목록을 새로 읽는다.
  useEffect(() => {
    if (!login) return
    return window.ev.session.onExit(login, () => {
      setLogin(null)
      setAdding(false)
      setLabel('')
      setAgree(false)
      void serverAccounts({ hostKey })
    })
  }, [login, hostKey])

  const closeLogin = (): void => {
    if (login) void window.ev.agents.killRemote(hostKey, login).catch(() => false)
    setLogin(null)
    void serverAccounts({ hostKey })
  }
  const remove = async (a: ServerAccount): Promise<void> => {
    const r = await ask({ title: t('managed.acct.removeAsk').replace('{name}', a.label), message: t('managed.acct.removeMsg'), tone: 'danger', confirmLabel: t('managed.acct.remove'), cancelLabel: t('managed.cancel') })
    if (r === 'confirm') await act({ op: 'remove', id: a.id })
  }

  const def = srv?.default ?? null
  const row = (key: string, name: string, sub: string, isDefault: boolean, extra: JSX.Element | null, setDefault: () => void): JSX.Element => (
    <div className="srv-acc" key={key} data-managed-acct={key}>
      <div className="srv-tt">
        <b>
          {name}
          {isDefault && <span className="srv-pill ai">{t('managed.acct.default')}</span>}
        </b>
        <span>{sub}</span>
      </div>
      <span className="srv-act">
        {extra}
        {!isDefault && (
          <button type="button" className="btn sec" disabled={busy} data-managed="acct-default" onClick={setDefault}>
            {t('managed.acct.makeDefault')}
          </button>
        )}
      </span>
    </div>
  )

  return (
    <div className="srv-card srv-accts" data-managed="accounts">
      <div className="srv-hd">
        <b>{t('managed.acct.title')}</b>
        <span className="srv-lo">{t('managed.acct.lead')}</span>
        <span className="srv-sp" />
        {!adding && (
          <button type="button" className="btn sec" disabled={busy} data-managed="acct-add" onClick={() => setAdding(true)}>
            {t('managed.acct.add')}
          </button>
        )}
      </div>
      {!srv && !loadErr && <div className="srv-lo">{t('managed.loading')}</div>}
      {loadErr && !srv && (
        <div className="srv-lo" data-managed="acct-err">
          {loadErr}
        </div>
      )}
      {srv && (
        <>
          {row('system', t('managed.acct.system'), t('managed.acct.systemSub'), def === null, null, () => void act({ op: 'default', id: null }))}
          {srv.accounts.map((a) =>
            row(
              a.id,
              a.label,
              [a.agent === 'claude' ? 'Claude' : 'Codex', a.loggedIn ? t('managed.acct.loggedIn') : t('managed.acct.needLogin'), a.email ?? ''].filter(Boolean).join(' · '),
              def === a.id,
              <>
                {!a.loggedIn && (
                  <button type="button" className="btn sec" disabled={busy || !!login} data-managed="acct-login" onClick={() => void act({ op: 'login', id: a.id })}>
                    {t('managed.acct.login')}
                  </button>
                )}
                <button type="button" className="btn sec" disabled={busy} data-managed="acct-remove" onClick={() => void remove(a)}>
                  {t('managed.acct.remove')}
                </button>
              </>,
              () => void act({ op: 'default', id: a.id })
            )
          )}
        </>
      )}
      {adding && !login && (
        <div className="srv-acc-add" data-managed="acct-addbox">
          <div className="srv-hd">
            <b>{t('managed.acct.new')}</b>
            <span className="srv-sp" />
            <button type="button" className="btn sec" onClick={() => setAdding(false)}>
              {t('managed.cancel')}
            </button>
          </div>
          <div className="srv-hd">
            {(['claude', 'codex'] as const).map((x) => (
              <button key={x} type="button" className={'btn ' + (agent === x ? 'pri' : 'sec')} aria-pressed={agent === x} onClick={() => setAgent(x)}>
                {x === 'claude' ? 'Claude' : 'Codex'}
              </button>
            ))}
            <input className="srv-acc-name" value={label} maxLength={64} placeholder={t('managed.acct.namePh')} aria-label={t('managed.acct.namePh')} data-managed="acct-name" onChange={(e) => setLabel(e.target.value)} />
          </div>
          <label className="srv-acc-agree">
            <input type="checkbox" checked={agree} data-managed="acct-agree" onChange={(e) => setAgree(e.target.checked)} />
            <span>{t('managed.acct.agree')}</span>
          </label>
          <div className="srv-hd">
            <span className="srv-sp" />
            <button type="button" className="btn pri" disabled={busy || !agree || !label.trim()} data-managed="acct-start" onClick={() => void act({ op: 'add', agent, label: label.trim() })}>
              {t('managed.acct.start')}
            </button>
          </div>
        </div>
      )}
      {login && (
        <div className="srv-acc-add" data-managed="acct-loginbox">
          <div className="srv-hd">
            <b>{t('managed.acct.loginTitle')}</b>
            <span className="srv-lo">{t('managed.acct.loginHint')}</span>
            <span className="srv-sp" />
            <button type="button" className="btn sec" data-managed="acct-login-close" onClick={closeLogin}>
              {t('managed.acct.close')}
            </button>
          </div>
          <div className="srv-acc-term">
            <TerminalPane sessionId={login} active local={false} serverKey={hostKey} agent onLink={(_id, url) => void window.ev.app.openExternal(url)} />
          </div>
        </div>
      )}
      <div className="srv-lo">{t('managed.acct.notice')}</div>
      <div className="srv-lo">{t('managed.acct.shared')}</div>
      {msg && (
        <div className="set-note" data-managed="acct-msg">
          {msg}
        </div>
      )}
    </div>
  )
}
