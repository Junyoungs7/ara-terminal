import { useCallback, useEffect, useRef, useState } from 'react'
import { groupColor, type Session } from '../store/sessions'
import { tailLines } from '../terminal/termRegistry'
import { t } from '../i18n'

// F15 모니터링 미니 프리뷰 — 우측 미니 사이드바(토글).
// 세션마다 카드 하나: 제목 + 버퍼 마지막 줄들의 텍스트 스냅샷(주기 갱신). 호버하면 왼쪽으로
// 확대 프리뷰가 뜨고, 클릭하면 그 세션으로 전환한다. "지금 저쪽 세션에서 뭐가 돌고 있나"를
// 탭을 옮기지 않고 보는 것이 목적이라, 갱신은 초 단위로 충분하다.
//
// 캔버스 캡처를 쓰지 않는다(termRegistry.tailLines 주석 참고): WebGL 캔버스를 세션 수만큼
// 복사하면 GPU 메모리를 그만큼 먹고, 소프트웨어 래스터 환경에서는 프레임을 잡아먹는다.

// 카드에 보이는 줄 수 / 호버 확대에 보이는 줄 수. 스냅샷은 큰 쪽으로 한 번만 뜬다.
const CARD_LINES = 6
const ZOOM_LINES = 22
const REFRESH_MS = 1500
// 확대 프리뷰 높이 상한 — shell.css .mini-zoom 의 max-height 와 같은 값(화면 밖으로 넘기지 않으려고
// 여기서 top 을 클램프한다). 값이 갈라지면 아래쪽 카드에서 프리뷰가 잘린다.
const ZOOM_MAX_H = 340
const EDGE_GAP = 8

export function MiniPreview({
  open,
  sessions,
  activeId,
  onSelect
}: {
  open: boolean
  sessions: Session[]
  activeId: string | null
  onSelect: (sessionId: string) => void
}) {
  const [snaps, setSnaps] = useState<Record<string, string[]>>({})
  // 직전 틱 대비 출력이 바뀐 세션 — 카드가 잠깐 반짝인다("지금 뭔가 돌고 있다"를 한눈에).
  const [live, setLive] = useState<Record<string, boolean>>({})
  const [hover, setHover] = useState<{ id: string; top: number } | null>(null)
  const prev = useRef<Record<string, string>>({})

  // 닫혀 있으면 버퍼를 읽지 않는다(사이드바 [파일] 탭과 같은 규칙 — 안 보이는 패널은 일하지 않는다).
  useEffect(() => {
    if (!open) return
    const tick = () => {
      const next: Record<string, string[]> = {}
      const changed: Record<string, boolean> = {}
      for (const s of sessions) {
        const lines = tailLines(s.id, ZOOM_LINES)
        next[s.id] = lines
        const joined = lines.join('\n')
        changed[s.id] = prev.current[s.id] !== undefined && prev.current[s.id] !== joined
        prev.current[s.id] = joined
      }
      setSnaps(next)
      setLive(changed)
    }
    tick()
    const timer = setInterval(tick, REFRESH_MS)
    return () => clearInterval(timer)
  }, [open, sessions])

  const enter = useCallback((id: string, el: HTMLElement) => {
    const top = el.getBoundingClientRect().top
    setHover({ id, top: Math.max(EDGE_GAP, Math.min(top, window.innerHeight - ZOOM_MAX_H - EDGE_GAP)) })
  }, [])

  if (!open) return null
  const hovered = hover ? sessions.find((s) => s.id === hover.id) : undefined

  return (
    <div className="mini-rail" role="complementary" aria-label={t('preview.title')}>
      <div className="mini-head">{t('preview.title')}</div>
      <div className="mini-list">
        {sessions.length === 0 && <div className="mini-empty">{t('preview.empty')}</div>}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={'mini-card' + (s.id === activeId ? ' active' : '') + (live[s.id] ? ' live' : '')}
            data-session={s.id}
            title={s.title}
            onClick={() => onSelect(s.id)}
            onMouseEnter={(e) => enter(s.id, e.currentTarget)}
            onMouseLeave={() => setHover((h) => (h?.id === s.id ? null : h))}
          >
            <div className="mini-title">
              <span className="mini-dot" style={{ background: groupColor(s.serverKey, s.type === 'local') }} />
              <span className="mini-name">{s.title}</span>
            </div>
            {/* 터미널 축소판처럼 보이게: 어두운 화면 + 마지막 줄 끝의 깜박이는 커서. */}
            <pre className="mini-body">
              {(snaps[s.id] ?? []).slice(-CARD_LINES).join('\n')}
              <span className="mini-cursor" />
            </pre>
          </div>
        ))}
      </div>
      {hover && hovered && (
        <div className="mini-zoom" style={{ top: hover.top }}>
          <div className="mini-zoom-title">{hovered.title}</div>
          <pre className="mini-zoom-body">
            {(snaps[hover.id] ?? []).join('\n')}
            <span className="mini-cursor" />
          </pre>
        </div>
      )}
    </div>
  )
}
