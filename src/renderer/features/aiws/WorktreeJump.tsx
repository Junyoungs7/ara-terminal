// M12 CV-03 워크트리 점프(Ctrl+Shift+J, 맥 Cmd+Shift+J — M12 R2 키 정리) — AI 작업 공간에서만. 빠른 열기(Ctrl+P)와 같은 틀(.qo-*)에 작업 단위 목록.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/renderer/src/components/WorktreeJumpPalette.tsx·lib/order-empty-query-worktrees.ts(빈 검색 =
// 지금 것을 빼고, 다녀간 것이 최근 순으로 먼저, 나머지는 이름 순)·lib/worktree-palette-search.ts(이름·브랜치·저장소·호스트로 찾기).
// 뺀 것: 작업(Task)·열린 탭·브라우저 줄, 필터 칩, 새 워크트리 만들기 줄, 숫자 키 바로가기.
// 키(M12 R2 메인 결정): Orca 키 Ctrl+Shift+J(KEYMAP worktree.jump, space 'ai'). 같은 조합은 터미널 공간에서만 하단 패널(bottom.toggle).
// Ctrl+J 단독은 잡지 않는다 — 에이전트 터미널로 넘어가 Claude Code 줄바꿈이 된다(R1 때 가로채던 것).
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { GitBranch, Search } from 'lucide-react'
import type { Worktree } from '@shared/worktrees'
import { isMac } from '@shared/keymap'
import { t } from '../../i18n'
import { useAgentStore } from './agentStore'
import { shortBranch } from './sidebarRows'
import { jumpList } from './jumpList'
import { useAiwsStore } from './store'

/** 작업 단위별 마지막으로 고른 때(이 창이 켜진 뒤) — Orca lastVisitedAtByWorktreeId. 재시작하면 비어 있다. */
const visited = new Map<string, number>()

export function WorktreeJump({ onJumped }: { onJumped: () => void }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const repos = useAiwsStore((s) => s.repos)
  const byRepo = useAiwsStore((s) => s.worktreesByRepo)
  const activeId = useAiwsStore((s) => s.activeWorktreeId)

  // 다녀간 때를 적는다(지금 고른 것이 바뀔 때마다).
  useEffect(() => {
    if (activeId) visited.set(activeId, Date.now())
  }, [activeId])

  // Ctrl+Shift+J(맥 Cmd+Shift+J) — 창 캡처 단계에서 에이전트 터미널·Monaco 보다 먼저(Ctrl+P 와 같은 자리). 한글 입력 상태도 e.code 로.
  // 이 컴포넌트는 AI 공간이 떠 있을 때만 붙어 있다(AiSpace) — 터미널 공간에선 Shell 의 bottom.toggle 이 같은 키를 받는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'KeyJ' || !e.shiftKey || e.altKey || !(isMac() ? e.metaKey : e.ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      setOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  useEffect(() => {
    if (!open) return
    setQ('')
    setCursor(0)
    inputRef.current?.focus()
  }, [open])

  const all = useMemo(() => Object.values(byRepo).flat(), [byRepo])
  const shown = useMemo(() => (open ? jumpList(all, repos, activeId, q, visited) : []), [open, all, repos, activeId, q])
  useEffect(() => setCursor(0), [q])
  useEffect(() => {
    listRef.current?.querySelector('.qo-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null
  const close = (): void => setOpen(false)
  const pick = (w: Worktree | undefined): void => {
    if (!w) return
    useAiwsStore.getState().setActiveWorktree(w.id)
    useAgentStore.getState().setView('worktree')
    onJumped()
    close()
  }

  return (
    <>
      <div
        className="qo-scrim"
        onMouseDown={(e) => {
          e.preventDefault()
          close()
        }}
      />
      <div
        className="qo-drop"
        role="dialog"
        aria-label={t('wj.title')}
        data-aiws="worktree-jump"
        onMouseDown={(e) => {
          if (e.target !== inputRef.current) e.preventDefault()
        }}
      >
        <div className="qo-head">
          <Search aria-hidden />
          <input
            ref={inputRef}
            type="text"
            data-field="worktree-jump"
            aria-label={t('wj.title')}
            spellCheck={false}
            placeholder={t('wj.placeholder')}
            value={q}
            onBlur={close}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyJ')) {
                e.preventDefault()
                close()
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = shown.length
                if (n) setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                pick(shown[cursor])
              }
            }}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div className="qo-list" ref={listRef}>
          {shown.length === 0 && <div className="qo-empty">{t(q.trim() ? 'wj.empty' : 'wj.none')}</div>}
          {shown.map((w, i) => {
            const repo = repos.find((r) => r.id === w.repoId)
            return (
              <div
                key={w.id}
                className={'qo-item' + (i === cursor ? ' on' : '')}
                data-worktree={w.id}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(w)}
              >
                <GitBranch aria-hidden />
                <span className="qo-name">{w.displayName}</span>
                <span className="qo-dir">{shortBranch(w)}</span>
                <span className="wj-meta">{[repo?.displayName, repo?.host].filter(Boolean).join(' · ')}</span>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
