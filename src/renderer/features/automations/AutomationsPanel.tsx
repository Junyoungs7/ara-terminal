// M14 R1 AU-01 설정 › AI 작업 공간 › 예약 실행 — Orca AutomationsPage(목록·편집·실행 이력·지금 실행·다시 실행)의 아라 몫. 설정이 이 섹션을 열 때만 불러온다.
import { useEffect, useState, type JSX } from 'react'
import { AGENT_IDS, AGENTS, type AgentId } from '@shared/agents'
import type { Project, Worktree } from '@shared/worktrees'
import { buildAutomationRrule } from '@shared/automations/automation-schedule-occurrences'
import { isValidAutomationSchedule, tryParseAutomationRrule } from '@shared/automations/automation-schedule-parsing'
import { describeAutomationSchedule } from '@shared/automations/automation-schedules'
import { DEFAULT_AUTOMATION_PRECHECK_TIMEOUT_SECONDS } from '@shared/automations/automation-precheck'
import {
  AUTOMATION_DEFAULT_GRACE_MINUTES,
  AUTOMATION_DEFAULT_TIME,
  AUTOMATION_GRACE_CHOICES,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type AutomationsState
} from '@shared/automations/automations-types'
import { t } from '../../i18n'
import { Toggle } from '../../components/SettingsPage'
import { useDialog } from '../../components/Dialog'

type Preset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
const PRESETS: readonly Preset[] = ['hourly', 'daily', 'weekdays', 'weekly', 'custom']
const DAYS = [0, 1, 2, 3, 4, 5, 6]
const RUNS_SHOWN = 10

type Draft = {
  name: string
  prompt: string
  agentId: AgentId
  workspace: string
  preset: Preset
  time: string
  dayOfWeek: number
  custom: string
  precheck: string
  precheckTimeout: number
  grace: number
  enabled: boolean
}
type Target = { projectId: string; worktree: Worktree; label: string }

const pad = (n: number): string => String(n).padStart(2, '0')
const hm = (time: string): [number, number] => {
  const [h, m] = time.split(':').map(Number)
  return [h || 0, m || 0]
}

/** Orca describeAutomationSchedule → 화면 글. */
export function scheduleLabel(rrule: string): string {
  const d = describeAutomationSchedule(rrule)
  const at = (h: number, m: number): string => `${pad(h)}:${pad(m)}`
  if (d.kind === 'hourly') return t('auto.sched.hourlyAt').replace('{m}', pad(d.minute))
  if (d.kind === 'daily') return t('auto.sched.dailyAt').replace('{t}', at(d.hour, d.minute))
  if (d.kind === 'weekdays') return t('auto.sched.weekdaysAt').replace('{t}', at(d.hour, d.minute))
  if (d.kind === 'weekly') return t('auto.sched.weeklyAt').replace('{d}', t(`auto.day.${d.dayOfWeek}`)).replace('{t}', at(d.hour, d.minute))
  if (d.kind === 'custom') return d.expression ? `${t('auto.preset.custom')} · ${d.expression}` : t('auto.preset.custom')
  return t('auto.sched.invalid')
}

function draftOf(a: Automation | null, first: string): Draft {
  if (!a)
    return { name: '', prompt: '', agentId: 'claude', workspace: first, preset: 'weekdays', time: AUTOMATION_DEFAULT_TIME, dayOfWeek: 1, custom: '', precheck: '', precheckTimeout: DEFAULT_AUTOMATION_PRECHECK_TIMEOUT_SECONDS, grace: AUTOMATION_DEFAULT_GRACE_MINUTES, enabled: true }
  const r = a.rrule.includes('=') ? tryParseAutomationRrule(a.rrule) : null
  return {
    name: a.name,
    prompt: a.prompt,
    agentId: a.agentId,
    workspace: a.workspaceId,
    preset: r ? r.preset : 'custom',
    time: r ? `${pad(r.hour)}:${pad(r.minute)}` : AUTOMATION_DEFAULT_TIME,
    dayOfWeek: r?.dayOfWeek ?? 1,
    custom: r ? '' : a.rrule,
    precheck: a.precheck?.command ?? '',
    precheckTimeout: a.precheck?.timeoutSeconds ?? DEFAULT_AUTOMATION_PRECHECK_TIMEOUT_SECONDS,
    grace: a.missedRunGraceMinutes,
    enabled: a.enabled
  }
}

const rruleOf = (d: Draft): string => {
  if (d.preset === 'custom') return d.custom.trim()
  const [hour, minute] = hm(d.time)
  return buildAutomationRrule({ preset: d.preset, hour, minute, dayOfWeek: d.dayOfWeek })
}

function Editor({ initial, targets, onDone }: { initial: Automation | null; targets: Target[]; onDone: () => void }): JSX.Element {
  const [d, setD] = useState<Draft>(() => draftOf(initial, targets[0]?.worktree.id ?? ''))
  const [err, setErr] = useState<string | null>(null)
  const set = (p: Partial<Draft>): void => setD((x) => ({ ...x, ...p }))
  const rrule = rruleOf(d)
  const save = async (): Promise<void> => {
    const tg = targets.find((x) => x.worktree.id === d.workspace)
    if (!tg) return setErr(t('auto.err.workspace'))
    if (!isValidAutomationSchedule(rrule)) return setErr(t('auto.sched.invalid'))
    const input: AutomationInput = {
      name: d.name,
      prompt: d.prompt,
      agentId: d.agentId,
      projectId: tg.projectId,
      workspaceId: tg.worktree.id,
      workspacePath: tg.worktree.path,
      workspaceName: tg.label,
      rrule,
      precheck: d.precheck.trim() ? { command: d.precheck.trim(), timeoutSeconds: d.precheckTimeout } : null,
      missedRunGraceMinutes: d.grace,
      enabled: d.enabled
    }
    const r = initial ? await window.ev.automations.update(initial.id, input) : await window.ev.automations.create(input)
    if (!r.ok) return setErr(r.error)
    onDone()
  }
  return (
    <div className="auto-editor" data-auto="editor">
      <label className="auto-field">
        <span>{t('auto.f.name')}</span>
        <input className="aiws-input" data-field="auto.name" value={d.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="auto-field">
        <span>{t('auto.f.prompt')}</span>
        <textarea className="aiws-input" data-field="auto.prompt" rows={4} value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} />
      </label>
      <div className="auto-grid">
        <label className="auto-field">
          <span>{t('auto.f.agent')}</span>
          <select className="aiws-input" data-field="auto.agent" value={d.agentId} onChange={(e) => set({ agentId: e.target.value as AgentId })}>
            {AGENT_IDS.map((a) => (
              <option key={a} value={a}>
                {AGENTS[a].label}
              </option>
            ))}
          </select>
        </label>
        <label className="auto-field">
          <span>{t('auto.f.workspace')}</span>
          <select className="aiws-input" data-field="auto.workspace" value={d.workspace} onChange={(e) => set({ workspace: e.target.value })}>
            {targets.map((x) => (
              <option key={x.worktree.id} value={x.worktree.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label className="auto-field">
          <span>{t('auto.f.schedule')}</span>
          <select className="aiws-input" data-field="auto.preset" value={d.preset} onChange={(e) => set({ preset: e.target.value as Preset })}>
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(`auto.preset.${p}`)}
              </option>
            ))}
          </select>
        </label>
        {d.preset === 'weekly' && (
          <label className="auto-field">
            <span>{t('auto.f.day')}</span>
            <select className="aiws-input" data-field="auto.day" value={d.dayOfWeek} onChange={(e) => set({ dayOfWeek: Number(e.target.value) })}>
              {DAYS.map((x) => (
                <option key={x} value={x}>
                  {t(`auto.day.${x}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        {d.preset !== 'custom' && (
          <label className="auto-field">
            <span>{d.preset === 'hourly' ? t('auto.f.minute') : t('auto.f.time')}</span>
            <input className="aiws-input" type="time" data-field="auto.time" value={d.time} onChange={(e) => set({ time: e.target.value })} />
          </label>
        )}
        {d.preset === 'custom' && (
          <label className="auto-field">
            <span>{t('auto.f.cron')}</span>
            <input className="aiws-input aiws-mono" data-field="auto.cron" placeholder="0 9 * * 1-5" value={d.custom} onChange={(e) => set({ custom: e.target.value })} />
          </label>
        )}
        <label className="auto-field">
          <span>{t('auto.f.grace')}</span>
          <select className="aiws-input" data-field="auto.grace" value={d.grace} onChange={(e) => set({ grace: Number(e.target.value) })} title={t('auto.f.grace.desc')}>
            {AUTOMATION_GRACE_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? t('auto.grace.none') : m < 60 ? t('auto.grace.min').replace('{n}', String(m)) : t('auto.grace.hour').replace('{n}', String(m / 60))}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="set-note">{rrule && isValidAutomationSchedule(rrule) ? scheduleLabel(rrule) : t('auto.sched.invalid')}</div>
      <label className="auto-field">
        <span>{t('auto.f.precheck')}</span>
        <input className="aiws-input aiws-mono" data-field="auto.precheck" placeholder={t('auto.f.precheck.ph')} value={d.precheck} onChange={(e) => set({ precheck: e.target.value })} />
      </label>
      <div className="set-note">{t('auto.f.precheck.desc')}</div>
      <div className="acct-foot">
        <Toggle on={d.enabled} label={t('auto.f.enabled')} onChange={(enabled) => set({ enabled })} />
        <span>{t('auto.f.enabled')}</span>
        <button type="button" className="btn pri" data-action="auto.save" onClick={() => void save()}>
          {t('auto.save')}
        </button>
        <button type="button" className="btn" data-action="auto.cancel" onClick={onDone}>
          {t('auto.cancel')}
        </button>
        {err && <span className="set-note err">{err}</span>}
      </div>
    </div>
  )
}

function RunRow({ r, onRerun }: { r: AutomationRun; onRerun: () => void }): JSX.Element {
  return (
    <div className="auto-run" data-run-status={r.status}>
      <span className="auto-run-when">{new Date(r.scheduledFor).toLocaleString('ko-KR')}</span>
      <span>{t(`auto.trigger.${r.trigger}`)}</span>
      <span className="auto-run-status">{t(`auto.status.${r.status}`)}</span>
      {r.error && <span className="set-note err">{r.error}</span>}
      {r.precheckResult && <span className="set-note">{t('auto.precheckExit').replace('{c}', String(r.precheckResult.exitCode ?? '—'))}</span>}
      {(r.status === 'dispatch_failed' || r.status === 'skipped_unavailable') && (
        <button type="button" className="btn" data-action="auto.rerun" onClick={onRerun}>
          {t('auto.rerun')}
        </button>
      )}
    </div>
  )
}

export function AutomationsPanel(): JSX.Element {
  const [st, setSt] = useState<AutomationsState>({ automations: [], runs: [] })
  const [targets, setTargets] = useState<Target[]>([])
  const [editing, setEditing] = useState<Automation | 'new' | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const dialog = useDialog()
  useEffect(() => {
    void window.ev.automations.list().then(setSt)
    const off = window.ev.automations.onChanged(setSt)
    // 이 PC 의 프로젝트만(원격 저장소는 Orca 의 여러 호스트 자동화 — 3차).
    void window.ev.repos.list().then(async (ps: Project[]) => {
      const out: Target[] = []
      for (const p of ps.filter((x) => !x.host)) {
        const r = await window.ev.worktrees.list(p.id).catch(() => null)
        if (r?.ok) for (const w of r.worktrees.filter((x) => !x.hidden)) out.push({ projectId: p.id, worktree: w, label: `${p.displayName} · ${w.displayName}` })
      }
      setTargets(out)
    })
    return off
  }, [])
  const remove = async (a: Automation): Promise<void> => {
    const ok = await dialog.ask({ title: t('auto.removeTitle'), message: t('auto.removeMsg').replace('{name}', a.name), tone: 'danger', confirmLabel: t('auto.remove'), cancelLabel: t('auto.cancel') })
    if (ok === 'confirm') await window.ev.automations.remove(a.id)
  }
  const runsOf = (id: string): AutomationRun[] =>
    st.runs
      .filter((r) => r.automationId === id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, RUNS_SHOWN)

  return (
    <div className="acct-block" data-auto="panel">
      <div className="set-note">{t('auto.note')}</div>
      {editing ? (
        <Editor key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? null : editing} targets={targets} onDone={() => setEditing(null)} />
      ) : (
        <div className="acct-foot">
          <button type="button" className="btn pri" data-action="auto.new" disabled={!targets.length} onClick={() => setEditing('new')}>
            {t('auto.new')}
          </button>
          {!targets.length && <span className="set-note">{t('auto.noTargets')}</span>}
        </div>
      )}
      {!st.automations.length && <div className="set-note">{t('auto.empty')}</div>}
      {st.automations.map((a) => {
        const last = runsOf(a.id)[0]
        return (
          <div key={a.id} className="auto-item" data-automation={a.id}>
            <div className="acct-row">
              <Toggle on={a.enabled} label={t('auto.f.enabled')} onChange={(on) => void window.ev.automations.setEnabled(a.id, on)} />
              <button type="button" className="acct-pick" data-action="auto.open" onClick={() => setOpen(open === a.id ? null : a.id)}>
                {a.name}
              </button>
              <span className="acct-usage">
                {AGENTS[a.agentId].label} · {a.workspaceName} · {scheduleLabel(a.rrule)}
                {a.enabled && a.nextRunAt < Number.MAX_SAFE_INTEGER ? ` · ${t('auto.next')} ${new Date(a.nextRunAt).toLocaleString('ko-KR')}` : ''}
                {last ? ` · ${t(`auto.status.${last.status}`)}` : ` · ${t('auto.neverRan')}`}
              </span>
              <span className="acct-actions">
                <button type="button" className="btn" data-action="auto.runNow" onClick={() => void window.ev.automations.runNow(a.id)}>
                  {t('auto.runNow')}
                </button>
                <button type="button" className="btn" data-action="auto.edit" onClick={() => setEditing(a)}>
                  {t('auto.edit')}
                </button>
                <button type="button" className="btn" data-action="auto.remove" onClick={() => void remove(a)}>
                  {t('auto.remove')}
                </button>
              </span>
            </div>
            {open === a.id && (
              <div className="auto-runs" data-auto="runs">
                {runsOf(a.id).length ? runsOf(a.id).map((r) => <RunRow key={r.id} r={r} onRerun={() => void window.ev.automations.runNow(a.id)} />) : <div className="set-note">{t('auto.neverRan')}</div>}
              </div>
            )}
          </div>
        )
      })}
      {dialog.node}
    </div>
  )
}
