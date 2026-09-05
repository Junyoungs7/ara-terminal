// F32 세션 창 해시 파싱 — 잘못 읽으면 본창이 두 번 뜨거나(같은 세션을 두 창이 그린다) 빈 창이 남는다.
// 창을 여는 쪽(main)과 읽는 쪽(renderer)이 문자열 하나로 맞추는 자리라 순수 함수로 떼어 검증한다.
import { describe, it, expect } from 'vitest'
import { MAIN_WIN_ID, parseSessionWinHash, sessionWinHash, shouldAskBeforeQuit } from '../src/shared/sessionWin'
import { usableBounds } from '../src/main/windows/SessionWindows'
import { shouldShowBootSplash } from '../src/renderer/components/BootSplash'
import { mergeMainSnapshot, nextActiveAfter } from '../src/renderer/store/sessions'
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

// ── 아라를 끌 때 물어본다 (2026-09-05) ───────────────────────────────────────
//
// 준영님: *"아라 끌때 세션이 떠있으면 종료할꺼냐고 물어보고 확인 누르면 닫자."*
//
// 🔴 여기서 틀리면 **앱이 영영 안 꺼진다.** 막는 코드라서 그렇다: `true` 가 잘못 나오면 main 이
// close 를 preventDefault 하고 답을 기다리는데, 답할 사람이 없거나 그 답이 또 close 를 부르면
// 교착이다. 그래서 판정만 순수 함수로 떼어 창 없이 검사한다(실기동은 준영님 PC 를 뺏는다).
//
// 반대 방향의 실패는 등급이 다르다 — 안 물어보면 불편이고, 안 닫히면 사고다.
describe('아라 종료 확인', () => {
  const live = { sessionCount: 2, quitting: false, rendererAlive: true }

  it('세션이 있으면 묻는다', () => {
    expect(shouldAskBeforeQuit(live)).toBe(true)
  })

  it('세션이 0개면 안 묻는다 — 빈 창 닫는 데 확인은 방해다', () => {
    expect(shouldAskBeforeQuit({ ...live, sessionCount: 0 })).toBe(false)
  })

  it('★ 종료가 진행 중이면 안 묻는다 — 교착 가드. 이게 false 면 [종료]를 눌러도 안 꺼진다', () => {
    // app.quit() → before-quit(여기서 quitting=true) → **그다음** 각 창의 close 가 온다.
    // 그 close 를 또 막으면 확인 → app.quit() → 또 막힘의 무한 루프다.
    expect(shouldAskBeforeQuit({ ...live, quitting: true })).toBe(false)
  })

  it('★ 이미 확인을 받았으면 안 묻는다 — 확인이 app.quit() 을 부르고 그것이 quitting 을 켠다', () => {
    // "한 번만 묻는다"를 지키는 것이 별도 플래그가 아니라 위와 **같은** quitting 이다.
    // 자동 업데이트 재시작(quitAndInstall → app.quit())이 덮이는 것도 같은 이유다.
    expect(shouldAskBeforeQuit({ ...live, quitting: true, sessionCount: 5 })).toBe(false)
  })

  it('★ 렌더러가 죽었으면 안 묻는다 — 답할 사람이 없는데 막으면 못 닫는 창이 된다', () => {
    expect(shouldAskBeforeQuit({ ...live, rendererAlive: false })).toBe(false)
  })

  it('★ 본창 센티널은 떼어낸 창의 id 와 절대 안 겹친다 — 겹치면 엉뚱한 창을 닫는다', () => {
    // 떼어낸 창의 id 는 registerSessionWindowIpc 의 newWinId(): 'w' + base36 — 빌 수 없다.
    expect(MAIN_WIN_ID).toBe('')
    expect(parseSessionWinHash(sessionWinHash(MAIN_WIN_ID))).toBeNull() // 빈 winId = 본창
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

// ── 탭이 빠진 자리를 누가 채우는가 (2026-09-02 제보 ②·③) ─────────────────────
//
// *"창 분리하면 아라 기본 창에서는 바로 이전 세션 창이 켜져야 하는데 안 켜지고 있어."*
//
// 탭이 목록에서 빠지는 길이 둘이다 — ✕ 로 닫기와 창으로 떼어내기. 닫기에만 규칙이 있었고
// 떼어내기는 activeId 를 **떠난 세션에 둔 채로** 뒀다: 그 세션의 칸은 아무것도 안 그리니 본창이
// 통째로 빈다. 두 길이 같은 함수를 쓰는지를 여기서 고정한다(다르게 굴면 그게 다음 제보다).
//
// 자리를 채우는 규칙은 **직전에 보던 탭(MRU)** 이다(2026-09-02 준영님 결정). 아래 ★ 넷은
// 원래 "오른쪽이 받는다"를 고정하던 검사인데, 그 규칙이 없어진 게 아니라 **기록이 없을 때의
// 폴백**으로 내려갔다 — 그래서 지우지 않고 뜻만 그렇게 바꿨다(mru 인자를 안 주면 곧 그 경우다).
describe('빠진 탭의 자리', () => {
  const abc = [sess('a'), sess('b'), sess('c')]

  it('★ 본 기록이 없으면 오른쪽 탭이 그 자리를 받는다 — 폴백', () => {
    expect(nextActiveAfter(abc, 'b', 'b')).toBe('c')
  })

  it('★ 기록이 없고 맨 오른쪽이 빠지면 왼쪽으로 — 오른쪽이 없을 때의 유일한 이웃이다', () => {
    expect(nextActiveAfter(abc, 'c', 'c')).toBe('b')
  })

  it('활성 탭이 아니면 아무것도 안 바뀐다 — 남의 탭이 떠났다고 화면이 움직이면 안 된다', () => {
    expect(nextActiveAfter(abc, 'a', 'c', ['a', 'c', 'b'])).toBe('c')
  })

  it('마지막 하나가 빠지면 없다', () => {
    expect(nextActiveAfter([sess('a')], 'a', 'a', ['a'])).toBeNull()
  })

  it('같은 알림이 두 번 와도 활성 탭이 튀지 않는다 — 두 번째는 이미 옮겨 간 뒤다', () => {
    const mru = ['b', 'a', 'c']
    const after = nextActiveAfter(abc, 'b', 'b', mru) // 'a'(직전에 보던 탭)
    expect(nextActiveAfter([sess('a'), sess('c')], 'b', after, mru)).toBe('a')
  })

  it('★ 직전에 보던 탭이 받는다 — 오른쪽(c)이 아니라 a 다', () => {
    // 기록 앞이 곧 떠나는 세션이다(활성이었으니까) — 그 다음이 "직전에 보던" 탭.
    expect(nextActiveAfter(abc, 'b', 'b', ['b', 'a', 'c'])).toBe('a')
  })

  it('기록에 남은 죽은 세션은 건너뛴다 — 살아 있는 것 중 가장 최근', () => {
    // 'z' 는 이미 닫혔거나 다른 창으로 떠났다(기록은 그걸 모른다).
    expect(nextActiveAfter(abc, 'b', 'b', ['b', 'z', 'c', 'a'])).toBe('c')
  })

  it('기록이 떠나는 세션뿐이면 폴백으로 떨어진다 — 첫 세션을 떼어낸 경우', () => {
    expect(nextActiveAfter(abc, 'a', 'a', ['a'])).toBe('b')
  })
})
