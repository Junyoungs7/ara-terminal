// M14 R1 AU-03 설정 › AI 작업 공간 › MCP 서버 — Orca McpConfigSection(프로젝트 MCP 설정 살피기·빈 설정 만들기·열기) + 에이전트별 사용자 설정(읽기만)
// + 아라가 붙이는 Oriel. 쓰기는 프로젝트 .mcp.json 에만, 사람이 누를 때만.
import { useCallback, useEffect, useState, type JSX } from 'react'
import type { Project } from '@shared/worktrees'
import type { McpServerSummary } from '@shared/mcp/mcp-config'
import type { McpSource, McpView } from '@shared/mcp/agentMcp'
import { t } from '../../i18n'
import { useDialog } from '../../components/Dialog'

const NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' } as const

function ServerRow({ s, onRemove }: { s: McpServerSummary; onRemove?: () => void }): JSX.Element {
  return (
    <div className="acct-row" data-mcp-server={s.name}>
      <span className="acct-name">{s.name}</span>
      <span className={'acct-usage' + (s.status === 'invalid' ? ' na' : '')}>
        {s.transport} · {s.command ?? s.url ?? ''} · {t(`mcpsrv.status.${s.status}`)}
        {s.issue ? ` — ${s.issue}` : ''}
      </span>
      {onRemove && (
        <span className="acct-actions">
          <button type="button" className="btn" data-action="mcp.remove" onClick={onRemove}>
            {t('mcpsrv.remove')}
          </button>
        </span>
      )}
    </div>
  )
}

export function McpPanel(): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<string | null>(null)
  const [view, setView] = useState<McpView | null>(null)
  const [confirmStarter, setConfirmStarter] = useState(false)
  const [form, setForm] = useState({ name: '', command: '', args: '', url: '' })
  const [msg, setMsg] = useState<string | null>(null)
  const dialog = useDialog()
  useEffect(() => {
    void window.ev.repos.list().then((ps) => {
      const local = ps.filter((p) => !p.host)
      setProjects(local)
      setProject((cur) => cur ?? local[0]?.path ?? null)
    })
  }, [])
  const load = useCallback(() => void window.ev.mcpServers.list(project).then(setView), [project])
  useEffect(load, [load])
  const done = (r: { ok: true } | { ok: false; error: string }): void => {
    setMsg(r.ok ? null : r.error)
    load()
  }
  const remove = async (name: string): Promise<void> => {
    if (!project) return
    const ok = await dialog.ask({ title: t('mcpsrv.removeTitle').replace('{name}', name), message: t('mcpsrv.removeMsg'), tone: 'danger', confirmLabel: t('mcpsrv.remove'), cancelLabel: t('auto.cancel') })
    if (ok === 'confirm') done(await window.ev.mcpServers.remove(project, name))
  }
  const add = async (): Promise<void> => {
    if (!project) return
    const args = form.args.trim() ? form.args.trim().split(/\s+/) : []
    const r = await window.ev.mcpServers.add(project, { name: form.name.trim(), ...(form.url.trim() ? { url: form.url } : { command: form.command, args }) })
    if (r.ok) setForm({ name: '', command: '', args: '', url: '' })
    done(r)
  }
  // Orca: [MCP 설정 추가] 를 한 번 더 눌러야 빈 설정을 만든다(3초 안).
  const starter = async (): Promise<void> => {
    if (!project) return
    if (!confirmStarter) {
      setConfirmStarter(true)
      setTimeout(() => setConfirmStarter(false), 3000)
      return
    }
    setConfirmStarter(false)
    done(await window.ev.mcpServers.createStarter(project))
  }

  const user = view?.sources.filter((s) => s.scope === 'user') ?? []
  const proj = view?.sources.filter((s) => s.scope === 'project') ?? []
  const detected = proj.filter((s) => s.exists)
  const isRootMcp = (s: McpSource): boolean => s.label === '.mcp.json'
  return (
    <div className="acct-block" data-mcp="panel">
      <div className="acct-title">{t('mcpsrv.attached')}</div>
      {view?.attached.map((a) => (
        <div key={a.agent} className="acct-row" data-mcp-attached={a.agent}>
          <span className="acct-name">{NAMES[a.agent]}</span>
          <span className={'acct-usage' + (a.on ? '' : ' na')}>
            {a.name} · {a.on ? t('mcpsrv.byAra') : t('mcpsrv.byAra.off')}
          </span>
        </div>
      ))}
      <div className="acct-title">{t('mcpsrv.user')}</div>
      <div className="set-note">{t('mcpsrv.user.desc')}</div>
      {user.map((s) => (
        <div key={s.id} data-mcp-source={s.id}>
          <div className="acct-foot">
            <span className="acct-name">{s.label}</span>
            <span className="acct-usage">{s.exists ? s.path : `${s.path} · ${t('mcpsrv.missing')}`}</span>
            {s.exists && (
              <button type="button" className="btn" data-action="mcp.open" onClick={() => void window.ev.mcpServers.open(s.path)}>
                {t('mcpsrv.open')}
              </button>
            )}
          </div>
          {s.servers.map((x) => (
            <ServerRow key={x.name} s={x} />
          ))}
        </div>
      ))}
      <div className="acct-title">{t('mcpsrv.project')}</div>
      <div className="acct-foot">
        <select className="aiws-input" data-field="mcp.project" value={project ?? ''} onChange={(e) => setProject(e.target.value || null)}>
          {projects.map((p) => (
            <option key={p.id} value={p.path}>
              {p.displayName}
            </option>
          ))}
        </select>
        <button type="button" className="btn" data-action="mcp.refresh" onClick={load}>
          {t('skills.refresh')}
        </button>
        {project && !detected.length && (
          <button type="button" className={'btn' + (confirmStarter ? ' pri' : '')} data-action="mcp.starter" onClick={() => void starter()}>
            {confirmStarter ? t('mcpsrv.starter.confirm') : t('mcpsrv.starter')}
          </button>
        )}
      </div>
      {!projects.length && <div className="set-note">{t('auto.noTargets')}</div>}
      {project && !detected.length && <div className="set-note">{t('mcpsrv.none')}</div>}
      {detected.map((s) => (
        <div key={s.id} data-mcp-source={s.label}>
          <div className="acct-foot">
            <span className="acct-name">{s.label}</span>
            <span className={'acct-usage' + (s.status === 'invalid' ? ' na' : '')}>{s.status === 'invalid' ? s.error : t('mcpsrv.count').replace('{n}', String(s.servers.length))}</span>
            <button type="button" className="btn" data-action="mcp.open" onClick={() => void window.ev.mcpServers.open(s.path)}>
              {t('mcpsrv.open')}
            </button>
          </div>
          {s.servers.map((x) => (
            <ServerRow key={x.name} s={x} onRemove={isRootMcp(s) ? () => void remove(x.name) : undefined} />
          ))}
        </div>
      ))}
      {project && (
        <>
          <div className="acct-title">{t('mcpsrv.addTitle')}</div>
          <div className="auto-grid">
            <input className="aiws-input" data-field="mcp.name" placeholder={t('mcpsrv.f.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className="aiws-input aiws-mono" data-field="mcp.command" placeholder={t('mcpsrv.f.command')} value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
            <input className="aiws-input aiws-mono" data-field="mcp.args" placeholder={t('mcpsrv.f.args')} value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
            <input className="aiws-input aiws-mono" data-field="mcp.url" placeholder={t('mcpsrv.f.url')} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </div>
          <div className="acct-foot">
            <button type="button" className="btn" data-action="mcp.add" onClick={() => void add()}>
              {t('mcpsrv.add')}
            </button>
            <span className="set-note">{t('mcpsrv.add.desc')}</span>
          </div>
        </>
      )}
      {msg && <div className="set-note err">{msg}</div>}
      {dialog.node}
    </div>
  )
}
