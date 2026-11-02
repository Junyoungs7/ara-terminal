// 3차 R1-B Mermaid — 마크다운 미리 보기의 ```mermaid 블록과 .mmd 뷰어가 같이 쓴다. mermaid 패키지(수 MB)는 처음 그릴 때 import().
// 출처: stablyai/orca @ec112c6b01 (MIT) components/editor/MermaidBlock.tsx·mermaid-config.ts(securityLevel strict·htmlLabels)·
// mermaid-sanitize.ts(DOMPurify 설정 그대로)·mermaid-theme-colors.ts(토큰 → 색을 캔버스로 읽어 hex 로 — mermaid 는 hex 만 안다).
import { useEffect, useId, useState, type JSX } from 'react'
import DOMPurify, { type Config } from 'dompurify'
import { t } from '../../i18n'

const SANITIZE: Config = {
  USE_PROFILES: { html: true, svg: true, mathMl: true },
  FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'datalist', 'option', 'optgroup', 'fieldset', 'legend', 'label', 'output'],
  ADD_TAGS: ['foreignobject'],
  ADD_ATTR: ['dominant-baseline'],
  HTML_INTEGRATION_POINTS: { foreignobject: true }
}

type Mermaid = typeof import('mermaid').default
let loading: Promise<Mermaid> | null = null
let renderSeq = 0

/** 앱 토큰(--bg-canvas 등) → hex(Orca readMermaidThemeColors). 아라는 늘 어두운 바탕. */
function themeColors(): Record<string, string> {
  const ctx = document.createElement('canvas').getContext('2d')
  const cs = getComputedStyle(document.documentElement)
  const hex = (token: string): string => {
    if (!ctx) return ''
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = cs.getPropertyValue(token).trim()
    ctx.fillRect(0, 0, 1, 1)
    return '#' + Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3), (c) => c.toString(16).padStart(2, '0')).join('')
  }
  const bg = hex('--bg-canvas')
  const fg = hex('--text-hi')
  const line = hex('--line-strong')
  const surf = hex('--bg-surface')
  return {
    darkMode: 'true',
    background: bg,
    primaryColor: surf,
    secondaryColor: surf,
    tertiaryColor: bg,
    primaryTextColor: fg,
    secondaryTextColor: fg,
    tertiaryTextColor: fg,
    primaryBorderColor: line,
    secondaryBorderColor: line,
    tertiaryBorderColor: line,
    lineColor: fg,
    textColor: fg,
    edgeLabelBackground: bg
  }
}

function loadMermaid(): Promise<Mermaid> {
  return (loading ??= import('mermaid').then((m) => {
    m.default.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'base', darkMode: true, themeVariables: themeColors(), htmlLabels: true })
    return m.default
  }))
}

/** 다이어그램 하나 — 그리기 실패면 이유와 원문을 보여 준다(Orca MermaidBlock 오류 상태). */
export function MermaidDiagram({ code, className }: { code: string; className?: string }): JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [state, setState] = useState<{ svg: string } | { error: string } | null>(null)
  useEffect(() => {
    let live = true
    setState(null)
    void loadMermaid()
      .then((m) => m.render(`ara-mmd-${id}-${++renderSeq}`, code))
      .then((r) => live && setState({ svg: DOMPurify.sanitize(r.svg, SANITIZE) as string }))
      .catch((e: unknown) => live && setState({ error: e instanceof Error ? e.message : String(e) }))
    return () => {
      live = false
    }
  }, [code, id])
  if (state === null) return <div className={'mmd ' + (className ?? '')}>{t('code.loading')}</div>
  if ('error' in state)
    return (
      <div className={'mmd mmd-err ' + (className ?? '')} role="alert" data-doc="mermaid-error">
        <p>{t('doc.mermaid.error')}</p>
        <pre>{state.error}</pre>
      </div>
    )
  // DOMPurify 를 거친 SVG 만 넣는다(Orca 와 같은 설정 — 폼 요소 금지, foreignObject 라벨 허용).
  return <div className={'mmd ' + (className ?? '')} data-doc="mermaid" dangerouslySetInnerHTML={{ __html: state.svg }} />
}
