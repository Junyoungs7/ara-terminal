import { useEffect, useMemo, useState } from 'react'
import type { ConnectionProfile } from '@shared/types'
import { Dropdown } from './Dropdown'
import { IconClose } from './icons'
import { t } from '../i18n'
import {
  AI_CLIS,
  AI_CLI_IDS,
  buildLaunch,
  defaultFlags,
  toggleFlag,
  type AiCliId,
  type AiCliRecent
} from '../../shared/aiCli'

// F27 AI CLI 한 번에 시작 — 접속 → 폴더 → 실행을 한 창에서 끝낸다.
//
// 이 창의 설계 원칙 하나: **저장이 전제가 되면 안 된다.** 처음 쓰는 사람이 아무것도 저장해 두지
// 않은 상태에서 열어 바로 시작할 수 있어야 하고, [최근]은 시작한 뒤에 저절로 쌓인다(그래서 이 창에는
// "저장" 버튼이 없다). 최근 항목을 눌러도 바로 실행하지 않고 **폼을 채우기만** 한다 — 폴더만 살짝
// 바꿔 쓰는 일이 잦아서다. 다시 Enter 를 누르면 시작한다.
//
// 껍데기는 Dialog 계열(.overlay/.modal/.modal-hd/.dlg-body/.modal-ft)을, 행은 설정 드로어의
// .set-row/.sr-* 를, 체크박스는 .fb-check 를 그대로 쓴다 — 새 모달 인프라를 만들지 않는다
// (AiBootstrapModal 이 F17 에서 세운 선례).

export type AiCliLaunchRequest = {
  profileId: string
  path: string
  /** 없으면 만들기 — 상위(Shell)가 sftp 로 상위 폴더부터 차례로 만든다. */
  mkdir: boolean
  cli: AiCliId
  bin?: string
  flags: string[]
  /** 화면의 "보낼 명령" 줄 **그대로**. 전송 문자열은 이것 하나뿐이다(두 번 조립하지 않는다). */
  cmd: string
}

type Props = {
  open: boolean
  profiles: ConnectionProfile[]
  recent: AiCliRecent[]
  /** 진입점이 미리 정해 준 값(폴더 우클릭·서버 우클릭). at 이 있어야 같은 값으로 두 번 열어도 반영된다. */
  prefill: { profileId?: string; path?: string; at: number } | null
  onClose: () => void
  onSubmit: (r: AiCliLaunchRequest) => void
}

type Form = { profileId: string; path: string; mkdir: boolean; cli: AiCliId; bin: string; flags: string[] }

const emptyForm: Form = { profileId: '', path: '', mkdir: true, cli: 'claude', bin: '', flags: defaultFlags('claude') }

export function AiCliModal({ open, profiles, recent, prefill, onClose, onSubmit }: Props): JSX.Element | null {
  const [form, setForm] = useState<Form>(emptyForm)

  // RDP 프로필에는 셸이 없다. type 이 없는 구버전 프로필은 전부 SSH 다(ConnTree.typeBadge 와 같은 폴백).
  const servers = useMemo(() => profiles.filter((p) => p.type !== 'rdp'), [profiles])
  const nameOf = useMemo(() => new Map(servers.map((p) => [p.id, p.name])), [servers])
  const idOfName = useMemo(() => new Map(servers.map((p) => [p.name, p.id])), [servers])

  // 열 때 채운다: 진입점이 정해 준 값 > 마지막에 쓴 조합(최근 맨 위) > 빈 폼.
  // 이래야 "Enter 두 번"이 성립한다.
  const at = prefill?.at ?? 0
  useEffect(() => {
    if (!open) return
    const last = recent.find((r) => nameOf.has(r.profileId))
    const base: Form = last
      ? { profileId: last.profileId, path: last.path, mkdir: true, cli: last.cli, bin: last.bin ?? '', flags: last.flags }
      : { ...emptyForm, profileId: servers[0]?.id ?? '' }
    setForm({
      ...base,
      ...(prefill?.profileId && nameOf.has(prefill.profileId) ? { profileId: prefill.profileId } : {}),
      ...(prefill?.path ? { path: prefill.path } : {})
    })
    // recent·servers 는 열려 있는 동안 바뀌어도 폼을 되돌리면 안 된다(타이핑 중에 날아간다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, at])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const spec = AI_CLIS[form.cli]
  // 미리보기 = 전송 문자열. 한 번만 만들어 화면에도 쓰고 onSubmit 에도 실어 보낸다.
  const cmd = buildLaunch({ cli: form.cli, bin: form.bin, flags: form.flags, path: form.path })
  const canStart = cmd !== null && form.profileId !== ''

  const submit = (): void => {
    if (!cmd || !canStart) return
    onSubmit({
      profileId: form.profileId,
      path: form.path.trim(),
      mkdir: form.mkdir,
      cli: form.cli,
      ...(form.cli === 'custom' ? { bin: form.bin.trim() } : {}),
      flags: form.flags,
      cmd
    })
  }

  // 최근 줄 요약 — 실제로 실행됐던 명령의 꼬리(`claude -r`). 서버가 지워졌으면 목록에서 뺀다.
  const shownRecent = recent.filter((r) => nameOf.has(r.profileId))

  return (
    <div className="overlay open dlg-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal sm aicli-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('aicli.title')}
        onKeyDown={(e) => {
          // 폼 어디서든 Enter 로 시작한다(드롭다운이 열려 있으면 그쪽이 먼저 먹는다 — stopPropagation).
          if (e.key === 'Enter' && canStart) {
            e.preventDefault()
            submit()
          }
        }}
      >
        <div className="modal-hd">
          <div className="mh-ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 17l6-6-6-6M12 19h8" />
            </svg>
          </div>
          <div>
            <h2>{t('aicli.title')}</h2>
          </div>
          <span className="x" onClick={onClose}>
            <IconClose />
          </span>
        </div>

        <div className="dlg-body">
          <div className="set-row stack">
            <div className="sr-main">
              <div className="sr-label">{t('aicli.server')}</div>
            </div>
            <div className="sr-ctl">
              {servers.length === 0 ? (
                <span className="aicli-none">{t('aicli.noServer')}</span>
              ) : (
                <Dropdown
                  value={nameOf.get(form.profileId) ?? ''}
                  options={servers.map((p) => p.name)}
                  ariaLabel={t('aicli.server')}
                  onChange={(name) => setForm((f) => ({ ...f, profileId: idOfName.get(name) ?? f.profileId }))}
                />
              )}
            </div>
          </div>

          <div className="set-row stack">
            <div className="sr-main">
              <div className="sr-label">{t('aicli.path')}</div>
            </div>
            <div className="sr-ctl">
              <input
                className="dlg-input"
                type="text"
                autoFocus
                spellCheck={false}
                placeholder={t('aicli.path.placeholder')}
                value={form.path}
                onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
              />
              <label className="fb-check aicli-chk">
                <input
                  type="checkbox"
                  checked={form.mkdir}
                  onChange={(e) => setForm((f) => ({ ...f, mkdir: e.target.checked }))}
                />
                {t('aicli.mkdir')}
              </label>
            </div>
          </div>

          <div className="set-row stack">
            <div className="sr-main">
              <div className="sr-label">{t('aicli.cli')}</div>
            </div>
            <div className="sr-ctl">
              <Dropdown
                value={t('aicli.cli.' + form.cli)}
                options={AI_CLI_IDS.map((id) => t('aicli.cli.' + id))}
                ariaLabel={t('aicli.cli')}
                onChange={(label) => {
                  const id = AI_CLI_IDS.find((x) => t('aicli.cli.' + x) === label) ?? 'claude'
                  setForm((f) => ({ ...f, cli: id, flags: defaultFlags(id) }))
                }}
              />
              {form.cli === 'custom' && (
                <input
                  className="dlg-input aicli-bin"
                  type="text"
                  spellCheck={false}
                  placeholder={t('aicli.bin.placeholder')}
                  value={form.bin}
                  onChange={(e) => setForm((f) => ({ ...f, bin: e.target.value }))}
                />
              )}
              {spec.flags.map((fl) => (
                <label className="fb-check aicli-chk" key={fl.id}>
                  <input
                    type="checkbox"
                    data-flag={fl.id}
                    checked={form.flags.includes(fl.id)}
                    onChange={() => setForm((f) => ({ ...f, flags: toggleFlag(f.cli, f.flags, fl.id) }))}
                  />
                  {t(fl.labelKey)}
                  <code className="aicli-arg">{fl.arg}</code>
                </label>
              ))}
            </div>
          </div>

          {/* 무엇이 실행되는지 감추지 않는다 — 이 줄이 곧 전송 문자열이다. */}
          <div className="aicli-preview">
            <div className="sr-label">{t('aicli.preview')}</div>
            <pre className={'aicli-cmd' + (cmd === null ? ' bad' : '')}>{cmd ?? t('aicli.preview.invalid')}</pre>
          </div>

          {shownRecent.length > 0 && (
            <div className="aicli-recent">
              <div className="sr-label">{t('aicli.recent')}</div>
              {shownRecent.map((r, i) => (
                <div
                  key={`${r.profileId}:${r.path}:${i}`}
                  className="aicli-rrow"
                  title={t('aicli.recent.hint')}
                  onClick={() =>
                    setForm((f) => ({ ...f, profileId: r.profileId, path: r.path, cli: r.cli, bin: r.bin ?? '', flags: r.flags }))
                  }
                >
                  <span className="ar-srv">{nameOf.get(r.profileId)}</span>
                  <span className="ar-path">{r.path}</span>
                  <span className="ar-cmd">
                    {[AI_CLIS[r.cli].bin || r.bin, ...AI_CLIS[r.cli].flags.filter((f) => r.flags.includes(f.id)).map((f) => f.arg)].join(' ')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-ft">
          <span className="sp" />
          <button type="button" className="btn sec" onClick={onClose}>
            {t('dlg.cancel')}
          </button>
          <button type="button" className="btn pri" data-action="aicli.start" disabled={!canStart} onClick={submit}>
            {t('aicli.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
