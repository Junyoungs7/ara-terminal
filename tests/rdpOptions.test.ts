// RDP 헤더 [옵션] 리스트 — 2026-09-01 준영님: *"화면이 작을 때 rdp 창의 상단 버튼들이 글자
// 줄바꿈, 잘림 현상이 발생하는데 … 창크기 맞춤·키 변환 없음·파일 받기·보내기·단축키·다중
// 모니터는 그냥 옵션 버튼 하나로 리스트 형태로 보여주는 게 좋아 보여."*
//
// 접는 변경의 위험은 **조용히 잃는 것**이다. 헤더 버튼은 앱에서 그 기능에 닿는 유일한 길이라
// (파일 받기·조합키 전송·다중 모니터 전부 다른 진입점이 없다) 항목 하나가 빠지면 기능이
// 사라진 것과 같은데, 화면은 멀쩡해 보인다. 그래서 목록을 여기서 못 박는다.
//
// 두 번째로 잃기 쉬운 것이 **비활성 사유**다. 버튼일 때는 [파일 받기] 가 흐린 채로 그 자리에
// 있었고 hover 하면 "원격에서 파일을 복사(Ctrl+C)하면 활성화됩니다" 가 떴다. 접으면 hover 할
// 버튼이 없다 — 리스트 안에서 조건을 말해야 한다.
import { describe, it, expect } from 'vitest'
import type { ReactElement } from 'react'
import { Check } from 'lucide-react'
import { rdpOptionItems } from '../src/renderer/components/RdpView'
import { RDP_KEY_MODES, RDP_RESOLUTIONS, resLabel } from '../src/renderer/components/rdpInput'
import ko from '../src/renderer/i18n/ko.json'

const base = { connected: true, res: ko['rdp.res.fit'], keyMode: 'off' as const, recvCount: 0, canSpan: true }
const ids = (items: { id: string }[]): string[] => items.map((i) => i.id)
/** 체크 표시가 붙은 하위 항목 — 안 붙은 항목도 자리를 맞추려 빈 <span> 을 받는다. */
const checked = (subs: readonly { id: string; icon?: unknown }[]): string[] =>
  subs.filter((s) => (s.icon as ReactElement | undefined)?.type === Check).map((s) => s.id)

describe('RDP [옵션] 리스트 — 여섯이 전부 있다', () => {
  it('★ 접속 중 · 탭 뷰: 해상도 · 키 변환 · 파일 받기 · 보내기 · 단축키 · 다중 모니터', () => {
    expect(ids(rdpOptionItems(base))).toEqual(['res', 'keys', 'recv', 'send', 'combo', 'span'])
  })

  it('안 붙었으면 파일·단축키는 없다 — 보낼 것도 받을 것도 없다(버튼 시절과 같은 조건)', () => {
    expect(ids(rdpOptionItems({ ...base, connected: false }))).toEqual(['res', 'keys', 'span'])
  })

  it('다중 모니터 창에는 [다중 모니터] 가 없다 — 이미 그 창이다', () => {
    expect(ids(rdpOptionItems({ ...base, canSpan: false }))).toEqual(['res', 'keys', 'recv', 'send', 'combo'])
  })

  it('단축키 셋(Ctrl+Alt+Del · Alt+Tab · Win)이 전부 하위에 있다 — OS 가 가로채 직접 못 누르는 키다', () => {
    const combo = rdpOptionItems(base).find((i) => i.id === 'combo')
    expect(combo?.submenu?.map((s) => s.label)).toEqual(['Ctrl+Alt+Del', 'Alt+Tab', 'Win'])
    // 라벨만 있고 보낼 조합이 없으면 눌러도 아무 일이 없다 — id 로 sendCombo 를 부른다.
    expect(combo?.submenu?.map((s) => s.id)).toEqual(['combo:ctrlAltDel', 'combo:altTab', 'combo:win'])
  })
})

describe('고르는 것 — 지금 값이 보인다', () => {
  it('★ 해상도·키 변환은 닫힌 행에 현재값을 적고 하위에서 그 항목에만 체크한다', () => {
    const items = rdpOptionItems({ ...base, res: '1600 × 900', keyMode: 'macCtrl' })
    const res = items.find((i) => i.id === 'res')
    const keys = items.find((i) => i.id === 'keys')
    expect(res?.hint).toBe('1600 × 900')
    expect(keys?.hint).toBe(ko['rdp.keys.macCtrl'])
    expect(checked(res?.submenu ?? [])).toEqual(['res:1600 × 900'])
    expect(checked(keys?.submenu ?? [])).toEqual(['keys:macCtrl'])
  })

  it('해상도 목록에 고정 해상도 전부 + 창 맞춤이 있다 — 고를 수 있어야 값이다', () => {
    const res = rdpOptionItems(base).find((i) => i.id === 'res')
    expect(res?.submenu?.map((s) => s.label)).toEqual([...RDP_RESOLUTIONS.map(resLabel), ko['rdp.res.fit']])
    expect(rdpOptionItems(base).find((i) => i.id === 'keys')?.submenu?.map((s) => s.id)).toEqual(
      RDP_KEY_MODES.map((m) => `keys:${m}`)
    )
  })

  it('다중 모니터 창에서는 해상도가 읽기 전용이되 값과 이유를 말한다', () => {
    const res = rdpOptionItems({ ...base, fixedSize: [3840, 1080] }).find((i) => i.id === 'res')
    expect(res?.disabled).toBe(true)
    expect(res?.submenu).toBeUndefined()
    expect(res?.hint).toBe('3840 × 1080')
    expect(res?.title).toBe(ko['rdp.span.fixed'])
  })
})

describe('못 하는 것 — 왜 못 하는지 말한다', () => {
  it('★ 받을 파일이 없으면 [파일 받기] 는 비활성이고 켜지는 조건이 눈에 보인다', () => {
    const recv = rdpOptionItems({ ...base, recvCount: 0 }).find((i) => i.id === 'recv')
    expect(recv?.disabled).toBe(true)
    // hint 는 리스트에서 바로 읽히고(원격에서 Ctrl+C), title 은 전역 툴팁이 원문을 마저 말한다.
    expect(recv?.hint).toBe(ko['rdp.file.recv.need'])
    expect(recv?.title).toBe(ko['rdp.file.recv.title'])
  })

  it('받을 파일이 있으면 활성 + 개수를 말한다', () => {
    const recv = rdpOptionItems({ ...base, recvCount: 3 }).find((i) => i.id === 'recv')
    expect(recv?.disabled).toBe(false)
    expect(recv?.hint).toBe('3개')
  })

  it('하는 것에는 현재값 자리가 비어 있다 — 값과 동작이 모양으로 갈린다', () => {
    const items = rdpOptionItems({ ...base, recvCount: 1 })
    for (const id of ['send', 'combo', 'span']) expect(items.find((i) => i.id === id)?.hint).toBeUndefined()
  })
})
