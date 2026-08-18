// F32 세션 창 해시 파싱 — 잘못 읽으면 본창이 두 번 뜨거나(같은 세션을 두 창이 그린다) 빈 창이 남는다.
// 창을 여는 쪽(main)과 읽는 쪽(renderer)이 문자열 하나로 맞추는 자리라 순수 함수로 떼어 검증한다.
import { describe, it, expect } from 'vitest'
import { parseSessionWinHash, sessionWinHash } from '../src/shared/sessionWin'
import { usableBounds } from '../src/main/windows/SessionWindows'

describe('세션 창 해시', () => {
  it('win 을 읽는다', () => {
    expect(parseSessionWinHash('#sessionwin?win=w1abc')).toEqual({ winId: 'w1abc' })
  })

  it('우리 해시가 아니면 null — 본창이 그려져야 한다', () => {
    expect(parseSessionWinHash('')).toBeNull()
    expect(parseSessionWinHash('#editor?path=/a')).toBeNull()
    expect(parseSessionWinHash('#rdpwin?profile=p1&w=1&h=1')).toBeNull()
    expect(parseSessionWinHash('#sessionwindow?win=x')).toBeNull()
  })

  it('★ win 이 비어 있으면 null — 소유자 없는 창을 띄우지 않는다', () => {
    expect(parseSessionWinHash('#sessionwin?win=')).toBeNull()
    expect(parseSessionWinHash('#sessionwin?')).toBeNull()
  })

  it('★ 여는 쪽과 읽는 쪽이 왕복한다 — 이 둘이 어긋나면 그 창에 본창이 통째로 뜬다', () => {
    for (const id of ['w1abc', 'w 1', 'w&x=1', '한글창']) {
      expect(parseSessionWinHash(sessionWinHash(id))).toEqual({ winId: id })
    }
  })
})

// ── 창 자리 복원 (F32 R2) ────────────────────────────────────────────────────
//
// 여기서 틀리면 사용자에게는 **"창이 안 뜬다"** 로 보인다: 저장된 좌표가 지금 없는 모니터를
// 가리키면 창은 열리지만 화면 밖이라 찾을 수도 끌어올 수도 없다. 듀얼 모니터에서 떼어 놓고
// 노트북만 들고 나가면 그대로 재현된다 — 준영님이 회사(윈도우 2대)와 집(맥북)을 오가시므로
// 가정이 아니라 일상 경로다.
const mon = (x: number, y: number, width = 1920, height = 1080) => ({ bounds: { x, y, width, height } })
const DUAL = [mon(0, 0), mon(1920, 0)] // 오른쪽에 한 장 더
const SOLO = [mon(0, 0)] // 노트북만

describe('떼어낸 창 자리', () => {
  it('저장된 자리가 화면 안이면 그대로 쓴다', () => {
    const saved = { x: 2000, y: 100, width: 1100, height: 720 }
    expect(usableBounds(saved, DUAL)).toEqual(saved)
  })

  it('★ 그 모니터가 없어졌으면 버린다 — 화면 밖 창은 찾을 수도 끌어올 수도 없다', () => {
    expect(usableBounds({ x: 2000, y: 100, width: 1100, height: 720 }, SOLO)).toBeNull()
  })

  it('★ 왼쪽·위쪽에 붙은 모니터의 음수 좌표도 살린다(주 모니터가 원점이 아닐 수 있다)', () => {
    const left = [mon(0, 0), mon(-1920, 0)]
    expect(usableBounds({ x: -1500, y: 50, width: 800, height: 600 }, left)).not.toBeNull()
  })

  it('저장된 값이 없으면 null — 기본 크기로 연다', () => {
    expect(usableBounds(undefined, DUAL)).toBeNull()
  })

  it('경계: 모니터 오른쪽 끝 바로 밖은 버린다', () => {
    expect(usableBounds({ x: 3840, y: 0, width: 800, height: 600 }, DUAL)).toBeNull()
    expect(usableBounds({ x: 3839, y: 0, width: 800, height: 600 }, DUAL)).not.toBeNull()
  })
})
