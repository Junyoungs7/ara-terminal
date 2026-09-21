// 🔴 세션을 **없앨 때 알리는 짝**이 있는가 — 그리고 **언제** 알리는가 (#201 B).
//
// 만들 때는 `sink.opened` 가 있었는데 없앨 때는 0건이었다. 그래서 아라가 MCP `session_destroy`
// 로 탭을 끄면 화면이 영영 몰랐다 — 탭·칸·상태점이 남고, SSH 면 뒤따르는 exit 이
// "연결이 끊겼습니다" 재접속 카드를 띄웠다(아라가 **일부러** 끈 세션에).
//
// 이 시험이 지키는 것은 **순서**다: `closed` 는 `kill()` 보다 먼저, 그리고 **핸들을 지우기 전에**
// 나가야 한다. 라우터가 `winIdOf(id)` 로 보낼 창을 찾기 때문에, 지운 뒤에 쏘면 그 값이 없어
// 본창으로 떨어진다(떼어낸 창이 자기 탭이 닫힌 것을 못 받는다 — #201 B-4 가 바로 그 증상이다).
import { describe, it, expect } from 'vitest'
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import type { SessionSink } from '../src/main/sessions/ISessionManager'
import type { SessionBackend } from '../src/main/sessions/SessionBackend'
import type { Session } from '../src/shared/types'

// 실제 pty 를 띄우지 않는다 — 이 결함은 전부 **호출 순서**이고, 그건 adopt 한 가짜 백엔드로 잰다.
function rig() {
  const calls: string[] = []
  const closed: Session[] = []
  /**
   * 알림이 **나가는 순간** 라우터가 창을 찾을 수 있었나.
   *
   * meta 객체만 보면 안 된다 — 핸들을 지워도 그 객체는 그대로라 `meta.winId` 는 지운 뒤에 쏴도
   * 살아 있다(실제로 위반을 심어 확인했다: 그 단언은 안 물었다). 라우터가 실제로 보는 것은
   * `winIdOf(id)`, 즉 **핸들 맵**이다. 그래서 콜백 안에서 그 값을 잰다.
   */
  const routable: (string | undefined)[] = []
  const sink: SessionSink = {
    data() {},
    exit() {},
    cwd() {},
    closed(meta) {
      calls.push(`closed:${meta.id}`)
      closed.push(meta)
      routable.push(mgr.winIdOf(meta.id))
    }
  }
  const mgr = new MainSessionManager(sink)
  const backend = (id: string): SessionBackend => ({
    write() {},
    resize() {},
    pause() {},
    resume() {},
    kill() {
      calls.push(`kill:${id}`)
    },
    onData() {},
    onExit() {}
  })
  const add = (id: string, winId?: string): string =>
    mgr.adopt(
      backend(id),
      {
        type: 'ssh',
        title: id,
        serverKey: 'web-01',
        profileId: 'p1',
        cwd: undefined,
        shell: undefined,
        ...(winId ? { winId } : {})
      },
      id
    )
  return { mgr, calls, closed, routable, add }
}

describe('#201 B — destroy 가 closed 를 쏜다', () => {
  it('★ closed 가 kill() 보다 **먼저** 나간다 — 이 순서가 렌더러 쪽 배선의 전제다', () => {
    const { mgr, calls, add } = rig()
    add('a')
    mgr.destroy('a')
    expect(calls).toEqual(['closed:a', 'kill:a'])
  })

  it('★ 알림이 나가는 순간 라우터가 그 창을 **찾을 수 있다** — 지우기 전에 쐈다는 증거', () => {
    const { mgr, closed, routable, add } = rig()
    add('a', 'win-2')
    mgr.destroy('a')
    expect(closed.map((m) => m.winId)).toEqual(['win-2'])
    // 이 줄이 본체다: 지운 뒤에 쐈다면 여기가 undefined 이고, 그러면 본창으로 떨어진다.
    expect(routable).toEqual(['win-2'])
    expect(mgr.winIdOf('a')).toBeUndefined() // 알림이 끝나면 물론 없다
  })

  it('없는 세션을 destroy 하면 아무 일도 없다(두 번 닫아도 알림이 두 번 가지 않는다)', () => {
    const { mgr, calls, add } = rig()
    add('a')
    mgr.destroy('a')
    mgr.destroy('a')
    expect(calls.filter((c) => c.startsWith('closed:'))).toEqual(['closed:a'])
  })

  it('destroyAll(앱 종료)도 세션 수만큼 closed 를 쏜다 — 종료 경로가 이 문을 함께 지난다', () => {
    const { mgr, closed, add } = rig()
    add('a', 'win-2')
    add('b')
    add('c')
    mgr.destroyAll()
    expect(closed.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(mgr.snapshot()).toEqual([])
  })
})
