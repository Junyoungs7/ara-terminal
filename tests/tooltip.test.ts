// 전역 툴팁 — 문구 쪼개기와 자리 잡기.
//
// 이 둘이 이 기능의 전부다. 나머지(네이티브 억제·지연)는 DOM 배선이라 실기동으로 본다.
// 자리 계산이 틀리면 툴팁이 화면 밖으로 나가 아무것도 안 보이고, 문구 쪼개기가 틀리면
// 문장 속 조합키를 뱃지로 떼어내 말이 부서진다.
import { describe, it, expect } from 'vitest'
import { placeTip, splitTip } from '../src/renderer/store/tooltip'

describe('단축키 뱃지 분리', () => {
  it('끝에 괄호로 붙은 단축키는 뱃지로 뗀다', () => {
    expect(splitTip('탐색기 닫기 (Ctrl+Shift+O)')).toEqual({ text: '탐색기 닫기', key: 'Ctrl+Shift+O' })
    expect(splitTip('새 세션 (Ctrl+Shift+T)')).toEqual({ text: '새 세션', key: 'Ctrl+Shift+T' })
  })

  it('★ 문장 속 조합키는 건드리지 않는다 — 떼면 말이 부서진다', () => {
    const s = '원격에서 파일을 복사(Ctrl+C)하면 활성화됩니다 — 저장 위치를 골라 내려받습니다'
    expect(splitTip(s)).toEqual({ text: s, key: null })
  })

  it('단축키가 없는 괄호는 그대로 문장에 남는다', () => {
    expect(splitTip('탐색기 닫기 (실험 기능)')).toEqual({ text: '탐색기 닫기 (실험 기능)', key: null })
    expect(splitTip('GPU (nvidia 서버만)')).toEqual({ text: 'GPU (nvidia 서버만)', key: null })
  })

  it('기능키·맥 기호도 단축키로 본다', () => {
    expect(splitTip('치트시트 (F1)').key).toBe('F1')
    expect(splitTip('설정 (⌘+,)').key).toBe('⌘+,')
  })

  it('괄호가 없으면 통째로 문구', () => {
    expect(splitTip('다중 모니터')).toEqual({ text: '다중 모니터', key: null })
  })

  it('앞뒤 공백은 정리한다', () => {
    expect(splitTip('  다중 모니터  ')).toEqual({ text: '다중 모니터', key: null })
  })

  it('괄호가 중간에 있으면 뱃지가 아니다 — 끝에 있는 것만 본다', () => {
    expect(splitTip('세션 복제 (Ctrl+Shift+D) 후 이름 변경').key).toBeNull()
  })
})

const rect = (left: number, top: number, w: number, h: number) => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
  width: w,
  height: h
})

describe('툴팁 자리 — 좌우로 붙인다', () => {
  // 아래로 붙이면 세로로 늘어선 아이콘 바에서 바로 밑 아이콘을 덮는다(준영님 지적).
  // 좌우는 그 줄에 아무것도 없어 무엇도 가리지 않는다.

  it('기본은 요소 오른쪽, 세로 가운데 맞춤', () => {
    // 30px 요소의 가운데(65) 에 24px 툴팁의 가운데를 맞춘다 → top = 65 - 12 = 53
    expect(placeTip(rect(100, 50, 30, 30), 120, 24, 1000, 800)).toEqual({ x: 136, y: 53, side: 'right' })
  })

  it('★ 오른쪽이 좁으면 왼쪽으로 — 우측 아이콘 바가 이 경우다', () => {
    const p = placeTip(rect(950, 300, 30, 30), 200, 24, 1000, 800)
    expect(p.side).toBe('left')
    expect(p.x).toBe(950 - 6 - 200)
  })

  it('왼쪽 가장자리 요소는 오른쪽에 붙는다', () => {
    expect(placeTip(rect(4, 300, 30, 30), 200, 24, 1000, 800).side).toBe('right')
  })

  it('★ 양쪽 다 좁으면 넓은 쪽에 붙이고 화면 안으로 민다 — 잘리더라도 덜 잘리는 쪽', () => {
    // 화면 400, 요소가 한가운데(180~220): 왼쪽 여유 166, 오른쪽 166 → 오른쪽(동점은 오른쪽)
    const p = placeTip(rect(180, 300, 40, 30), 300, 24, 400, 800)
    expect(p.side).toBe('right')
    expect(p.x).toBe(400 - 300 - 8)
    expect(p.x).toBeGreaterThanOrEqual(8)
  })

  it('툴팁이 화면보다 넓어도 좌표가 음수로 새지 않는다', () => {
    expect(placeTip(rect(10, 300, 30, 30), 2000, 24, 400, 800).x).toBe(8)
  })

  it('★ 세로도 화면 안으로 민다 — 맨 위/맨 아래 아이콘에서 잘리면 안 된다', () => {
    expect(placeTip(rect(100, 0, 30, 30), 120, 60, 1000, 800).y).toBe(8)
    expect(placeTip(rect(100, 780, 30, 30), 120, 60, 1000, 800).y).toBe(800 - 60 - 8)
  })

  it('키 큰 요소(트리 행 등)에서도 가운데를 잡는다', () => {
    expect(placeTip(rect(100, 100, 200, 80), 120, 24, 1000, 800).y).toBe(100 + 40 - 12)
  })
})
