// M15 연동 — 설정 › 연동(GitLab) · 설정 › Slack, 소스 제어의 GitLab MR 목록·[MR 만들기]. 열 때만 불러온다(index.ts lazy).
// 토큰 칸은 쓰기만 한다 — 저장된 값은 화면으로 돌아오지 않는다(있다/없다만).
import { useCallback, useEffect, useState, type JSX } from 'react'
import type { GitLabMr, GitLabMrState, IntegrationsState } from '@shared/integrations'
import { t } from '../../i18n'
import { Row, Toggle } from '../../components/SettingsPage'
import './integrations.css'

const ERR_CODES = new Set(['off', 'noToken', 'noRemote', 'otherHost', 'token', 'forbidden', 'notFound', 'exists', 'network', 'http', 'emptyTitle', 'detached', 'noTarget'])
const errText = (r: { error: string; detail?: string }): string =>
  (ERR_CODES.has(r.error) ? t('gitlab.err.' + r.error) : r.error) + (r.detail ? ` — ${r.detail}` : '')

function useIntegrations(): [IntegrationsState | null, (s: IntegrationsState) => void] {
  const [st, setSt] = useState<IntegrationsState | null>(null)
  useEffect(() => {
    void window.ev.integrations.get().then(setSt)
    return window.ev.integrations.onUpdate(setSt)
  }, [])
  return [st, setSt]
}

/** 비밀 칸 하나: 입력 → [저장] / [지우기]. 저장된 값은 안 보여 준다. */
function SecretField({ field, has, placeholder, onSave }: { field: string; has: boolean; placeholder: string; onSave: (v: string) => Promise<void> }): JSX.Element {
  const [v, setV] = useState('')
  return (
    <>
      <div className="ai-key-ctl">
        <input type="password" className="ai-key-input" data-field={field} autoComplete="off" spellCheck={false} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
        <button type="button" className="btn" data-action={field + '.save'} disabled={!v.trim()} onClick={() => void onSave(v).then(() => setV(''))}>
          {t('settings.ai.key.save')}
        </button>
        <button type="button" className="btn sec" data-action={field + '.delete'} disabled={!has} onClick={() => void onSave('')}>
          {t('settings.ai.key.delete')}
        </button>
      </div>
      <div className="set-note" data-state={has ? 'has' : 'none'}>
        {has ? t('settings.ai.key.saved') : t('settings.ai.key.none')}
      </div>
    </>
  )
}

export function GitLabSettingsPanel(): JSX.Element | null {
  const [st, setSt] = useIntegrations()
  const [url, setUrl] = useState<string | null>(null)
  const [test, setTest] = useState<string | null>(null)
  if (!st) return null
  const g = st.gitlab
  const save = async (p: Partial<{ enabled: boolean; baseUrl: string; token: string }>): Promise<void> => {
    setTest(null)
    setSt(await window.ev.integrations.setGitlab({ enabled: g.enabled, baseUrl: g.baseUrl, ...p }))
  }
  return (
    <>
      <Row label={t('gitlab.set.enable')} desc={t('gitlab.set.enable.desc')} item="gitlab.enable">
        <Toggle on={g.enabled} label={t('gitlab.set.enable')} onChange={(on) => void save({ enabled: on })} />
      </Row>
      <Row label={t('gitlab.set.url')} desc={t('gitlab.set.url.desc')} item="gitlab.url">
        <input
          type="text"
          className="ai-key-input"
          data-field="gitlab.url"
          spellCheck={false}
          placeholder="https://gitlab.example.co.kr"
          value={url ?? g.baseUrl}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => url !== null && void save({ baseUrl: url }).then(() => setUrl(null))}
        />
      </Row>
      <Row label={t('gitlab.set.token')} desc={t('gitlab.set.token.desc')} item="gitlab.token">
        <SecretField field="gitlab.token" has={g.hasToken} placeholder="glpat-…" onSave={(v) => save({ token: v })} />
      </Row>
      <Row label={t('gitlab.set.test')} item="gitlab.test">
        <div className="ai-key-ctl">
          <button type="button" className="btn sec" data-action="gitlab.test" disabled={!g.enabled} onClick={() => void window.ev.gitlab.test().then((r) => setTest(r.ok ? t('gitlab.set.ok').replace('{user}', r.user) : errText(r)))}>
            {t('gitlab.set.test')}
          </button>
          {test && <span className="set-note" data-gitlab="test">{test}</span>}
        </div>
      </Row>
    </>
  )
}

export function SlackSettingsPanel(): JSX.Element | null {
  const [st, setSt] = useIntegrations()
  const [draft, setDraft] = useState<{ channel?: string; users?: string }>({})
  if (!st) return null
  const s = st.slack
  const save = async (p: Partial<{ enabled: boolean; channel: string; users: string[]; notify: boolean; appToken: string; botToken: string }>): Promise<void> => {
    setSt(await window.ev.integrations.setSlack({ enabled: s.enabled, channel: s.channel, users: s.users, notify: s.notify, ...p }))
  }
  const ready = s.hasAppToken && s.hasBotToken
  return (
    <>
      <Row label={t('slack.set.enable')} desc={t('slack.set.enable.desc')} item="slack.enable">
        <Toggle on={s.enabled} disabled={!ready && !s.enabled} label={t('slack.set.enable')} onChange={(on) => void save({ enabled: on })} />
        <div className="set-note" data-slack-link={s.link}>
          {t('slack.link.' + s.link)}
          {s.error ? ` — ${s.error}` : ''}
        </div>
      </Row>
      <Row label={t('slack.set.appToken')} desc={t('slack.set.appToken.desc')} item="slack.appToken">
        <SecretField field="slack.appToken" has={s.hasAppToken} placeholder="xapp-…" onSave={(v) => save({ appToken: v })} />
      </Row>
      <Row label={t('slack.set.botToken')} desc={t('slack.set.botToken.desc')} item="slack.botToken">
        <SecretField field="slack.botToken" has={s.hasBotToken} placeholder="xoxb-…" onSave={(v) => save({ botToken: v })} />
      </Row>
      <Row label={t('slack.set.channel')} desc={t('slack.set.channel.desc')} item="slack.channel">
        <input
          type="text"
          className="ai-key-input"
          data-field="slack.channel"
          spellCheck={false}
          placeholder="C0123456789"
          value={draft.channel ?? s.channel}
          onChange={(e) => setDraft({ ...draft, channel: e.target.value })}
          onBlur={() => draft.channel !== undefined && void save({ channel: draft.channel }).then(() => setDraft({ ...draft, channel: undefined }))}
        />
      </Row>
      <Row label={t('slack.set.users')} desc={t('slack.set.users.desc')} item="slack.users">
        <input
          type="text"
          className="ai-key-input"
          data-field="slack.users"
          spellCheck={false}
          placeholder="U0123456789, U0987654321"
          value={draft.users ?? s.users.join(', ')}
          onChange={(e) => setDraft({ ...draft, users: e.target.value })}
          onBlur={() => draft.users !== undefined && void save({ users: draft.users.split(/[\s,]+/).filter(Boolean) }).then(() => setDraft({ ...draft, users: undefined }))}
        />
      </Row>
      <Row label={t('slack.set.notify')} desc={t('slack.set.notify.desc')} item="slack.notify">
        <Toggle on={s.notify} label={t('slack.set.notify')} onChange={(on) => void save({ notify: on })} />
      </Row>
      <div className="set-note" data-item="slack.commands">
        {t('slack.set.commands')}
      </div>
    </>
  )
}

/** 소스 제어 › GitLab MR 목록(이 저장소). GitLab 이 꺼져 있으면 아무것도 안 그린다 — 묻지도 않는다. 펼칠 때만 조회. */
export function GitLabMrList({ cwd }: { cwd: string }): JSX.Element | null {
  const [st] = useIntegrations()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<GitLabMrState>('opened')
  const [res, setRes] = useState<{ mrs: GitLabMr[] } | { err: string } | null>(null)
  const load = useCallback(async () => {
    setRes(null)
    const r = await window.ev.gitlab.mrs(cwd, state)
    setRes(r.ok ? { mrs: r.mrs } : { err: errText(r) })
  }, [cwd, state])
  useEffect(() => {
    if (open) void load()
  }, [open, load])
  if (!st?.gitlab.enabled) return null
  return (
    <div className="gl-mrs" data-scm="gitlab">
      <div className="gl-head">
        <button type="button" className="btn sec" data-scm="gitlabToggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('gitlab.mr.title')}
        </button>
        {open && (
          <>
            <select className="aiws-input" data-field="gitlab.mrState" value={state} onChange={(e) => setState(e.target.value as GitLabMrState)}>
              {(['opened', 'merged', 'closed', 'all'] as const).map((s) => (
                <option key={s} value={s}>
                  {t('gitlab.mr.state.' + s)}
                </option>
              ))}
            </select>
            <button type="button" className="btn sec" data-scm="gitlabRefresh" onClick={() => void load()}>
              {t('gitlab.mr.refresh')}
            </button>
          </>
        )}
      </div>
      {open && !res && <div className="set-note">{t('gitlab.mr.loading')}</div>}
      {open && res && 'err' in res && <div className="scm-msg err" data-scm="gitlabError">{res.err}</div>}
      {open && res && 'mrs' in res && (
        <div data-scm="gitlabMrs">
          {res.mrs.length === 0 && <div className="set-note">{t('gitlab.mr.empty')}</div>}
          {res.mrs.map((m) => (
            <button type="button" key={m.iid} className="gl-mr" data-mr={m.iid} title={m.url} onClick={() => void window.ev.oriel.open(m.url)}>
              <span>!{m.iid}</span>
              <span className="gl-mr-title">{(m.draft ? `[${t('gitlab.mr.draft')}] ` : '') + m.title}</span>
              <span className="gl-mr-meta">{[m.source + ' → ' + m.target, m.pipeline && t('gitlab.mr.pipeline') + ' ' + m.pipeline, m.merge].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** MR 초안 → [MR 만들기](사람이 누를 때만). 푸시는 하지 않는다 — 브랜치가 원격에 없으면 GitLab 의 말을 보여 준다. */
export function GitLabMrCreate({ cwd, title, body, base }: { cwd: string; title: string; body: string; base: string }): JSX.Element | null {
  const [st] = useIntegrations()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null)
  if (!st?.gitlab.enabled) return null
  const create = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.ev.gitlab.createMr(cwd, { title, description: body, target: base })
      setMsg(r.ok ? { ok: true, text: t('gitlab.mr.created').replace('{n}', String(r.mr.iid)), url: r.mr.url } : { ok: false, text: errText(r) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button type="button" className="btn" data-scm="mrCreate" disabled={busy || !title.trim() || !base} onClick={() => void create()}>
        {t('gitlab.mr.create')}
      </button>
      {msg && (
        <span className={'scm-msg' + (msg.ok ? '' : ' err')} data-scm="mrCreateResult">
          {msg.text}
          {msg.url && (
            <button type="button" className="btn sec" onClick={() => void window.ev.oriel.open(msg.url!)}>
              {t('gitlab.mr.open')}
            </button>
          )}
        </span>
      )}
    </>
  )
}
