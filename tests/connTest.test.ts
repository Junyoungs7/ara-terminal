import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { ProfileStore } from '../src/main/secrets/ProfileStore'
import type { SecretStore } from '../src/main/secrets/SecretStore'
import { testProfile } from '../src/main/ipc/registerSshIpc'
import { emptyForm } from '../src/renderer/components/ConnectionModal'

// 2026-08-21 준영님 실사용 제보 R1 — "신규 서버 등록시 비밀번호가 전부 틀리대".
//
// 원인은 **연결 관리자 신규 폼의 기본 인증 방식이 [키]** 였던 것이다. 그 상태에서 아래 칸 라벨은
// "패스프레이즈"이고, 거기에 서버 비밀번호를 넣으면 없는 키 파일로 인증을 시도하며 그 값은
// cfg.passphrase 로 들어간다 → 항상 실패. 여기 두 갈래를 못으로 박는다:
//   ① 신규 폼 기본값이 다시 'key' 로 돌아가지 않게 (회귀 가드)
//   ② [접속 테스트]가 **저장 없이** 도는지 (vault·workspace 를 건드리면 [저장]과 구분이 사라진다)

class MemVault implements SecretStore {
  private m = new Map<string, string>()
  get(k: string): string | null {
    return this.m.get(k) ?? null
  }
  set(k: string, v: string): void {
    this.m.set(k, v)
  }
  delete(k: string): void {
    this.m.delete(k)
  }
  has(k: string): boolean {
    return this.m.has(k)
  }
  size(): number {
    return this.m.size
  }
}

/** 리스너를 열었다 닫아 **확실히 아무도 안 듣는** 포트 번호를 얻는다(즉시 ECONNREFUSED). */
async function closedPort(): Promise<number> {
  const net = await import('node:net')
  const srv = net.createServer()
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res))
  const addr = srv.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise<void>((res) => srv.close(() => res()))
  return port
}

describe('연결 관리자 신규 폼 (제보 30)', () => {
  it('기본 인증 방식은 비밀번호다 — 키로 되돌리면 그 사고가 재발한다', () => {
    expect(emptyForm.authType).toBe('password')
  })
})

describe('[접속 테스트] (제보 19)', () => {
  let dir: string
  let ws: WorkspaceStore
  let vault: MemVault
  let profiles: ProfileStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ara-conntest-'))
    ws = new WorkspaceStore(join(dir, 'workspace.json'), '0.1.0')
    vault = new MemVault()
    profiles = new ProfileStore(ws, vault)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('호스트·사용자가 비면 네트워크를 건드리기 전에 되돌아온다', async () => {
    const r = await testProfile(profiles, ws, {
      name: '새 서버',
      host: '',
      port: 22,
      username: '',
      authType: 'password'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('network')
  })

  it('시험만 하고 프로필도 비밀도 남기지 않는다 — 그게 [저장]과 가르는 점이다', async () => {
    // 결과(실패)가 아니라 **부작용이 없는 것**이 이 테스트의 관심사다. 확실히 닫힌 포트가 필요해
    // 리스너를 열었다 바로 닫는다 — `port: 1` 같은 예약 포트는 Windows 에서 즉시 거절되지 않고
    // 8초 상한까지 매달려 vitest 기본 타임아웃(5초)에 걸린다(실측).
    const port = await closedPort()
    await testProfile(profiles, ws, {
      name: '테스트',
      host: '127.0.0.1',
      port,
      username: 'nobody',
      authType: 'password',
      secret: 'hunter2'
    })
    expect(profiles.list()).toHaveLength(0)
    expect(vault.size()).toBe(0)
  })

  it('RDP 는 도달까지만 본다고 말한다(비밀번호 검증은 실제 접속에서)', async () => {
    // 임시 리스너를 열어 "닿는" 경우를 만든다. 포트는 OS 가 준다.
    const net = await import('node:net')
    const srv = net.createServer()
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res))
    const addr = srv.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const r = await testProfile(profiles, ws, {
      type: 'rdp',
      name: 'rdp',
      host: '127.0.0.1',
      port,
      username: 'user'
    })
    srv.close()

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.note).toBe('rdpReachOnly')
    // 여기서도 아무것도 저장하지 않는다.
    expect(profiles.list()).toHaveLength(0)
    expect(vault.size()).toBe(0)
  })
})
