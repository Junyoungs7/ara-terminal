// p3-M21 펫 덮개 — Orca components/pet/PetOverlay.tsx · usePetPointerInteraction.ts · pet-agent-state.ts(orcaRef ec112c6b01)의 아라판.
// 오른쪽 아래에 떠 있고 끌어 옮긴다(자리는 localStorage — Orca 와 같다). 음성(아라 얼굴)이 열리면 부르는 쪽(MainArea)이 그리지 않는다.
// 몸은 올린 그림 그대로(무채색 틀), 상태는 기존 신호 글리프 배지로만: 막힘 = 답할 일 칩, 일함 = 도는 고리, 끝남 = 끝 점.
// 움직임: 일함 = 통통, 기다림 = 흔들, 호버 = 점프(Orca running·waiting·jumping 의 한 장 그림판). 모션 줄이기면 움직이지 않는다(CSS).
import { useEffect, useRef, useState, type JSX } from 'react'
import type { AgentStatusView } from '@shared/agentHooks'
import { clampPetPos, petMood, type PetPrefs } from '@shared/pet'
import { t } from '../../i18n'
import { ContextMenu } from '../../interactions/ContextMenu'
import { importPet } from './importPet'
import './pet.css'

const POS_KEY = 'pet.pos'
const DEFAULT_POS = { right: 16, bottom: 40 }
const readPos = (): { right: number; bottom: number } => {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as { right?: unknown; bottom?: unknown } | null
    return typeof v?.right === 'number' && typeof v.bottom === 'number' ? { right: v.right, bottom: v.bottom } : DEFAULT_POS
  } catch {
    return DEFAULT_POS
  }
}

/** 끝난 세션을 걷으려고 원장 전체를 다시 받는 간격(main 은 세션이 끝나면 원장에서 지우지만 그 사실을 밀어 주지 않는다). */
const RESYNC_MS = 15_000

/** 에이전트 상태 — main 원장을 직접 받는다(AI 작업 공간 청크를 끌어오지 않게). */
function useAgentStatuses(): AgentStatusView[] {
  const [map, setMap] = useState<Map<string, AgentStatusView>>(new Map())
  useEffect(() => {
    let alive = true
    const all = (): void => void window.ev.agents.statuses().then((list) => alive && setMap(new Map(list.map((v) => [v.sessionId, v]))), () => {})
    all()
    const timer = setInterval(all, RESYNC_MS)
    const off = window.ev.agents.onStatus((v) => alive && setMap((m) => new Map(m).set(v.sessionId, v)))
    return () => {
      alive = false
      clearInterval(timer)
      off()
    }
  }, [])
  return [...map.values()]
}

export default function PetOverlay({ pet, onChange }: { pet: PetPrefs; onChange: (p: PetPrefs) => void }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [pos, setPos] = useState(readPos)
  const [hover, setHover] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null)
  const mood = petMood(useAgentStatuses())

  useEffect(() => {
    let alive = true
    setSrc(null)
    if (pet.image) void window.ev.pet.image(pet.image).then((u) => alive && setSrc(u), () => {})
    return () => {
      alive = false
    }
  }, [pet.image])

  // 창이 작아지면 창 안으로 당긴다.
  useEffect(() => {
    const fit = (): void => setPos((p) => clampPetPos(p, pet.size, { w: window.innerWidth, h: window.innerHeight }))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [pet.size])

  const badge =
    mood === 'waiting' ? (
      <span className="pet-badge ag-ask-chip">?</span>
    ) : mood === 'running' ? (
      <span className="pet-badge ag-glyph" data-agent-state="working">
        <span className="ag-spin" />
      </span>
    ) : mood === 'review' ? (
      <span className="pet-badge ag-glyph" data-agent-state="done">
        <span className="ag-dot done" />
      </span>
    ) : null

  return (
    <>
      <div
        className={'pet' + (hover && !drag.current ? ' jump' : '')}
        data-pet={mood}
        role="img"
        aria-label={t('pet.label') + ' · ' + t('pet.mood.' + mood)}
        title={t('pet.mood.' + mood)}
        style={{ right: pos.right, bottom: pos.bottom, width: pet.size, height: pet.size }}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, ...pos, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          d.moved = true
          setPos(clampPetPos({ right: d.right - (e.clientX - d.x), bottom: d.bottom - (e.clientY - d.y) }, pet.size, { w: window.innerWidth, h: window.innerHeight }))
        }}
        onPointerUp={() => {
          drag.current = null
          try {
            localStorage.setItem(POS_KEY, JSON.stringify(pos))
          } catch {
            /* 다음 실행엔 기본 자리 */
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {src ? (
          <img className="pet-img" src={src} alt="" draggable={false} />
        ) : (
          // 기본 캐릭터가 없다(준영님 결정) — 켜고 그림이 없으면 올리기 안내.
          <button type="button" className="pet-empty" data-pet="upload" onPointerDown={(e) => e.stopPropagation()} onClick={() => void importPet(pet, onChange)}>
            {t('pet.upload')}
          </button>
        )}
        {badge}
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={[
          { id: 'upload', label: t('pet.upload') },
          { id: 'hide', label: t('pet.hide') }
        ]}
        onPick={(id) => {
          setMenu(null)
          if (id === 'hide') onChange({ ...pet, enabled: false })
          else void importPet(pet, onChange)
        }}
        onClose={() => setMenu(null)}
      />
    </>
  )
}
