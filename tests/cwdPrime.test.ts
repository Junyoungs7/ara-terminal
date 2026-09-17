// 복원 직후 **파일 트리와 터미널이 다른 곳을 가리키던 것** (2026-09-17 준영님 제보).
//
// 제보: *"D 드라이브로 옮겨서 쓰던 세션창이 켜진 상태에서 종료하고 다시 들어가면 세션창에는
// D 경로인데 좌측 사이드바는 C:/users/사용자로 되어 있어."*
//
// 렌더러의 `cwdBy` 가 **OSC7 이벤트로만** 채워져서, 셸이 다음에 경로를 알려 줄 때까지 비어 있었다.
// main 은 그 값을 늘 최신으로 들고 있으므로(`MainSessionManager` 가 스폰 cwd 로 시작해 OSC7 마다
// 갱신) **읽어 오기만** 하면 된다.
import { describe, it, expect } from 'vitest'
import { primeCwd } from '../src/renderer/store/cwdPrime'
import type { Session } from '../src/shared/types'

const sess = (id: string, cwd?: string): Session =>
  ({ id, type: 'local', title: id, serverKey: 'localhost', ...(cwd ? { cwd } : {}) }) as Session

describe('main 이 아는 cwd 로 빈 자리 채우기 (primeCwd)', () => {
  it('빈 상태를 채운다 — 복원 직후가 이 경우다', () => {
    expect(primeCwd({}, [sess('a', 'D:/work')])).toEqual({ a: 'D:/work' })
  })

  it('🔴 **이미 아는 것은 덮지 않는다** — 이벤트로 받은 값이 더 최신이다', () => {
    // main 에 물어보는 사이 OSC7 이 먼저 닿을 수 있다. 여기서 덮으면 사용자가 방금 cd 한
    // 자리가 옛 값으로 튕겨 나간다.
    const cur = { a: 'D:/work/sub' }
    expect(primeCwd(cur, [sess('a', 'D:/work')])).toBe(cur)
  })

  it('cwd 가 없는 세션은 건너뛴다(막 뜬 셸)', () => {
    expect(primeCwd({}, [sess('a')])).toEqual({})
  })

  it('★ 바뀐 게 없으면 **같은 객체**를 돌려준다 — 새 객체는 헛 렌더를 한 번 돈다', () => {
    const cur = { a: 'D:/work' }
    expect(primeCwd(cur, [])).toBe(cur)
    expect(primeCwd(cur, [sess('a', 'D:/other')])).toBe(cur)
  })

  it('여럿 중 빈 자리만 채운다', () => {
    const cur = { a: 'D:/a' }
    const got = primeCwd(cur, [sess('a', 'D:/stale'), sess('b', 'D:/b'), sess('c')])
    expect(got).toEqual({ a: 'D:/a', b: 'D:/b' })
  })
})
