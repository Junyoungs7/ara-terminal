// F32 세션 창 해시 파싱 — 잘못 읽으면 본창이 두 번 뜨거나(같은 세션을 두 창이 그린다) 빈 창이 남는다.
// 창을 여는 쪽(main)과 읽는 쪽(renderer)이 문자열 하나로 맞추는 자리라 순수 함수로 떼어 검증한다.
import { describe, it, expect } from 'vitest'
import { parseSessionWinHash, sessionWinHash } from '../src/shared/sessionWin'
import { usableBounds } from '../src/main/windows/SessionWindows'
import { shouldShowBootSplash } from '../src/renderer/components/BootSplash'
import { mergeMainSnapshot } from '../src/renderer/store/sessions'
import type { Session } from '../src/renderer/store/sessions'

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

// ── 떼어낸 창은 인사하지 않는다 (2026-09-01 제보 ①) ─────────────────────────
//
// 창마다 렌더러가 따로라 "이미 인사했다"를 기억하는 모듈 변수가 새 창에서 새로 시작한다 —
// 그래서 탭을 뗄 때마다 2초짜리 부팅 인사가 떴고, 분리가 그만큼 늦어졌다.
describe('부팅 인사를 그리는 창', () => {
  const on = { prefsLoaded: true, bootSplash: true, splashDone: false }

  it('본창에서는 뜬다', () => {
    expect(shouldShowBootSplash(on)).toBe(true)
  })

  it('★ 떼어낸 창에서는 안 뜬다 — 인사는 앱을 켤 때의 것이지 창을 열 때의 것이 아니다', () => {
    expect(shouldShowBootSplash({ ...on, detachedWinId: 'w1abc' })).toBe(false)
  })

  it('기존 조건은 그대로 — 로드 전·설정 off·이미 지남', () => {
    expect(shouldShowBootSplash({ ...on, prefsLoaded: false })).toBe(false)
    expect(shouldShowBootSplash({ ...on, bootSplash: false })).toBe(false)
    expect(shouldShowBootSplash({ ...on, splashDone: true })).toBe(false)
  })
})

// ── 되돌리기가 RDP 를 지우지 않는다 (2026-09-01 제보 ②) ──────────────────────
//
// 떼어낸 창을 다시 탭으로 붙이면 `session:moved` → refreshFromMain 이 돌고, 그것이 목록을
// main 스냅샷으로 통째로 덮었다. RDP 세션은 main 에 없어서(pty 가 없다) 그 순간 사라졌고,
// RdpView 가 언마운트되며 릴레이까지 끊겼다 — 터미널은 main 에 살아 있어 멀쩡했다.
const sess = (id: string, type: Session['type'] = 'local'): Session => ({
  id,
  title: id,
  serverKey: type === 'local' ? 'localhost' : 'srv',
  type
})

describe('main 스냅샷 합치기', () => {
  it('★ main 이 모르는 RDP 세션은 남는다 — 되돌리기 한 번에 원격 화면이 꺼지면 안 된다', () => {
    const cur = [sess('a'), sess('rdp:p1:1', 'rdp')]
    expect(mergeMainSnapshot(cur, [sess('a')]).map((s) => s.id)).toEqual(['a', 'rdp:p1:1'])
  })

  it('돌아온 세션은 들어오고, 떠난 세션은 빠진다', () => {
    const cur = [sess('a'), sess('rdp:p1:1', 'rdp'), sess('gone')]
    const mine = [sess('a'), sess('b', 'ssh')]
    expect(mergeMainSnapshot(cur, mine).map((s) => s.id)).toEqual(['a', 'rdp:p1:1', 'b'])
  })

  it('★ 이 창의 탭 순서를 지킨다 — 세션 하나가 돌아왔다고 남의 탭이 움직이면 안 된다', () => {
    const cur = [sess('c'), sess('a'), sess('b')]
    const mine = [sess('a'), sess('b'), sess('c')] // main 은 생성 순만 안다
    expect(mergeMainSnapshot(cur, mine).map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })

  it('메타는 main 것이 이긴다(제목 변경·소유 창) — 사본이 진실을 덮지 않는다', () => {
    const cur = [{ ...sess('a'), title: '옛 이름' }]
    const [merged] = mergeMainSnapshot(cur, [{ ...sess('a'), title: '새 이름', winId: 'w1' }])
    expect(merged).toMatchObject({ title: '새 이름', winId: 'w1' })
  })

  it('처음 뜬 창(빈 목록)은 스냅샷 그대로', () => {
    expect(mergeMainSnapshot([], [sess('a'), sess('b')]).map((s) => s.id)).toEqual(['a', 'b'])
  })
})
