// 자식 창(다른 모니터) 좌표 환산 — 여기가 틀리면 두 번째 모니터에서만 클릭이 어긋난다.
//
// 눈으로는 "가끔 엉뚱한 데가 눌린다"로만 보여서 원인을 찾기 어렵다. 특히 슬라이스 원점을 빼먹으면
// 두 번째 모니터의 클릭이 첫 번째 모니터 자리로 간다 — 화면은 멀쩡해 보이는데 동작만 이상하다.
import { describe, it, expect } from 'vitest'
import { mirrorButton, toRemotePoint } from '../src/renderer/store/rdpMirror'

// 1920x1080 두 장을 가로로 붙였을 때 오른쪽 모니터가 잘라 오는 자리.
const right = { x: 1920, y: 0, width: 1920, height: 1080 }

describe('자식 창 좌표 → 원격 좌표', () => {
  it('★ 슬라이스 원점이 더해진다 — 빼먹으면 두 번째 모니터 클릭이 첫 번째로 간다', () => {
    expect(toRemotePoint(right, 0, 0, 1920, 1080)).toEqual({ x: 1920, y: 0 })
    expect(toRemotePoint(right, 10, 20, 1920, 1080)).toEqual({ x: 1930, y: 20 })
  })

  it('첫 번째 모니터(원점 0)는 그대로', () => {
    const left = { x: 0, y: 0, width: 1920, height: 1080 }
    expect(toRemotePoint(left, 100, 200, 1920, 1080)).toEqual({ x: 100, y: 200 })
  })

  it('창이 슬라이스보다 작으면 비율로 환산한다(배율·테두리)', () => {
    // 창이 절반 크기로 보이는 상태 — 화면 가운데를 누르면 원격도 가운데여야 한다.
    expect(toRemotePoint(right, 480, 270, 960, 540)).toEqual({ x: 1920 + 960, y: 540 })
  })

  it('★ 슬라이스 밖으로는 안 나간다 — 옆 모니터 자리를 침범하면 안 된다', () => {
    expect(toRemotePoint(right, -50, -50, 1920, 1080)).toEqual({ x: 1920, y: 0 })
    expect(toRemotePoint(right, 9999, 9999, 1920, 1080)).toEqual({ x: 3839, y: 1079 })
  })

  it('창 크기가 0 이어도 죽지 않는다(창이 막 뜨는 순간)', () => {
    expect(toRemotePoint(right, 5, 5, 0, 0)).toEqual({ x: 1925, y: 5 })
  })

  it('아래로 쌓인 배치', () => {
    const below = { x: 0, y: 1080, width: 1920, height: 1080 }
    expect(toRemotePoint(below, 0, 0, 1920, 1080)).toEqual({ x: 0, y: 1080 })
  })
})

describe('마우스 버튼 변환', () => {
  it('왼쪽·오른쪽·가운데를 RDP 번호로', () => {
    expect(mirrorButton(0)).toBe(0) // 왼쪽
    expect(mirrorButton(2)).toBe(1) // 오른쪽
    expect(mirrorButton(1)).toBe(2) // 가운데
  })
  it('뒤로/앞으로 버튼은 보내지 않는다', () => {
    expect(mirrorButton(3)).toBeNull()
    expect(mirrorButton(4)).toBeNull()
  })
})
