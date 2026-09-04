import { it } from 'vitest'
import { planSpan } from '../src/shared/rdpSpan'

it('준영님 배치 실측', () => {
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, scaleFactor: 1 },
    { id: 2, bounds: { x: -1920, y: 4, width: 1920, height: 1080 }, workArea: { x: -1920, y: 4, width: 1920, height: 1032 }, scaleFactor: 1 }
  ]
  const p = planSpan(displays, [1, 2], { frame: { left: 1, top: 31, right: 1, bottom: 1 }, header: 32 })!
  console.log('remote', p.remote, 'dead', p.deadRatio)
  for (const m of p.monitors) console.log(m.id, 'primary', m.primary, 'rdp', m.rdp, 'slice', m.slice, 'content', m.content)
})
