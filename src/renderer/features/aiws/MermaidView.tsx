// 3차 R1-B .mmd 뷰어 — 그림 + 끌어 옮기기·휠 확대(Orca viewers.mdx "dedicated viewer with pan/zoom"). DocSurface 가 lazy 로 부른다.
// 출처: stablyai/orca @ec112c6b01 (MIT) components/editor/MermaidViewer.tsx(확대 단추·맞춤·끌기).
import { useEffect, useRef, useState, type JSX } from 'react'
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { t } from '../../i18n'
import type { DocProps } from './DocSurface'
import { MermaidDiagram } from './MermaidDiagram'

const ZOOM_MIN = 0.2
const ZOOM_MAX = 5
const ZOOM_STEP = 1.2
const RERENDER_MS = 300

export default function MermaidView({ model }: DocProps): JSX.Element {
  const [code, setCode] = useState(() => model.get())
  const [z, setZ] = useState({ k: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = model.onChange(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setCode(model.get()), RERENDER_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [model])
  const zoom = (f: number): void => setZ((s) => ({ ...s, k: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s.k * f)) }))
  return (
    <div className="mmd-view" data-doc="mmd-view">
      <div className="csv-bar">
        <span className="csv-count" data-doc="mmd-zoom">
          {Math.round(z.k * 100)}%
        </span>
        <button type="button" className="aiws-ic" title={t('doc.mermaid.zoomIn')} aria-label={t('doc.mermaid.zoomIn')} onClick={() => zoom(ZOOM_STEP)}>
          <ZoomIn />
        </button>
        <button type="button" className="aiws-ic" title={t('doc.mermaid.zoomOut')} aria-label={t('doc.mermaid.zoomOut')} onClick={() => zoom(1 / ZOOM_STEP)}>
          <ZoomOut />
        </button>
        <button type="button" className="aiws-ic" data-doc="mmd-fit" title={t('doc.mermaid.fit')} aria-label={t('doc.mermaid.fit')} onClick={() => setZ({ k: 1, x: 0, y: 0 })}>
          <Maximize />
        </button>
      </div>
      <div
        className="mmd-stage"
        onWheel={(e) => zoom(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX - z.x, y: e.clientY - z.y }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d) setZ((s) => ({ ...s, x: e.clientX - d.x, y: e.clientY - d.y }))
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <div className="mmd-pan" style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.k})` }}>
          <MermaidDiagram code={code} />
        </div>
      </div>
    </div>
  )
}
