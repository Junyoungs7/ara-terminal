// M14 R1 AU-02 설정 › AI 작업 공간 › 스킬 — Orca SkillsPage(에이전트 거르기·출처·지우기)의 아라 몫. 열 때만 읽는다.
// 쓰기(추가·지우기)는 버튼을 눌렀을 때만, 지우기는 확인 뒤 휴지통으로. 링크된 폴더 안이면 원본이 지워진다는 것을 확인 창이 먼저 밝힌다.
import { useCallback, useEffect, useState, type JSX } from 'react'
import { SKILL_ADD_TARGETS, SKILL_AGENTS, skillDeleteBlock, type DiscoveredSkill, type SkillAddTarget, type SkillAgent, type SkillScan } from '@shared/skills'
import { t } from '../../i18n'
import { useDialog } from '../../components/Dialog'

const NAMES: Record<SkillAgent, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }

export function SkillsPanel(): JSX.Element {
  const [scan, setScan] = useState<SkillScan | null>(null)
  const [agent, setAgent] = useState<SkillAgent | 'all'>('all')
  const [q, setQ] = useState('')
  const [target, setTarget] = useState<SkillAddTarget>('home-claude')
  const [msg, setMsg] = useState<string | null>(null)
  const dialog = useDialog()
  const load = useCallback(() => void window.ev.skills.scan().then(setScan), [])
  useEffect(load, [load])

  const remove = async (s: DiscoveredSkill): Promise<void> => {
    const where = s.linkTarget
      ? t('skills.del.link').replace('{target}', s.linkTarget)
      : s.realPath
        ? t('skills.del.linked').replace('{real}', s.realPath)
        : t('skills.del.trash')
    const ok = await dialog.ask({ title: t('skills.del.title').replace('{name}', s.name), message: `${s.directoryPath}\n\n${where}`, tone: 'danger', confirmLabel: t('skills.del.confirm'), cancelLabel: t('auto.cancel') })
    if (ok !== 'confirm') return
    const r = await window.ev.skills.delete(s.id)
    setMsg(r.ok ? null : r.error)
    load()
  }
  const add = async (): Promise<void> => {
    const src = await window.ev.skills.pickFolder()
    if (!src) return
    const r = await window.ev.skills.add(src, target)
    setMsg(r.ok ? t('skills.added').replace('{path}', r.path) : r.error)
    load()
  }

  const root = (id: string) => scan?.roots.find((r) => r.id === id)
  const shown = (scan?.skills ?? []).filter((s) => (agent === 'all' || s.agents.includes(agent)) && (!q || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(q.toLowerCase())))
  const linkedRoots = (scan?.roots ?? []).filter((r) => r.realPath)
  return (
    <div className="acct-block" data-skills="panel">
      <div className="set-note">{t('skills.note')}</div>
      <div className="acct-foot">
        <select className="aiws-input" data-field="skills.agent" value={agent} onChange={(e) => setAgent(e.target.value as SkillAgent | 'all')}>
          <option value="all">{t('skills.all')}</option>
          {SKILL_AGENTS.map((a) => (
            <option key={a} value={a}>
              {NAMES[a]}
            </option>
          ))}
        </select>
        <input className="aiws-input" data-field="skills.search" placeholder={t('skills.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" data-action="skills.refresh" onClick={load}>
          {t('skills.refresh')}
        </button>
      </div>
      {linkedRoots.map((r) => (
        <div key={r.id} className="set-note err" data-skills="linked-root">
          {t('skills.linkedRoot').replace('{path}', r.path).replace('{real}', r.realPath!)}
        </div>
      ))}
      {!scan && <div className="set-note">{t('usage.loading')}</div>}
      {scan && !shown.length && <div className="set-note">{t('skills.empty')}</div>}
      {shown.map((s) => {
        const block = skillDeleteBlock(s)
        return (
          <div key={s.id} className="acct-row" data-skill={s.name}>
            <span className="acct-name">{s.name}</span>
            <span className="acct-usage" title={s.directoryPath}>
              {s.agents.map((a) => NAMES[a]).join('·')} · {root(s.rootId)?.label ?? s.rootId}
              {s.linkTarget ? ` · ${t('skills.isLink')}` : s.realPath ? ` · ${t('skills.inLinked')}` : ''}
              {s.description ? ` — ${s.description}` : ''}
            </span>
            <span className="acct-actions">
              <button type="button" className="btn" data-action="skills.delete" disabled={block !== null} title={block ? t(`skills.block.${block}`) : undefined} onClick={() => void remove(s)}>
                {t('skills.delete')}
              </button>
            </span>
          </div>
        )
      })}
      <div className="acct-title">{t('skills.addTitle')}</div>
      <div className="acct-foot">
        <select className="aiws-input" data-field="skills.target" value={target} onChange={(e) => setTarget(e.target.value as SkillAddTarget)}>
          {SKILL_ADD_TARGETS.map((id) => (
            <option key={id} value={id}>
              {root(id) ? `${root(id)!.label} — ${root(id)!.path}` : id}
            </option>
          ))}
        </select>
        <button type="button" className="btn" data-action="skills.add" onClick={() => void add()}>
          {t('skills.add')}
        </button>
      </div>
      {msg && <div className="set-note">{msg}</div>}
      {dialog.node}
    </div>
  )
}
