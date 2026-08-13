// SSH cd → 좌측 파일 트리 cwd 동기 실증. ssh2 하네스로 끝까지 태운다
// (SshBackend → 원격 /proc 읽기 → MainSessionManager → sink.cwd).
//
// 역사: 예전에는 접속 직후 셸 통합 스니펫을 stdin 으로 주입해 OSC7 을 유도했다. 그런데 대화형
// bash/zsh 는 readline/zle 이 입력을 **직접 그려서** 그 스니펫이 접속할 때마다 화면에 그대로 보였다
// (준영님 제보 · 백로그 M-9). 지금은 셸을 전혀 건드리지 않고, 같은 커넥션의 exec 로 셸 PID 를 찾아
// sftp readlink 로 /proc/<pid>/cwd 를 읽는다(ssh/remoteCwd.ts).
import { describe, it, expect, afterEach } from 'vitest'
import { connectSsh } from '../src/main/sessions/ssh/SshBackend'
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import { startPasswordServer, type Harness } from './ssh-harness'
import type { SshProfile } from '../src/shared/types'

let harness: Harness | null = null
afterEach(async () => {
  if (harness) await harness.close()
  harness = null
})

function pwProfile(port: number): SshProfile {
  return {
    id: 'p1',
    name: 'harness',
    host: '127.0.0.1',
    port,
    username: 'tester',
    type: 'ssh',
    auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('조건이 시간 안에 만족되지 않았습니다')
    await wait(10)
  }
}

// 접속 → 세션 편입까지. cwds 에 sink.cwd 알림이, shellIn 에 셸 채널로 실제로 간 바이트가 쌓인다.
async function openSession(h: Harness): Promise<{ id: string; mgr: MainSessionManager; cwds: string[] }> {
  const cwds: string[] = []
  const mgr = new MainSessionManager({
    data() {},
    exit() {},
    cwd(_id, cwd) {
      cwds.push(cwd)
    }
  })
  const res = await connectSsh(pwProfile(h.port), {
    knownHosts: {},
    secret: h.password,
    acceptHostKey: true,
    onHostKeyAccepted: () => {}
  })
  if (!res.ok) throw new Error('connect failed: ' + res.reason)
  const id = mgr.adopt(res.backend, { type: 'ssh', title: 't', serverKey: 'harness', cwd: undefined })
  return { id, mgr, cwds }
}

describe('SSH cd → 파일 트리 cwd 동기 (셸을 건드리지 않는 /proc 추적)', () => {
  it('셸 채널로는 아무것도 안 보낸다 — 사용자가 친 것만 간다(M-9 회귀 가드)', async () => {
    const shellIn: string[] = []
    harness = await startPasswordServer({ procCwd: { pid: 4242 }, onShellData: (d) => shellIn.push(d) })
    const { id, mgr, cwds } = await openSession(harness)
    // 로그인 디렉토리를 읽어 올 때까지 기다린다(= 추적이 실제로 붙은 시점).
    await waitFor(() => cwds.includes('/home/tester'), 3000)
    expect(shellIn).toEqual([]) // 여기까지 셸에 들어간 입력: 없음
    mgr.write(id, 'ls\n')
    await wait(100)
    expect(shellIn.join('')).toBe('ls\n') // 사용자가 친 것 그대로, 덤은 없다
    mgr.destroy(id)
  }, 10000)

  it('cd 하면 cwd 알림이 따라온다 — 반복해도 계속 따라온다', async () => {
    harness = await startPasswordServer({ procCwd: { pid: 4242 } })
    const { id, mgr, cwds } = await openSession(harness)
    await waitFor(() => cwds.includes('/home/tester'), 3000)
    mgr.write(id, 'cd /var/log\n')
    await waitFor(() => cwds.includes('/var/log'), 3000)
    mgr.write(id, 'cd /etc/nginx\n')
    await waitFor(() => cwds.includes('/etc/nginx'), 3000)
    // 같은 자리에 머무르면 같은 값을 다시 쏘지 않는다(트리가 매 프롬프트마다 새로고침되면 안 된다).
    const before = cwds.length
    mgr.write(id, 'echo hi\n')
    await wait(400)
    expect(cwds.length).toBe(before)
    mgr.destroy(id)
  }, 15000)

  it('/proc 이 없는 서버(비리눅스)에서는 조용히 포기한다 — 세션은 멀쩡하다', async () => {
    harness = await startPasswordServer({ procCwd: { pid: 4242, procMissing: true } })
    const { id, mgr, cwds } = await openSession(harness)
    mgr.write(id, 'cd /var/log\n')
    await wait(700)
    expect(cwds).toEqual([]) // 자동 동기는 없다(기존 "미지원" 안내 경로)
    mgr.destroy(id)
  }, 10000)
})
