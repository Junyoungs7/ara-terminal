// 다중 모니터 창의 진입 해시와 [다중 모니터] 버튼 동작.
//
// 해시를 잘못 읽으면 창이 0×0 이나 NaN 으로 접속을 시도한다 — RDP 는 접속 시점 해상도가 세션
// 해상도라 그대로 굳고, 되돌리려면 재접속이다. 그래서 파싱은 순수 함수로 빼서 못 박는다.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parseRdpWinHash } from '../src/renderer/components/RdpSpanWindow'
import { setSpanNotifier, spanRdp } from '../src/renderer/store/rdpSpanOpen'

describe('#rdpwin 해시 읽기', () => {
  it('제대로 된 해시를 읽는다', () => {
    expect(parseRdpWinHash('#rdpwin?profile=p1&name=%EA%B0%9C%EB%B0%9C%EC%84%9C%EB%B2%84&w=3840&h=1080&monitors=2')).toEqual({
      profileId: 'p1',
      name: '개발서버',
      size: [3840, 1080],
      monitors: 2
    })
  })

  it('다른 창(편집기·본체)의 해시는 건드리지 않는다', () => {
    expect(parseRdpWinHash('')).toBeNull()
    expect(parseRdpWinHash('#editor?path=/a&server=s')).toBeNull()
    expect(parseRdpWinHash('#rdpwin')).toBeNull()
  })

  it('★ 크기가 없거나 말이 안 되면 null — 0×0 으로 접속을 시도하면 안 된다', () => {
    expect(parseRdpWinHash('#rdpwin?profile=p1')).toBeNull()
    expect(parseRdpWinHash('#rdpwin?profile=p1&w=0&h=1080')).toBeNull()
    expect(parseRdpWinHash('#rdpwin?profile=p1&w=-10&h=1080')).toBeNull()
    expect(parseRdpWinHash('#rdpwin?profile=p1&w=abc&h=1080')).toBeNull()
  })

  it('★ profile 이 없으면 null — 대상 없이 창만 뜨면 아무것도 못 한다', () => {
    expect(parseRdpWinHash('#rdpwin?w=1920&h=1080')).toBeNull()
  })

  it('monitors 가 빠지면 1로 본다(값이 안내용이라 접속을 막지는 않는다)', () => {
    expect(parseRdpWinHash('#rdpwin?profile=p1&w=1920&h=1080')?.monitors).toBe(1)
  })

  it('이름은 비어도 된다 — 창 제목만 비고 접속은 된다', () => {
    expect(parseRdpWinHash('#rdpwin?profile=p1&w=1920&h=1080')?.name).toBe('')
  })
})

// window.ev.rdp 를 흉내 낸다(preload 브리지).
function stubApi(displays: number, open: { ok: true; plan: unknown } | { ok: false; message: string }) {
  const openSpan = vi.fn().mockResolvedValue(open)
  ;(globalThis as unknown as { window: unknown }).window = {
    ev: {
      rdp: {
        displays: vi.fn().mockResolvedValue({
          displays: Array.from({ length: displays }, (_, i) => ({
            id: i + 1,
            bounds: { x: i * 1920, y: 0, width: 1920, height: 1080 },
            workArea: { x: i * 1920, y: 0, width: 1920, height: 1032 },
            scaleFactor: 1
          }))
        }),
        openSpan
      }
    }
  }
  return openSpan
}

const okPlan = (deadRatio = 0) => ({
  ok: true as const,
  plan: { remote: { width: 3840, height: 1080 }, count: 2, deadRatio }
})

// 2026-09-04: 이 길은 헤더 버튼이 아니라 **프로필 설정**이 부른다(Shell.openRdpProfile).
// 돌려주는 값이 세 갈래인 이유가 거기 있다 — `single` 일 때만 호출측이 보통 탭으로 떨어져야 하고,
// 그 밖의 거절('이미 열려 있음')에 탭을 열면 같은 서버에 두 번 붙어 서버가 앞 세션을 끊는다.
describe('다중 모니터로 붙기', () => {
  let said: string[] = []
  beforeEach(() => {
    said = []
    setSpanNotifier((m) => said.push(m))
  })

  it('★ 모니터가 한 장이면 창을 열지 않고 single — 호출측이 보통 탭으로 연다', async () => {
    const openSpan = stubApi(1, okPlan())
    expect(await spanRdp('p1', '서버')).toBe('single')
    expect(openSpan).not.toHaveBeenCalled()
    expect(said).toHaveLength(1)
  })

  it('두 장 이상이면 전체를 펼친다(빈 배열 = 전부)', async () => {
    const openSpan = stubApi(2, okPlan())
    expect(await spanRdp('p1', '서버')).toBe('opened')
    expect(openSpan).toHaveBeenCalledWith('p1', '서버', [])
    expect(said).toHaveLength(0)
  })

  it('★ main 이 거절하면 사유를 알리되 opened 다 — 탭까지 열면 같은 서버에 두 번 붙는다', async () => {
    stubApi(2, { ok: false, message: '이미 열려 있습니다.' })
    expect(await spanRdp('p1', '서버')).toBe('opened')
    expect(said).toEqual(['이미 열려 있습니다.'])
  })

  it('★ 죽은 영역이 크면 알린다 — 조용히 두면 "화면이 사라졌다"로 오해한다', async () => {
    stubApi(2, okPlan(1 / 3))
    expect(await spanRdp('p1', '서버')).toBe('opened')
    expect(said).toHaveLength(1)
  })

  it('아주 작은 어긋남은 넘어간다(1픽셀 차이까지 경고하면 소음이다)', async () => {
    stubApi(2, okPlan(0.005))
    expect(await spanRdp('p1', '서버')).toBe('opened')
    expect(said).toHaveLength(0)
  })

  it('profileId 가 없으면 아무 일도 하지 않는다', async () => {
    const openSpan = stubApi(2, okPlan())
    expect(await spanRdp('', '서버')).toBe('failed')
    expect(openSpan).not.toHaveBeenCalled()
  })
})
