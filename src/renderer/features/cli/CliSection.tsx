// M14 R2 `ara` CLI — 설정 › 스킬 맨 위 블록. Orca Settings › General › Orca CLI(등록·제거) + Skills 의 번들 스킬 [설치]의 아라 몫.
// 전역 설정(사용자 PATH)·사용자 스킬 폴더에 쓰는 것은 버튼을 눌렀을 때만. PATH 등록은 확인 창에서 넣을 폴더를 먼저 보여 준다.
import { useCallback, useEffect, useState, type JSX } from 'react'
import type { BundledSkillStatus, CliInstallStatus } from '@shared/araCli'
import { t } from '../../i18n'
import { useDialog } from '../../components/Dialog'

const TARGET_LABEL: Record<string, string> = { 'home-claude': 'Claude', 'home-agents': 'Codex·Gemini' }

export function CliSection({ onSkillInstalled }: { onSkillInstalled?: () => void }): JSX.Element {
  const [cli, setCli] = useState<CliInstallStatus | null>(null)
  const [skill, setSkill] = useState<BundledSkillStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const dialog = useDialog()
  const load = useCallback(() => {
    void window.ev.cli.status().then(setCli)
    void window.ev.cli.skillStatus().then(setSkill)
  }, [])
  useEffect(load, [load])

  const toggle = async (): Promise<void> => {
    if (!cli?.binDir) return
    const adding = cli.state !== 'installed'
    const ok = await dialog.ask({
      title: t(adding ? 'cli.install.title' : 'cli.uninstall.title'),
      message: t(adding ? 'cli.install.msg' : 'cli.uninstall.msg').replace('{dir}', cli.binDir),
      confirmLabel: t(adding ? 'cli.install' : 'cli.uninstall'),
      cancelLabel: t('auto.cancel')
    })
    if (ok !== 'confirm') return
    setBusy(true)
    try {
      setCli(await (adding ? window.ev.cli.install() : window.ev.cli.uninstall()))
      setMsg(null)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const installSkill = async (rootId: string): Promise<void> => {
    const r = await window.ev.cli.skillInstall(rootId)
    setMsg(r.ok ? t('cli.skill.done').replace('{path}', r.path) : r.error)
    load()
    onSkillInstalled?.()
  }

  const stateText = cli ? t(`cli.state.${cli.state}`) : t('usage.loading')
  return (
    <div className="acct-block" data-cli="panel" data-item="cli.install">
      <div className="acct-title">{t('cli.title')}</div>
      <div className="set-note">{t('cli.note')}</div>
      <div className="acct-row" data-cli-state={cli?.state ?? 'loading'}>
        <span className="acct-name">ara</span>
        <span className="acct-usage" title={cli?.binDir ?? undefined}>
          {stateText}
          {cli?.detail ? ` — ${cli.detail}` : ''}
        </span>
        <span className="acct-actions">
          <button type="button" className="btn sec" data-action="cli.toggle" disabled={busy || !cli || cli.state === 'unsupported' || cli.state === 'unknown'} onClick={() => void toggle()}>
            {t(cli?.state === 'installed' ? 'cli.uninstall' : 'cli.install')}
          </button>
        </span>
      </div>
      {cli?.shadowedBy && (
        <div className="set-note err" data-cli="shadowed">
          {t('cli.shadowed').replace('{path}', cli.shadowedBy)}
        </div>
      )}
      <div className="acct-title">{t('cli.skill.title')}</div>
      <div className="set-note">{t('cli.skill.note')}</div>
      {skill && !skill.available && <div className="set-note">{t('cli.skill.none')}</div>}
      {skill?.available &&
        skill.targets.map((x) => (
          <div key={x.rootId} className="acct-row" data-cli-skill={x.rootId} data-state={x.state}>
            <span className="acct-name">{TARGET_LABEL[x.rootId] ?? x.rootId}</span>
            <span className="acct-usage" title={x.path}>
              {t(`cli.skill.${x.state}`)} · {x.path}
            </span>
            <span className="acct-actions">
              <button type="button" className="btn sec" data-action="cli.skill.install" disabled={x.state === 'installed'} onClick={() => void installSkill(x.rootId)}>
                {t(x.state === 'differs' ? 'cli.skill.update' : 'cli.skill.install')}
              </button>
            </span>
          </div>
        ))}
      {msg && <div className="set-note">{msg}</div>}
      {dialog.node}
    </div>
  )
}
