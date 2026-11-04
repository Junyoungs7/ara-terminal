import { useCallback, useEffect, useState, type JSX } from 'react'
import { History } from 'lucide-react'
import { AGENT_IDS, AGENTS } from '@shared/agents'
import { pathKey, SEARCH_MIN_CHARS, type VaultDetail, type VaultSession } from '@shared/vault'
import type { Worktree } from '@shared/worktrees'
import { t } from '../../i18n'
import { writeClipboard } from '../../store/clipboardWrite'
import type { DialogResult, DialogSpec } from '../../components/Dialog'
import { Dropdown } from '../../components/Dropdown'
import { useAiwsStore } from './store'
import { useAgentStore } from './agentStore'
import { groupSessions, mergeSearch, VAULT_GROUPS, VAULT_SCOPES, VAULT_SORTS, vaultViewOf, viewSessions, type VaultView } from './vaultView'

type AskFn = (spec: DialogSpec) => Promise<DialogResult>
const VIEW_KEY = 'ara.aiws.vaultView'
/** 입력이 멎은 뒤 전문 검색까지(ms). */
const SEARCH_DEBOUNCE_MS = 350

function readView(): VaultView {
  try {
    return vaultViewOf(JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null'))
  } catch {
    return vaultViewOf(null)
  }
}
function writeView(v: VaultView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v))
  } catch {
    /* 저장 못 하면 다음에 기본값 */
  }
}

/**
 * M4 AI-07 지난 에이전트 세션 — Orca right-sidebar AiVaultPanel·AiVaultSessionRow·AiVaultSessionDetails(orcaRef fdfcfb3551).
 * 1차: 목록 → 줄을 고르면 상세(메타 · 최근 몇 턴) + [재개] [재개 명령 복사] [첫 지시 복사].
 * M11 2차: 범위(이 작업 단위 / 프로젝트 / 전체) · 에이전트 켜고 끄기 · 빈 세션 숨기기 · 정렬(업데이트·만든 시각) · 묶기(프로젝트·폴더·에이전트)
 * · 검색 칸(목록은 바로 거르고, 두 글자부터 전문 검색 — main 의 utility process) · 삭제(확인 → 휴지통).
 * 자리: 왼쪽 AI 레일 [지난 세션] → 가운데(Orca 는 오른쪽 사이드바 — 아라는 "목록은 왼쪽, 오른쪽 레일은 하나만"(shared/types.ts RAIL_IDS)).
 * 뺀 것: 하위 에이전트 목록·가상 스크롤·스캔 진행 띠·세션 수 제한 메뉴·검색 결과 관련도 정렬.
 */
export function VaultPanel({ ask }: { ask: AskFn }): JSX.Element {
  const byRepo = useAiwsStore((s) => s.worktreesByRepo)
  const repos = useAiwsStore((s) => s.repos)
  const activeId = useAiwsStore((s) => s.activeWorktreeId)
  const [list, setList] = useState<VaultSession[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [detail, setDetail] = useState<VaultDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setViewState] = useState<VaultView>(readView)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<VaultSession[]>([])
  const [searching, setSearching] = useState(false)
  const [searchNote, setSearchNote] = useState<string | null>(null)
  const setView = (v: VaultView): void => {
    setViewState(v)
    writeView(v)
  }

  const worktrees = Object.values(byRepo).flat()
  const wtOf = (cwd: string | null): Worktree | undefined => (cwd ? worktrees.find((w) => pathKey(w.path) === pathKey(cwd)) : undefined)
  const cwdsKey = worktrees.map((w) => w.path).join('\n')
  const active = worktrees.find((w) => w.id === activeId)
  // 범위 폴더: 이 작업 단위 = 그 폴더, 프로젝트 = 그 프로젝트의 작업 단위 전부. 고른 작업 단위가 없으면 전체.
  const scopePaths = !active || view.scope === 'all' ? null : view.scope === 'worktree' ? [active.path] : (byRepo[active.repoId] ?? []).map((w) => w.path)

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

  // 전문 검색 — 입력이 멎으면 main 에 묻는다(새 검색이 앞 것을 끊는다).
  useEffect(() => {
    const q = query.trim()
    setSearchNote(null)
    if (q.length < SEARCH_MIN_CHARS) {
      setHits([])
      setSearching(false)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      setSearching(true)
      void window.ev.vault.search(q, cwdsKey ? cwdsKey.split('\n') : []).then((r) => {
        if (!alive) return
        setSearching(false)
        if (r.ok) {
          setHits(r.sessions)
          if (r.truncated) setSearchNote(t('aiws.vault.search.truncated').replace('{n}', String(r.scanned)))
        } else if (r.error !== 'superseded') setSearchNote(r.error)
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, cwdsKey])

  const shown = viewSessions(mergeSearch(list ?? [], hits), view, scopePaths, query)

  const where = (s: VaultSession): string => {
    const w = wtOf(s.cwd)
    if (w) return `${repos.find((r) => r.id === w.repoId)?.displayName ?? ''} / ${w.displayName}`
    return s.cwd ?? t('aiws.vault.noCwd')
  }
  const groups = groupSessions(shown, (s) => {
    if (view.group === 'agent') return { key: s.agent, label: AGENTS[s.agent].label }
    if (view.group === 'folder') return { key: s.cwd ? pathKey(s.cwd) : '', label: s.cwd ?? t('aiws.vault.noCwd') }
    const w = wtOf(s.cwd)
    const repo = w ? repos.find((r) => r.id === w.repoId) : undefined
    return repo ? { key: repo.id, label: repo.displayName } : { key: '', label: t('aiws.vault.group.other') }
  })

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
    const r = await useAgentStore.getState().launchAgent({ agent: s.agent, worktreeId: w.id, cwd: w.path, resume: s.id, ...(s.title ? { vaultTitle: s.title } : {}) })
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

  // Orca: 확인 뒤 휴지통으로(기록 파일 + claude 의 딸린 폴더).
  const remove = async (s: VaultSession): Promise<void> => {
    const yes = await ask({
      title: t('aiws.vault.delete.title'),
      message: t('aiws.vault.delete.msg'),
      detail: [{ label: t('aiws.vault.meta.file'), value: s.file }],
      tone: 'danger',
      confirmLabel: t('aiws.vault.delete')
    })
    if (yes !== 'confirm') return
    const r = await window.ev.vault.delete(s.file)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setPicked(null)
    setList((l) => l?.filter((x) => x.file !== s.file) ?? l)
    setHits((h) => h.filter((x) => x.file !== s.file))
  }

  const toggleAgent = (id: (typeof AGENT_IDS)[number]): void => setView({ ...view, agents: view.agents.includes(id) ? view.agents.filter((x) => x !== id) : AGENT_IDS.filter((x) => x === id || view.agents.includes(x)) })

  return (
    <div className="aiws-board" role="region" aria-label={t('aiws.nav.sessions')} data-aiws="sessions">
      <div className="aiws-vault-head">
        <h2 className="aiws-new-ttl">{t('aiws.nav.sessions')}</h2>
        <span className="aiws-note" data-aiws="vault-count">
          {t('aiws.vault.count').replace('{shown}', String(shown.length)).replace('{all}', String(list?.length ?? 0))}
        </span>
        <button type="button" className="btn sec" data-aiws="vault-refresh" disabled={loading} onClick={() => void load()}>
          {loading ? t('aiws.vault.loading') : t('aiws.vault.refresh')}
        </button>
      </div>
      <div className="aiws-vault-controls" data-aiws="vault-controls">
        <div className="seg-ctl" role="radiogroup" aria-label={t('aiws.vault.scope')}>
          {VAULT_SCOPES.map((sc) => (
            <button key={sc} type="button" role="radio" aria-checked={view.scope === sc} className={view.scope === sc ? 'on' : undefined} data-vault-scope={sc} onClick={() => setView({ ...view, scope: sc })}>
              {t('aiws.vault.scope.' + sc)}
            </button>
          ))}
        </div>
        <input className="aiws-input" type="search" data-aiws="vault-search" placeholder={t('aiws.vault.searchPh')} value={query} onChange={(e) => setQuery(e.target.value)} />
        {/* C#8 OS <select> 대신 공용 Dropdown(앱 목록 모양·앰버 선택). */}
        <div className="aiws-pill aiws-pill-dd" data-aiws="vault-sort">
          <span>{t('aiws.vault.sort')}</span>
          <Dropdown
            ariaLabel={t('aiws.vault.sort')}
            value={t('aiws.vault.sort.' + view.sort)}
            options={VAULT_SORTS.map((x) => t('aiws.vault.sort.' + x))}
            onChange={(v) => setView({ ...view, sort: VAULT_SORTS.find((x) => t('aiws.vault.sort.' + x) === v) ?? view.sort })}
          />
        </div>
        <div className="aiws-pill aiws-pill-dd" data-aiws="vault-group">
          <span>{t('aiws.vault.group')}</span>
          <Dropdown
            ariaLabel={t('aiws.vault.group')}
            value={t('aiws.vault.group.' + view.group)}
            options={VAULT_GROUPS.map((x) => t('aiws.vault.group.' + x))}
            onChange={(v) => setView({ ...view, group: VAULT_GROUPS.find((x) => t('aiws.vault.group.' + x) === v) ?? view.group })}
          />
        </div>
        <div className="aiws-vault-agents" role="group" aria-label={t('aiws.vault.agents')}>
          {AGENT_IDS.map((id) => (
            <label key={id} className="aiws-pill">
              <input type="checkbox" data-vault-agent={id} checked={view.agents.includes(id)} onChange={() => toggleAgent(id)} />
              <span>{AGENTS[id].label}</span>
            </label>
          ))}
          <label className="aiws-pill">
            <input type="checkbox" data-aiws="vault-hide-empty" checked={view.hideEmpty} onChange={(e) => setView({ ...view, hideEmpty: e.target.checked })} />
            <span>{t('aiws.vault.hideEmpty')}</span>
          </label>
        </div>
      </div>
      {!active && view.scope !== 'all' && <p className="aiws-note">{t('aiws.vault.scope.noActive')}</p>}
      {(searching || searchNote) && <p className="aiws-note" data-aiws="vault-search-state">{searching ? t('aiws.vault.searching') : searchNote}</p>}
      {list === null ? (
        <p className="aiws-note">{t('aiws.vault.loading')}</p>
      ) : view.agents.length === 0 ? (
        <p className="aiws-note">{t('aiws.vault.noAgents')}</p>
      ) : shown.length === 0 ? (
        list.length === 0 ? (
          // C#19 빈 상태 = 가운데 아이콘 + 제목 + 안내(AI 첫 화면과 같은 문법). 검색·필터로 0건은 한 줄 그대로.
          <div className="aiws-empty">
            <History className="aiws-home-ic" aria-hidden />
            <b>{t('aiws.vault.emptyTitle')}</b>
            <span>{t('aiws.vault.empty')}</span>
          </div>
        ) : (
          <p className="aiws-note">{t('aiws.vault.noMatch')}</p>
        )
      ) : (
        groups.map((g) => (
          <section key={g.key} className="aiws-vault-group" data-vault-group={g.key}>
            <h3 className="aiws-vault-group-t">
              {g.label} <span className="aiws-note">{g.items.length}</span>
            </h3>
            <div className="aiws-feed" role="list">
              {g.items.map((s) => {
                const open = picked === s.file
                const w = wtOf(s.cwd)
                return (
                  <div key={s.file} role="listitem" className="aiws-vault-item" data-vault-id={s.id} data-agent={s.agent}>
                    <button type="button" className="aiws-feed-row" aria-expanded={open} title={s.file} onClick={() => void pick(s)}>
                      <b className="aiws-vault-agent">{AGENTS[s.agent].label}</b>
                      <span className="aiws-feed-t">
                        <span className="aiws-mono">{where(s)}</span> — {s.title ?? s.firstPrompt ?? t('aiws.vault.noPrompt')}
                        {s.snippet && (
                          <span className="aiws-vault-snippet" data-aiws="vault-snippet">
                            {s.snippet}
                          </span>
                        )}
                      </span>
                      <time className="aiws-feed-at" dateTime={new Date(view.sort === 'created' ? (s.createdAt ?? s.at) : s.at).toISOString()}>
                        {new Date(view.sort === 'created' ? (s.createdAt ?? s.at) : s.at).toLocaleString()}
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
                          <button type="button" className="btn sec" data-aiws="vault-delete" onClick={() => void remove(s)}>
                            {t('aiws.vault.delete')}
                          </button>
                          <button type="button" className="btn pri" data-aiws="vault-resume" disabled={!w} title={w ? undefined : t('aiws.vault.noWorktree')} onClick={() => w && void resume(s, w)}>
                            {t('aiws.vault.resume')}
                          </button>
                          <button type="button" className="btn sec" data-aiws="vault-copy-resume" onClick={() => void copyResume(s)}>
                            {t('aiws.vault.copyResume')}
                          </button>
                          <button type="button" className="btn sec" data-aiws="vault-copy-prompt" disabled={!s.firstPrompt} onClick={() => s.firstPrompt && void writeClipboard(s.firstPrompt, true)}>
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
          </section>
        ))
      )}
    </div>
  )
}
