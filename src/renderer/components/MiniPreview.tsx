import { useCallback, useEffect, useRef, useState } from 'react'
import { groupColor, type Session } from '../store/sessions'
import { tailSegs, type TailSeg } from '../terminal/termRegistry'
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
/**
 * 카드에서 확대 창으로 마우스를 옮기는 동안 그 **사이 빈 자리**를 지난다. 즉시 닫으면 확대 창에
 * 닿을 방법이 없다(2026-08-22 준영님 제보 7번: "여기에 마우스를 올려도 이 창이 사라지지 않게").
 * 짧게 잡는다 — 길면 다른 카드로 옮길 때 옛 프리뷰가 남아 따라다니는 것처럼 보인다.
 */
const HOVER_GRACE_MS = 160

/**
 * ANSI 팔레트 인덱스(0~15) → 터미널이 쓰는 그 CSS 변수 (2026-08-22 준영님 제보 20번).
 *
 * **같은 토큰을 본다**: TerminalPane.ansiTheme() 이 xterm 에 넘기는 것과 한 벌이라, 프리뷰의 초록이
 * 터미널의 초록과 다를 수 없다. 두 번째 팔레트를 만들면 언젠가 갈린다.
 * 16~255(P256)와 24bit RGB 는 표를 두지 않는다 — 미리보기는 "무슨 색 계열인가"만 보면 되고,
 * 256색 표를 들이면 이 파일이 팔레트 사본이 된다. 그 경우는 기본 글자색으로 떨어뜨린다.
 */
const ANSI_VAR = [
  '--t-black',
  '--t-red',
  '--t-green',
  '--t-yellow',
  '--t-blue',
  '--t-purple',
  '--t-cyan',
  '--t-fg',
  '--t-gray',
  '--t-red-b',
  '--t-green-b',
  '--t-yellow-b',
  '--t-blue-b',
  '--t-purple-b',
  '--t-cyan-b',
  '--text-hi'
] as const

/** 한 구간의 색. 모르는 색(P256·RGB·기본)은 undefined → 부모의 글자색을 그대로 쓴다. */
function segColor(s: TailSeg): string | undefined {
  if (s.fg === undefined || s.rgb) return undefined
  const name = ANSI_VAR[s.fg]
  return name ? `var(${name})` : undefined
}

/** 색 구간들을 span 으로. 색이 없는 구간은 span 도 만들지 않는다(노드 수를 줄인다). */
function Segs({ rows }: { rows: TailSeg[][] }) {
  return (
    <>
      {rows.map((segs, y) => (
        <span key={y}>
          {segs.map((s, i) => {
            const color = segColor(s)
            return color || s.bold ? (
              <span key={i} style={{ color, fontWeight: s.bold ? 600 : undefined }}>
                {s.text}
              </span>
            ) : (
              s.text
            )
          })}
          {y < rows.length - 1 ? '\n' : ''}
        </span>
      ))}
    </>
  )
}

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
  const [snaps, setSnaps] = useState<Record<string, TailSeg[][]>>({})
  // 직전 틱 대비 출력이 바뀐 세션 — 카드가 잠깐 반짝인다("지금 뭔가 돌고 있다"를 한눈에).
  const [live, setLive] = useState<Record<string, boolean>>({})
  const [hover, setHover] = useState<{ id: string; top: number } | null>(null)
  const prev = useRef<Record<string, string>>({})

  // 닫혀 있으면 버퍼를 읽지 않는다(사이드바 [파일] 탭과 같은 규칙 — 안 보이는 패널은 일하지 않는다).
  useEffect(() => {
    if (!open) return
    const tick = () => {
      const next: Record<string, TailSeg[][]> = {}
      const changed: Record<string, boolean> = {}
      for (const s of sessions) {
        const lines = tailSegs(s.id, ZOOM_LINES)
        next[s.id] = lines
        // 바뀜 판정은 **글자만** 본다 — 색까지 넣으면 커서 깜박임 같은 것으로도 "살아 있음"이 켜진다.
        const joined = lines.map((r) => r.map((g) => g.text).join('')).join('\n')
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

  // 닫힘은 **유예를 두고** 일어난다 — 카드와 확대 창 사이 빈 자리를 지나는 동안 닫히면 안 된다.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keepOpen = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])
  const scheduleClose = useCallback(() => {
    keepOpen()
    closeTimer.current = setTimeout(() => setHover(null), HOVER_GRACE_MS)
  }, [keepOpen])
  useEffect(() => () => keepOpen(), [keepOpen]) // 언마운트 때 타이머를 남기지 않는다

  const enter = useCallback(
    (id: string, el: HTMLElement) => {
      keepOpen()
      const top = el.getBoundingClientRect().top
      setHover({ id, top: Math.max(EDGE_GAP, Math.min(top, window.innerHeight - ZOOM_MAX_H - EDGE_GAP)) })
    },
    [keepOpen]
  )

  // 확대 프리뷰는 **맨 아래가 기본**이다(준영님 확정: "미니 프리뷰 디폴트는 제일 하단을 고정").
  // 열릴 때·내용이 바뀔 때 바닥으로 붙이고, 그 뒤로 사용자가 위로 굴리는 것은 막지 않는다.
  const zoomRef = useRef<HTMLPreElement>(null)
  const zoomId = hover?.id ?? null
  const zoomRows = zoomId ? (snaps[zoomId] ?? []) : []
  // 스크롤을 바닥에 붙이는 판단은 **글자가 바뀌었을 때**만 — 색만 달라졌다고 아래로 끌어내리면
  // 위를 읽는 중에 화면이 튄다.
  const zoomText = zoomRows.map((r) => r.map((g) => g.text).join('')).join('\n')
  useEffect(() => {
    const el = zoomRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [zoomId, zoomText])

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
            onMouseLeave={scheduleClose}
          >
            <div className="mini-title">
              <span className="mini-dot" style={{ background: groupColor(s.serverKey, s.type === 'local') }} />
              <span className="mini-name">{s.title}</span>
            </div>
            {/* 터미널 축소판처럼 보이게: 어두운 화면 + 마지막 줄 끝의 깜박이는 커서. */}
            <pre className="mini-body">
              <Segs rows={(snaps[s.id] ?? []).slice(-CARD_LINES)} />
              <span className="mini-cursor" />
            </pre>
          </div>
        ))}
      </div>
      {hover && hovered && (
        // 마우스를 여기 올리면 유지된다 — 위로 굴려 앞 내용을 볼 수 있어야 하기 때문이다(제보 7번).
        <div className="mini-zoom" style={{ top: hover.top }} onMouseEnter={keepOpen} onMouseLeave={scheduleClose}>
          <div className="mini-zoom-title">{hovered.title}</div>
          <pre className="mini-zoom-body" ref={zoomRef}>
            <Segs rows={zoomRows} />
            <span className="mini-cursor" />
          </pre>
        </div>
      )}
    </div>
  )
}
