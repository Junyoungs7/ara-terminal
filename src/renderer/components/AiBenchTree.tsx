import type { AiSessionState } from '@shared/aiSession'
import type { WorkbenchRow, WorkbenchStatus } from '../store/aiWorkbench'
import { t } from '../i18n'

/**
 * 사이드바 [AI] 탭(#129) — **내가 만들어 둔 작업대들.**
 *
 * 여기서 새로 만드는 것은 화면이 아니라 **기억**이다: 작업대는 이미 터미널 탭이고(설계 §10.6),
 * 이 목록은 "어느 서버 어느 폴더에서 무엇을 띄워 뒀나"를 껐다 켜도 들고 있는 자리다.
 *
 * 점 하나가 말하는 것(F30 이 쓰던 판정을 그대로 가져왔다 — 같은 사실을 두 곳에서 다르게 말하지 않는다):
 *  · 초록 = 돌고 있다 · 노랑 = **조용하다**(승인을 기다리는 중일 수 있다) · 회색 = 쉬는 중
 *  · 빨강 = 끊김(폴더나 서버가 사라졌다) — 조용히 다른 데서 열지 않는다
 */
const DOT: Record<WorkbenchStatus, string> = {
  live: 'ok',
  quiet: 'warn',
  idle: 'off',
  noPath: 'bad',
  noProfile: 'bad'
}

const TIP: Record<WorkbenchStatus, string> = {
  live: 'bench.st.live',
  quiet: 'bench.st.quiet',
  idle: 'bench.st.idle',
  noPath: 'bench.st.noPath',
  noProfile: 'bench.st.noProfile'
}

export function AiBenchTree({
  rows,
  activeSessionId,
  onOpen,
  onRemove
}: {
  rows: WorkbenchRow[]
  activeSessionId: string | null
  /** 살아 있으면 그 탭으로, 아니면 그 자리에서 다시 띄운다. */
  onOpen: (s: AiSessionState, sessionId: string | null) => void
  onRemove: (s: AiSessionState) => void
}): JSX.Element {
  if (rows.length === 0) {
    return <div className="bench-empty">{t('bench.empty')}</div>
  }
  return (
    <div className="bench-list" role="list">
      {rows.map((r) => {
        const dead = r.status === 'noPath' || r.status === 'noProfile'
        return (
          <div
            key={r.s.id}
            role="listitem"
            className={
              'bench-row' +
              (r.depth === 1 ? ' child' : '') +
              (r.sessionId && r.sessionId === activeSessionId ? ' on' : '') +
              (dead ? ' dead' : '')
            }
            data-bench={r.s.id}
            data-status={r.status}
            onDoubleClick={() => !dead && onOpen(r.s, r.sessionId)}
          >
            <span className={'bench-dot ' + DOT[r.status]} title={t(TIP[r.status])} />
            <button
              type="button"
              className="bench-name"
              disabled={dead}
              title={`${r.s.cwd}\n${t(TIP[r.status])}`}
              onClick={() => onOpen(r.s, r.sessionId)}
            >
              <span className="t">{r.s.title}</span>
              {/* 분리 세션은 브랜치가 곧 그 세션의 정체다 — 폴더 이름만으로는 형제들이 구분되지 않는다. */}
              {r.s.worktree && <span className="br">{r.s.worktree.branch}</span>}
              {/* 켜져 있으면 **늘 보인다**(설계 §6 확정 2) — 잊게 두지 않는다. */}
              {r.s.skipPerms && <span className="skip">{t('bench.skipPerms')}</span>}
            </button>
            <button type="button" className="bench-x" title={t('bench.remove')} onClick={() => onRemove(r.s)}>
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
