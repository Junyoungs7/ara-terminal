/**
 * 영상에 나오는 화면 조각들 — 앱 UI 를 **같은 토큰으로 다시 그린 것**이다.
 *
 * 왜 화면 녹화가 아닌가: 녹화하려면 이 PC 에 창을 띄우고 사람의 화면·포커스를 뺏어야 한다.
 * 그리고 UI 가 조금만 바뀌어도 영상만 낡는다. 코드로 그리면 팔레트를 바꿀 때 영상도 같이 바뀌고,
 * 무엇보다 **아무 방해 없이** 만들 수 있다.
 */
import React from 'react'
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, staticFile } from 'remotion'
import { C, L, MONO, UI, spot, type Region } from './theme'

/* ────────────────────────────────────────────────────────────────────────
   글꼴 — public/fonts 의 파일을 그대로 쓴다(앱이 번들한 것과 같은 Pretendard).
   ──────────────────────────────────────────────────────────────────────── */
export const Fonts: React.FC = () => (
  <style>{`
    @font-face { font-family:'Pretendard'; font-weight:400; src:url('${staticFile('fonts/Pretendard-Regular.woff2')}') format('woff2'); }
    @font-face { font-family:'Pretendard'; font-weight:700; src:url('${staticFile('fonts/Pretendard-Bold.woff2')}') format('woff2'); }
  `}</style>
)

/** 0→1 로 부드럽게 들어오는 값(각 씬 시작). */
export function useIntro(delay = 0): number {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 18 })
}

/* ── 배경 ───────────────────────────────────────────────────────────── */
export const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: C.abyss, fontFamily: UI, color: C.mid }}>
    <Fonts />
    {/* 시선을 가운데로 모으는 아주 옅은 앰버 한 점 — 제품 규칙대로 장식성 발광은 쓰지 않는다 */}
    <AbsoluteFill
      style={{
        background: `radial-gradient(60% 50% at 50% 32%, ${C.glow}, transparent 70%)`
      }}
    />
    {children}
  </AbsoluteFill>
)

/* ── 앱 창 목업 ─────────────────────────────────────────────────────── */
export type WinProps = {
  tabs?: { name: string; on?: boolean }[]
  side?: { name: string; on?: boolean; dot?: string; indent?: boolean }[]
  term?: React.ReactNode
  bottom?: { tabs: string[]; on: string; rows: (string | number)[][]; head: string[] } | null
  /** 강조할 자리. 나머지는 어두워진다. */
  focus?: Region | null
  /** 오른쪽 대화 패널을 연 모습 */
  chat?: React.ReactNode
}

const DEFAULT_TABS = [{ name: 'dev-server', on: true }, { name: 'kvt-gpu' }, { name: 'PowerShell' }]
const DEFAULT_SIDE = [
  { name: 'dev-server', on: true, dot: C.ok },
  { name: '~/vgt-erp', indent: true },
  { name: 'kvt-gpu', dot: C.info },
  { name: 'db-standby', dot: C.dim }
]

export const AppWindow: React.FC<WinProps> = ({
  tabs = DEFAULT_TABS,
  side = DEFAULT_SIDE,
  term,
  bottom = null,
  focus = null,
  chat = null
}) => {
  const { win, titlebar, sidebar, rail, tabs: tabH, status, bottom: bottomH } = L
  const grow = useIntro()
  const bodyH = win.h - titlebar
  const chatW = chat ? 470 : 0
  const mainW = win.w - sidebar - rail - chatW

  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: win.x,
          top: win.y,
          width: win.w,
          height: win.h,
          borderRadius: win.r,
          overflow: 'hidden',
          background: C.canvas,
          border: `1px solid ${C.lineStrong}`,
          boxShadow: '0 60px 140px -40px rgba(0,0,0,.95)',
          transform: `translateY(${interpolate(grow, [0, 1], [24, 0])}px)`,
          opacity: grow,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* 타이틀바 */}
        <div
          style={{
            height: titlebar,
            background: C.abyss,
            borderBottom: `1px solid ${C.line}`,
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            padding: '0 16px',
            fontSize: 15
          }}
        >
          <img src={staticFile('logo.svg')} width={22} height={22} style={{ borderRadius: 6 }} />
          <b style={{ color: C.hi, letterSpacing: '.04em' }}>A.R.A</b>
          <span style={{ display: 'flex', gap: 16, color: C.lo, fontSize: 14 }}>
            {['파일', '편집', '세션', '분할', '보기', '도움말'].map((m) => (
              <span key={m}>{m}</span>
            ))}
          </span>
          <span
            style={{
              margin: '0 auto',
              width: 340,
              height: 26,
              borderRadius: 7,
              background: C.canvas,
              border: `1px solid ${C.line}`,
              color: C.dim,
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              paddingLeft: 12
            }}
          >
            기능 · 서버 찾기
          </span>
          <span style={{ display: 'flex', gap: 9 }}>
            {['#6f6a5f', '#7d7561', '#8a6f5e'].map((c) => (
              <i key={c} style={{ width: 13, height: 13, borderRadius: '50%', background: c }} />
            ))}
          </span>
        </div>

        <div style={{ display: 'flex', height: bodyH }}>
          {/* 사이드바 */}
          <div style={{ width: sidebar, background: C.surface, borderRight: `1px solid ${C.line}`, padding: '12px 0' }}>
            <div style={{ padding: '4px 18px 12px', color: C.dim, fontSize: 12, letterSpacing: '.1em' }}>연결</div>
            {side.map((s, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: s.indent ? '5px 18px 5px 40px' : '5px 18px',
                  fontSize: 15,
                  color: s.on ? C.hi : s.indent ? C.lo : C.mid,
                  background: s.on ? C.raised : undefined,
                  boxShadow: s.on ? `inset 3px 0 0 ${C.accent}` : undefined
                }}
              >
                {s.dot && <i style={{ width: 7, height: 7, borderRadius: '50%', background: s.dot }} />}
                {s.name}
              </div>
            ))}
          </div>

          {/* 가운데 */}
          <div style={{ width: mainW, display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: tabH, display: 'flex', background: C.canvas, borderBottom: `1px solid ${C.line}` }}>
              {tabs.map((t, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '0 20px',
                    fontSize: 15,
                    color: t.on ? C.hi : C.lo,
                    background: t.on ? C.terminal : undefined,
                    boxShadow: t.on ? `inset 0 -2px 0 ${C.accent}` : undefined,
                    borderRight: `1px solid ${C.line}`
                  }}
                >
                  {t.on && <i style={{ width: 7, height: 7, borderRadius: '50%', background: C.accent }} />}
                  {t.name}
                </div>
              ))}
              <div style={{ width: 40, display: 'grid', placeItems: 'center', color: C.lo }}>＋</div>
            </div>

            <div
              style={{
                flex: 1,
                background: C.terminal,
                padding: '18px 22px',
                fontFamily: MONO,
                fontSize: 17,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
                overflow: 'hidden'
              }}
            >
              {term}
            </div>

            {bottom && (
              <div style={{ height: bottomH, background: C.canvas, borderTop: `1px solid ${C.line}` }}>
                <div style={{ display: 'flex', gap: 22, padding: '9px 18px', fontSize: 14, color: C.lo }}>
                  {bottom.tabs.map((t) => (
                    <span
                      key={t}
                      style={{
                        color: t === bottom.on ? C.hi : C.lo,
                        boxShadow: t === bottom.on ? `inset 0 -2px 0 ${C.accent}` : undefined,
                        paddingBottom: 4
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
                  <thead>
                    <tr>
                      {bottom.head.map((h) => (
                        <th
                          key={h}
                          style={{
                            textAlign: 'left',
                            padding: '7px 18px',
                            color: C.dim,
                            fontWeight: 400,
                            borderBottom: `1px solid ${C.line}`
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bottom.rows.map((r, i) => (
                      <tr key={i} style={{ background: i === 0 ? C.glow : undefined }}>
                        {r.map((cell, j) => (
                          <td
                            key={j}
                            style={{
                              padding: '7px 18px',
                              borderBottom: `1px solid ${C.line}`,
                              color: i === 0 ? C.hi : C.mid,
                              fontFamily: j === 0 || j === 2 || j === 3 ? MONO : UI
                            }}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 오른쪽 대화 패널 */}
          {chat && (
            <div style={{ width: chatW, background: C.surface, borderLeft: `1px solid ${C.line}`, padding: 18 }}>
              {chat}
            </div>
          )}

          {/* 오른쪽 아이콘 바 */}
          <div
            style={{
              width: rail,
              background: C.abyss,
              borderLeft: `1px solid ${C.line}`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 18,
              paddingTop: 16
            }}
          >
            {['◎', '✦', '⟳', '▤', '◫', '▦', '⚙'].map((g, i) => (
              <span key={i} style={{ color: i === 0 ? C.accent : C.dim, fontSize: 19 }}>
                {g}
              </span>
            ))}
          </div>
        </div>

        {/* 상태 표시줄 */}
        <div
          style={{
            height: status,
            background: C.abyss,
            borderTop: `1px solid ${C.line}`,
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            padding: '0 18px',
            color: C.dim,
            fontSize: 13
          }}
        >
          <span>● 호스트 jun@dev-server</span>
          <span>~/vgt-erp</span>
          <span style={{ marginLeft: 'auto' }}>세션 3</span>
          <span>UTF-8</span>
          <span>A.R.A v0.1.0</span>
        </div>
      </div>

      {focus && <Spotlight region={focus} />}
    </>
  )
}

/** 강조 — 화면 전체를 덮어 어둡게 하고 한 자리만 뚫는다. 시선을 말로 설명하지 않아도 된다. */
export const Spotlight: React.FC<{ region: Region }> = ({ region }) => {
  const r = spot(region)
  const t = useIntro(6)
  const pad = 6
  return (
    <>
      <AbsoluteFill
        style={{
          background: 'rgba(10,9,11,.36)',
          opacity: t,
          // 강조할 사각형만 구멍을 낸다(짝수-홀수 규칙으로 안쪽을 뺀다)
          clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0,
            ${r.x - pad}px ${r.y - pad}px,
            ${r.x - pad}px ${r.y + r.h + pad}px,
            ${r.x + r.w + pad}px ${r.y + r.h + pad}px,
            ${r.x + r.w + pad}px ${r.y - pad}px,
            ${r.x - pad}px ${r.y - pad}px)`
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: r.x - pad,
          top: r.y - pad,
          width: r.w + pad * 2,
          height: r.h + pad * 2,
          border: `2px solid ${C.accent}`,
          borderRadius: 12,
          opacity: t,
          boxShadow: `0 0 0 6px ${C.glow}`
        }}
      />
    </>
  )
}

/* ── 터미널 줄 ──────────────────────────────────────────────────────── */
export const Prompt: React.FC<{ host?: string; path?: string }> = ({ host = 'jun@dev-server', path = '~/vgt-erp' }) => (
  <>
    <span style={{ color: C.ok }}>{host}</span>
    <span style={{ color: C.mid }}>:</span>
    <span style={{ color: C.info }}>{path}</span>
    <span style={{ color: C.mid }}>$ </span>
  </>
)

/** 한 글자씩 찍히는 명령. delay 프레임 뒤부터 cps 속도로 나타난다. */
export const Typed: React.FC<{ text: string; delay?: number; cps?: number; color?: string }> = ({
  text,
  delay = 0,
  cps = 22,
  color = C.hi
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const n = Math.max(0, Math.floor(((frame - delay) / fps) * cps))
  return <span style={{ color }}>{text.slice(0, n)}</span>
}

export const Caret: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 20,
        transform: 'translateY(3px)',
        background: C.accent,
        opacity: frame % 30 < 15 ? 0.9 : 0.15
      }}
    />
  )
}

/* ── 자막 ───────────────────────────────────────────────────────────── */
export const Caption: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const t = useIntro(2)
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 54,
        display: 'flex',
        justifyContent: 'center',
        opacity: t,
        transform: `translateY(${interpolate(t, [0, 1], [12, 0])}px)`
      }}
    >
      <div
        style={{
          maxWidth: 1500,
          padding: '14px 30px',
          borderRadius: 14,
          background: 'rgba(23,22,24,.86)',
          border: `1px solid ${C.line}`,
          color: C.hi,
          fontSize: 34,
          lineHeight: 1.45,
          textAlign: 'center',
          wordBreak: 'keep-all'
        }}
      >
        {children}
      </div>
    </div>
  )
}

/* ── 키 조합 ────────────────────────────────────────────────────────── */
export const Keys: React.FC<{ keys: string[] }> = ({ keys }) => {
  const t = useIntro(4)
  return (
    <div
      style={{
        position: 'absolute',
        top: 44,
        left: 0,
        right: 0,
        display: 'flex',
        gap: 12,
        justifyContent: 'center',
        opacity: t
      }}
    >
      {keys.map((k) => (
        <span
          key={k}
          style={{
            padding: '10px 20px',
            borderRadius: 10,
            background: C.overlay,
            border: `1px solid ${C.lineStrong}`,
            borderBottomWidth: 4,
            color: C.hi,
            fontSize: 26,
            fontFamily: MONO
          }}
        >
          {k}
        </span>
      ))}
    </div>
  )
}

/* ── 다이얼로그 ─────────────────────────────────────────────────────── */
export const Dialog: React.FC<{ title: string; rows?: [string, string][]; body?: string; confirm?: string }> = ({
  title,
  rows = [],
  body,
  confirm = '확인'
}) => {
  const t = useIntro(4)
  return (
    <AbsoluteFill style={{ background: 'rgba(14,13,15,.72)', display: 'grid', placeItems: 'center', opacity: t }}>
      <div
        style={{
          width: 720,
          background: C.surface,
          border: `1px solid ${C.lineStrong}`,
          borderRadius: 16,
          padding: 34,
          boxShadow: '0 24px 64px -16px rgba(0,0,0,.85)',
          transform: `scale(${interpolate(t, [0, 1], [0.96, 1])})`
        }}
      >
        <div style={{ color: C.hi, fontSize: 28, fontWeight: 700, marginBottom: 14 }}>{title}</div>
        {body && <div style={{ color: C.mid, fontSize: 20, lineHeight: 1.6, marginBottom: 18 }}>{body}</div>}
        {rows.map(([k, v]) => (
          <div
            key={k}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '10px 0',
              borderBottom: `1px solid ${C.line}`,
              fontSize: 18
            }}
          >
            <span style={{ color: C.dim }}>{k}</span>
            <span style={{ color: C.mid, fontFamily: MONO }}>{v}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
          <span style={{ padding: '10px 22px', borderRadius: 999, border: `1px solid ${C.lineStrong}`, color: C.hi, fontSize: 18 }}>
            취소
          </span>
          <span style={{ padding: '10px 22px', borderRadius: 999, background: C.accent, color: '#1a1512', fontSize: 18, fontWeight: 700 }}>
            {confirm}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  )
}

/* ── 챕터 타이틀 카드 ───────────────────────────────────────────────── */
export const TitleCard: React.FC<{ title: string; sub?: string }> = ({ title, sub }) => {
  const t = useIntro()
  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      <div style={{ textAlign: 'center', opacity: t, transform: `translateY(${interpolate(t, [0, 1], [18, 0])}px)` }}>
        <img src={staticFile('logo.svg')} width={92} height={92} style={{ margin: '0 auto 28px', borderRadius: 22 }} />
        <div style={{ color: C.hi, fontSize: 62, fontWeight: 700, letterSpacing: '-.03em' }}>{title}</div>
        {sub && <div style={{ color: C.lo, fontSize: 27, marginTop: 14 }}>{sub}</div>}
        <div style={{ width: 90, height: 3, background: C.accent, margin: '32px auto 0', borderRadius: 2 }} />
      </div>
    </AbsoluteFill>
  )
}
