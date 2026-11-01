import { useCallback, useEffect, useState, type JSX } from 'react'
import { AGENTS } from '@shared/agents'
import { pathKey, type VaultDetail, type VaultSession } from '@shared/vault'
import type { Worktree } from '@shared/worktrees'
import { t } from '../../i18n'
import { writeClipboard } from '../../store/clipboardWrite'
import { useAiwsStore } from './store'
import { useAgentStore } from './agentStore'

/**
 * M4 AI-07 지난 에이전트 세션 — Orca right-sidebar AiVaultPanel·AiVaultSessionRow·AiVaultSessionDetails(orcaRef fdfcfb3551)의 1차:
 * 목록(에이전트 · 워크트리/폴더 · 시각 · 첫 지시) → 줄을 고르면 상세(메타 · 최근 몇 턴) + [재개] [재개 명령 복사] [첫 지시 복사].
 * 재개 = 그 워크트리에 에이전트 탭을 새로 띄운다(M3 실행 경로 — agents:launch resume). 아는 워크트리가 아닌 폴더는 복사만.
 * 자리: 왼쪽 AI 레일 [지난 세션] → 가운데(Orca 는 오른쪽 사이드바 — 아라는 "목록은 왼쪽, 오른쪽 레일은 하나만"(shared/types.ts RAIL_IDS)).
 * 뺀 것(2차): 범위·에이전트 필터·전문 검색·삭제·하위 에이전트·가상 스크롤.
 */
export function VaultPanel(): JSX.Element {
  const byRepo = useAiwsStore((s) => s.worktreesByRepo)
  const repos = useAiwsStore((s) => s.repos)
  const [list, setList] = useState<VaultSession[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [detail, setDetail] = useState<VaultDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const worktrees = Object.values(byRepo).flat()
  const wtOf = (cwd: string | null): Worktree | undefined => (cwd ? worktrees.find((w) => pathKey(w.path) === pathKey(cwd)) : undefined)
  const cwdsKey = worktrees.map((w) => w.path).join('\n')

  // 화면을 열 때(그리고 아는 폴더가 바뀔 때·새로 고침) 읽는다 — 감시는 없다.
  const load = useCallback(async () => {
    setLoading(true)
    try {
      setList(await window.ev.vault.list(cwdsKey ? cwdsKey.split('\n') : []))
    } finally {
      setLoading(false)
    }
  }, [cwdsKey])
  useEffect(() => void load(), [load])

  const pick = async (s: VaultSession): Promise<void> => {
    setError(null)
    if (picked === s.file) {
      setPicked(null)
      return
    }
    setPicked(s.file)
    setDetail(null)
    setDetail(await window.ev.vault.detail(s.file))
  }

  const resume = async (s: VaultSession, w: Worktree): Promise<void> => {
    setError(null)
    const r = await useAgentStore.getState().launchAgent({ agent: s.agent, worktreeId: w.id, cwd: w.path, resume: s.id })
    if (!r.ok) {
      setError(r.error)
      return
    }
    useAiwsStore.getState().setActiveWorktree(w.id)
    useAgentStore.getState().setView('worktree')
  }

  const copyResume = async (s: VaultSession): Promise<void> => {
    const r = await window.ev.vault.resumeCommand(s.agent, s.id, s.cwd)
    if (r.ok) await writeClipboard(r.text, true)
    else setError(r.error)
  }

  const where = (s: VaultSession): string => {
    const w = wtOf(s.cwd)
    if (w) return `${repos.find((r) => r.id === w.repoId)?.displayName ?? ''} / ${w.displayName}`
    return s.cwd ?? t('aiws.vault.noCwd')
  }

  return (
    <div className="aiws-board" role="region" aria-label={t('aiws.nav.sessions')} data-aiws="sessions">
      <div className="aiws-vault-head">
        <h2 className="aiws-new-ttl">{t('aiws.nav.sessions')}</h2>
        <button type="button" className="btn sec" data-aiws="vault-refresh" disabled={loading} onClick={() => void load()}>
          {loading ? t('aiws.vault.loading') : t('aiws.vault.refresh')}
        </button>
      </div>
      {list === null ? (
        <p className="aiws-note">{t('aiws.vault.loading')}</p>
      ) : list.length === 0 ? (
        <p className="aiws-note">{t('aiws.vault.empty')}</p>
      ) : (
        <div className="aiws-feed" role="list">
          {list.map((s) => {
            const open = picked === s.file
            const w = wtOf(s.cwd)
            return (
              <div key={s.file} role="listitem" className="aiws-vault-item" data-vault-id={s.id} data-agent={s.agent}>
                <button type="button" className="aiws-feed-row" aria-expanded={open} title={s.file} onClick={() => void pick(s)}>
                  <b className="aiws-vault-agent">{AGENTS[s.agent].label}</b>
                  <span className="aiws-feed-t">
                    <span className="aiws-mono">{where(s)}</span> — {s.title ?? s.firstPrompt ?? t('aiws.vault.noPrompt')}
                  </span>
                  <time className="aiws-feed-at" dateTime={new Date(s.at).toISOString()}>
                    {new Date(s.at).toLocaleString()}
                  </time>
                </button>
                {open && (
                  <div className="aiws-vault-detail" data-aiws="vault-detail">
                    <dl className="aiws-vault-meta">
                      <dt>{t('aiws.vault.meta.id')}</dt>
                      <dd className="aiws-mono">{s.id}</dd>
                      <dt>{t('aiws.vault.meta.cwd')}</dt>
                      <dd className="aiws-mono">{s.cwd ?? t('aiws.vault.noCwd')}</dd>
                      <dt>{t('aiws.vault.meta.file')}</dt>
                      <dd className="aiws-mono">{s.file}</dd>
                    </dl>
                    <div className="aiws-new-foot">
                      <button
                        type="button"
                        className="btn pri"
                        data-aiws="vault-resume"
                        disabled={!w}
                        title={w ? undefined : t('aiws.vault.noWorktree')}
                        onClick={() => w && void resume(s, w)}
                      >
                        {t('aiws.vault.resume')}
                      </button>
                      <button type="button" className="btn sec" data-aiws="vault-copy-resume" onClick={() => void copyResume(s)}>
                        {t('aiws.vault.copyResume')}
                      </button>
                      <button
                        type="button"
                        className="btn sec"
                        data-aiws="vault-copy-prompt"
                        disabled={!s.firstPrompt}
                        onClick={() => s.firstPrompt && void writeClipboard(s.firstPrompt, true)}
                      >
                        {t('aiws.vault.copyPrompt')}
                      </button>
                    </div>
                    {!w && <p className="aiws-note">{t('aiws.vault.noWorktree')}</p>}
                    {error && <p className="aiws-note aiws-err">{error}</p>}
                    {detail === null || (detail.ok && detail.session.file !== s.file) ? (
                      <p className="aiws-note">{t('aiws.vault.loading')}</p>
                    ) : !detail.ok ? (
                      <p className="aiws-note aiws-err">{detail.error}</p>
                    ) : (
                      <div className="aiws-vault-turns" aria-label={t('aiws.vault.recent')}>
                        {detail.turns.map((x, i) => (
                          <p key={i} className="aiws-vault-turn" data-role={x.role}>
                            <b>{t('aiws.vault.role.' + x.role)}</b> {x.text}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
