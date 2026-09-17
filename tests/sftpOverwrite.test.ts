// 🔴 업로드가 **서버 파일을 조용히 덮어쓰지 않는가** (2026-09-16 점검에서 잡은 것).
//
// 왜 이 시험이 있나: `sftp.createWriteStream(path)` 는 옵션을 안 주면 flags 가 `'w'` 다 —
// **있으면 잘라 쓴다**(`node_modules/ssh2/lib/protocol/SFTP.js:3852`). 그래서 같은 이름이
// 서버에 있으면 경고도 확인도 없이 내용이 날아갔다. 반대편 로컬은 같은 규칙을 네 곳에서
// 지키고 있었다(`LocalFs.freeName` — *"조용한 덮어쓰기는 조용한 삭제와 같다"*).
//
// ⚠️ 이 시험은 **실제 SFTP 서버에 안 붙는다.** `SFTPWrapper` 를 흉내 내어 "우리가 어느 경로를
//    고르는가"만 본다 — 그것이 이 결함의 전부였다. 실제 전송은 실기 확인 항목이다.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 서버에 이미 있는 이름들. stat 이 **성공하면 있는 것**이다.
function fakeSftp(existing: readonly string[]) {
  const stat = vi.fn((p: string, cb: (err: Error | null, st?: unknown) => void) => {
    if (existing.includes(p)) cb(null, { size: 1 })
    else cb(new Error('ENOENT'))
  })
  return { stat } as unknown as import('ssh2').SFTPWrapper
}

// freeRemotePath 는 private 이라 프로토타입으로 부른다 — 이 판정이 곧 결함의 자리다.
async function freePath(existing: readonly string[], dir: string, name: string): Promise<string> {
  const { SftpService } = await import('../src/main/sftp/SftpService')
  const svc = Object.create(SftpService.prototype) as {
    freeRemotePath(s: unknown, d: string, n: string): Promise<string>
  }
  return svc.freeRemotePath(fakeSftp(existing), dir, name)
}

describe('🔴 업로드가 그 판정을 **실제로 쓰는가** — 함수만 보면 눈이 먼다', () => {
  /**
   * 2026-09-17: 처음엔 `freeRemotePath` 만 시험했는데, **호출을 지워도 6건이 전부 통과했다**
   * (위반을 심어 확인했다). 판정 함수가 맞는 것과 **그 판정을 쓰는 것**은 다른 사실이다 —
   * 이 결함의 본체는 애초에 "안 부른 것"이었다.
   *
   * 그래서 업로드 본문이 그 함수를 지나는지를 **소스로** 본다. 실제 SFTP 에 못 붙는 라운드라
   * 이것이 여기서 잴 수 있는 전부다(실 전송은 실기 확인 항목).
   */
  const src = readFileSync(join(__dirname, '..', 'src/main/sftp/SftpService.ts'), 'utf8')

  it('업로드가 freeRemotePath 를 지난다 — 이 줄이 지워지면 서버 파일이 조용히 날아간다', () => {
    expect(src).toMatch(/const remotePath = await this\.freeRemotePath\(/)
  })

  it('★ 옵션 없는 createWriteStream 을 그대로 쓰지 않는다(flags 기본이 w = 잘라쓰기)', () => {
    // 경로를 freeRemotePath 로 고르므로 스트림 자체는 그대로 둔다 — 다만 **경로를 직접 조립해**
    // 넘기는 옛 모양이 되살아나면 여기서 잡힌다.
    expect(src).not.toMatch(/createWriteStream\(posix\.join\(/)
  })
})

describe('서버 업로드 이름 고르기 (freeRemotePath)', () => {
  it('없으면 그대로 쓴다', async () => {
    expect(await freePath([], '/srv/app', 'a.log')).toBe('/srv/app/a.log')
  })

  it('🔴 있으면 **덮어쓰지 않고** 다음 이름으로 — 이것이 이 시험의 전부다', async () => {
    expect(await freePath(['/srv/app/a.log'], '/srv/app', 'a.log')).toBe('/srv/app/a (2).log')
  })

  it('여러 개가 있으면 빈자리까지 센다', async () => {
    const taken = ['/srv/app/a.log', '/srv/app/a (2).log', '/srv/app/a (3).log']
    expect(await freePath(taken, '/srv/app', 'a.log')).toBe('/srv/app/a (4).log')
  })

  it('★ 이름 규칙이 로컬과 같다 — 두 벌로 갈리면 같은 파일이 서버와 내 PC 에서 다른 이름이 된다', async () => {
    const { nthName } = await import('../src/main/fs/LocalFs')
    const got = await freePath(['/srv/app/보고서.xlsx'], '/srv/app', '보고서.xlsx')
    expect(got).toBe('/srv/app/' + nthName('보고서.xlsx', 2))
  })

  it('확장자 없는 이름도 센다', async () => {
    expect(await freePath(['/srv/app/README'], '/srv/app', 'README')).toBe('/srv/app/README (2)')
  })

  it('★ stat 이 권한 때문에 실패해도 "없다"로 읽는다 — 그 경우 업로드가 서버에서 거절당한다', async () => {
    // 조용히 덮어쓰는 것보다 낫다: 실패는 화면에 그대로 나온다.
    const denied = { stat: vi.fn((_p: string, cb: (e: Error | null) => void) => cb(new Error('EACCES'))) }
    const { SftpService } = await import('../src/main/sftp/SftpService')
    const svc = Object.create(SftpService.prototype) as {
      freeRemotePath(s: unknown, d: string, n: string): Promise<string>
    }
    expect(await svc.freeRemotePath(denied, '/srv', 'x.txt')).toBe('/srv/x.txt')
  })
})
