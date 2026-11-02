// 3차 R1-B 새 탭 옴니박스 — 탭 줄 [+] 에서 열린 탭·파일·URL·에이전트를 한 칸으로 찾는다. AgentPane 이 lazy 로 부른다([+]를 처음 누를 때).
// 출처: stablyai/orca @ec112c6b01 (MIT) components/tab-bar/TabBarCreateEntry.tsx·tab-create-entry-classifier.ts·tab-create-entry-forced-search.ts·
// tab-create-entry-url-classification.ts, docs model/quick-open.mdx#new-tab-omnibox:
//  · 자리표시 "열린 탭, 파일, URL, 에이전트 검색…" · 파일 줄은 빠른 열기와 같은 모양(이름 먼저)
//  · 이미 열린 파일은 파일 줄 대신 그 탭(같은 파일을 두 번 열지 않는다)
//  · 한 낱말이면 파일이 먼저, 여러 낱말이면 웹 검색 줄이 위로, `?` 로 시작하면 곧장 검색.
// 아라 차이: URL·검색은 바깥 브라우저로 연다(AI 작업 공간 안 브라우저가 아직 없다 — ai-browser 이식 때 그쪽으로). 검색 엔진 = Orca 기본값 Google(docView.OMNIBOX_SEARCH_URL).
// [에이전트 고르기…] 줄 = 예전 [+] 피커(첫 지시·모델·권한) 그대로.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Bot, FileText, Globe, MessageSquare, Search, Sparkles } from 'lucide-react'
import { AGENT_IDS, AGENTS, type AgentId } from '@shared/agents'
import { rankQuickOpen } from '@shared/codeSearch'
import { OMNIBOX_SEARCH_URL, omniboxPrefersSearch, omniboxUrlOf, parseOmniboxQuery } from '@shared/docView'
import type { Worktree } from '@shared/worktrees'
import { t } from '../../i18n'
import { openFile, useCodeStore } from './codeStore'
import { useAgentStore } from './agentStore'
import { useDiffStore } from './diffStore'
import { hostOfWorktree } from './store'

type Row = { key: string; icon: typeof Bot; label: string; sub?: string; run: () => void | Promise<unknown> }

const FILE_ROWS = 8
/** 줄 실행이 실패해 창을 열어 둔다(이유를 보이게). */
const KEEP = 'keep'
const relOf = (root: string, p: string): string => p.slice(root.replace(/[\\/]+$/, '').length).replace(/\\/g, '/').replace(/^\/+/, '')

export default function NewTabOmnibox({ worktree, onClose, onPick }: { worktree: Worktree; onClose: () => void; onPick: () => void }): JSX.Element {
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const [files, setFiles] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const tabs = useAgentStore((s) => s.tabs).filter((x) => x.worktreeId === worktree.id)
  const detected = useAgentStore((s) => s.detected)
  const settings = useAgentStore((s) => s.settings)
  const openFiles = useCodeStore((s) => s.files).filter((f) => f.worktreeId === worktree.id)
  const recent = useCodeStore((s) => s.recentByWorktree[worktree.id])

  useEffect(() => {
    let live = true
    void window.ev.code.listFiles(worktree.path, hostOfWorktree(worktree.id)).then((r) => live && setFiles(r.ok ? r.files : []))
    if (!detected) void useAgentStore.getState().loadAgents()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree.id, worktree.path])

  const rows = useMemo((): Row[] => {
    const { forced, query } = parseOmniboxQuery(q)
    const lq = query.toLowerCase()
    const search: Row | null = query ? { key: 'search', icon: Search, label: t('omni.search').replace('{q}', query), run: () => window.ev.oriel.open(OMNIBOX_SEARCH_URL + encodeURIComponent(query)) } : null
    if (forced) return search ? [search] : []
    const url = omniboxUrlOf(query)
    const urlRow: Row | null = url ? { key: 'url', icon: Globe, label: t('omni.url').replace('{url}', url), run: () => window.ev.oriel.open(url) } : null
    const show = (sid: string): void => {
      useCodeStore.getState().setActive(worktree.id, null)
      useDiffStore.getState().setShown(worktree.id, false)
      useAgentStore.getState().setActiveTab(worktree.id, sid)
    }
    const tabRows: Row[] = [
      ...tabs.map((x) => ({ key: 'tab:' + x.sessionId, icon: MessageSquare, label: AGENTS[x.agent].label, sub: x.prompt ?? x.line, run: () => show(x.sessionId) })),
      ...openFiles.map((f) => ({
        key: 'file-tab:' + f.path,
        icon: FileText,
        label: f.path.split(/[\\/]/).pop() ?? f.path,
        sub: relOf(f.root, f.path),
        run: () => {
          useDiffStore.getState().setShown(worktree.id, false)
          useCodeStore.getState().setActive(worktree.id, f.path)
        }
      }))
    ].filter((r) => !lq || (r.label + ' ' + (r.sub ?? '')).toLowerCase().includes(lq))
    const openRel = new Set(openFiles.map((f) => relOf(f.root, f.path)))
    const fileRows: Row[] = query
      ? rankQuickOpen(query, files ?? [], recent ?? [])
          .filter((p) => !openRel.has(p))
          .slice(0, FILE_ROWS)
          .map((p) => {
            const cut = p.lastIndexOf('/')
            return { key: 'file:' + p, icon: FileText, label: p.slice(cut + 1), sub: cut > 0 ? p.slice(0, cut) : undefined, run: () => openFile(p).then((r) => (r.ok ? undefined : (setErr(r.message), KEEP))) }
          })
      : []
    const agentRows: Row[] = AGENT_IDS.filter((id) => settings?.agents[id].enabled !== false && detected?.find((d) => d.id === id)?.installed)
      .filter((id) => !lq || AGENTS[id].label.toLowerCase().includes(lq) || id.includes(lq))
      .map((id: AgentId) => ({
        key: 'agent:' + id,
        icon: Bot,
        label: t('omni.agent').replace('{agent}', AGENTS[id].label),
        run: () =>
          useAgentStore
            .getState()
            .launchAgent({ agent: id, worktreeId: worktree.id, cwd: worktree.path })
            .then((r) => {
              useCodeStore.getState().setActive(worktree.id, null)
              if (!r.ok) onPick()
            })
      }))
    const pick: Row = { key: 'pick', icon: Sparkles, label: t('omni.pick'), run: onPick }
    const lead = [urlRow, search && omniboxPrefersSearch(query) ? search : null].filter((r): r is Row => r !== null)
    const trail = search && !omniboxPrefersSearch(query) ? [search] : []
    return [...lead, ...tabRows, ...fileRows, ...agentRows, ...trail, pick]
  }, [q, tabs, openFiles, files, recent, detected, settings, worktree, onPick])

  useEffect(() => setCursor(0), [q])
  useEffect(() => {
    listRef.current?.querySelector('.qo-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const run = async (r: Row | undefined): Promise<void> => {
    if (!r) return
    if ((await r.run()) !== KEEP) onClose()
  }

  return (
    <>
      <div
        className="qo-scrim"
        onMouseDown={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div className="qo-drop" role="dialog" aria-label={t('omni.title')} data-aiws="omnibox">
        <div className="qo-head">
          <Search aria-hidden />
          <input
            autoFocus
            type="text"
            data-field="omnibox"
            aria-label={t('omni.title')}
            spellCheck={false}
            placeholder={t('omni.placeholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setErr(null)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = rows.length
                if (n) setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void run(rows[cursor])
              }
            }}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div className="qo-list" ref={listRef} role="listbox">
          {err && <div className="qo-empty">{err}</div>}
          {rows.map((r, i) => (
            <div
              key={r.key}
              className={'qo-item' + (i === cursor ? ' on' : '')}
              data-omni={r.key}
              role="option"
              aria-selected={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void run(r)}
            >
              <r.icon aria-hidden />
              <span className="qo-name">{r.label}</span>
              {r.sub && <span className="qo-dir">{r.sub}</span>}
            </div>
          ))}
        </div>
        {files === null && <div className="qo-foot">{t('qo.loading')}</div>}
      </div>
    </>
  )
}
