// 🔴 접속이 **되묻는가** — 그리고 그 되묻기가 **한 벌인가** (#201 A-1).
//
// 2026-09-16 준영님 제보: *"세션이 끊기면 다시 접속 버튼을 눌러도 재접속에 실패했다고 계속
// 나온다. putty 로는 접속이 된다."* 원인은 복구 분기(호스트키 첫 접속 확인 · 저장된 비밀번호가
// 없을 때 그 자리에서 받기)가 `Shell.connectProfile` **안에만** 있었던 것이다 — putty 는 물어보고
// 우리는 안 물어봤다.
//
// 그 절차를 `store/sshConnect.ts` 로 떼어내 떼어낸 창도 같은 것을 쓰게 했다. 여기서 재는 것은
// **그 절차 자체**다: 무엇을 묻고, 답에 따라 무엇을 다시 시도하고, 취소를 어떻게 다루는가.
import { describe, it, expect, vi } from 'vitest'
import { connectWithRecovery, type ConnectDeps } from '../src/renderer/store/sshConnect'
import type { SshConnectResult } from '../src/shared/ipc'

const OK: SshConnectResult = { ok: true, id: 's1', title: 'web-01' }
const HOSTKEY_NEW: SshConnectResult = {
  ok: false,
  reason: 'hostKeyNew',
  hostId: 'web-01:22',
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:aaa'
}
const ORPHAN: SshConnectResult = { ok: false, reason: 'orphanSecret' }
const AUTH: SshConnectResult = { ok: false, reason: 'auth', message: 'Permission denied' }

/** `connect` 가 호출 순서대로 이 결과들을 돌려준다. 마지막 것을 이후에도 계속 돌려준다. */
function rig(results: SshConnectResult[], answers?: { ask?: 'confirm' | 'cancel'; pw?: string | null }) {
  const connect = vi.fn(async (..._args: unknown[]) => results[Math.min(connect.mock.calls.length - 1, results.length - 1)])
  const ask = vi.fn(async () => answers?.ask ?? 'cancel')
  const askText = vi.fn(async () => (answers?.pw === undefined ? null : answers.pw))
  const showFailure = vi.fn(async () => {})
  const deps = { connect, lookup: async () => undefined, ask, askText, showFailure } as unknown as ConnectDeps
  return { deps, connect, ask, askText, showFailure }
}

describe('connectWithRecovery — 호스트키 첫 접속(TOFU)', () => {
  it('★ 지문을 보여 주고 승낙하면 acceptHostKey:true 로 **다시 시도**한다', async () => {
    const { deps, connect, ask } = rig([HOSTKEY_NEW, OK], { ask: 'confirm' })
    const res = await connectWithRecovery(deps, 'p1')
    expect(res).toEqual({ ok: true, id: 's1', title: 'web-01' })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect.mock.calls[0][1]).toBeUndefined() // 첫 시도는 승낙 없이
    expect(connect.mock.calls[1][1]).toBe(true) // 재시도만 승낙을 싣는다
  })

  it('취소하면 실패다 — **실패 안내를 또 내지 않는다**(사람이 스스로 멈춘 것이다)', async () => {
    const { deps, connect, showFailure } = rig([HOSTKEY_NEW], { ask: 'cancel' })
    expect(await connectWithRecovery(deps, 'p1')).toEqual({ ok: false })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(showFailure).not.toHaveBeenCalled()
  })
})

describe('connectWithRecovery — 저장된 비밀번호가 없을 때(orphanSecret)', () => {
  it('★ 그 자리에서 받은 비밀번호로 **다시 시도**한다(저장하지 않는다 — 인자로만 간다)', async () => {
    const { deps, connect, askText } = rig([ORPHAN, OK], { pw: 'hunter2' })
    expect(await connectWithRecovery(deps, 'p1')).toEqual({ ok: true, id: 's1', title: 'web-01' })
    expect(askText).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect.mock.calls[1][2]).toBe('hunter2')
  })

  it('★ 취소하면 `{ok:false}` 다 — 빈 비밀번호로 한 번 더 때리지 않는다', async () => {
    const { deps, connect, showFailure } = rig([ORPHAN], { pw: null })
    expect(await connectWithRecovery(deps, 'p1')).toEqual({ ok: false })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(showFailure).not.toHaveBeenCalled()
  })
})

describe('connectWithRecovery — 그 밖', () => {
  it('★ 성공 경로가 winId 를 connect 에 **그대로** 넘긴다 — 없으면 새 세션이 본창에 뜬다', async () => {
    const { deps, connect } = rig([OK])
    const size = { cols: 120, rows: 40 }
    await connectWithRecovery(deps, 'p1', { size, winId: 'win-2' })
    expect(connect.mock.calls[0][3]).toEqual(size)
    expect(connect.mock.calls[0][5]).toBe('win-2')
  })

  it('되물을 수 없는 실패는 주입받은 showFailure 에 넘긴다(창마다 다른 것은 주입한다)', async () => {
    const { deps, showFailure } = rig([AUTH])
    expect(await connectWithRecovery(deps, 'p1')).toEqual({ ok: false })
    expect(showFailure).toHaveBeenCalledWith('p1', AUTH)
  })
})

// ⚠️ **여기서 안 재는 것**: 서버가 같은 사유를 계속 돌려주고 사람이 계속 답하면 이 함수는 계속
//    다시 시도한다(재귀에 상한이 없다 — 옮겨 오기 전 `Shell.connectProfile` 도 같았다).
//    매 바퀴가 사람의 다이얼로그 답을 기다리므로 [취소] 하나로 멈추고, 그래서 이번 라운드에서
//    상한을 두지 않았다. 자동 재시도가 생기는 날 이 문장이 그 자리를 가리킨다.
