// 콘솔이 붙이는 `<경로>.exe - <명령>` 제목에서 명령만 남긴다 (2026-09-29 준영님).
// PowerShell 탭에서 cmd 로 들어가 `cd ..` 하면 제목이 `…\powershell.exe - cd ..` 로 와서, 셸은 cmd 인데
// 탭은 PowerShell 로 돌아간 것처럼 보였다.
import { describe, it, expect } from 'vitest'
import { tidyShellTitle } from '../src/main/sessions/MainSessionManager'

describe('tidyShellTitle', () => {
  it('제보의 그 제목 → 명령만', () => {
    expect(tidyShellTitle(String.raw`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe - cd ..`)).toBe('cd ..')
  })
  it('슬래시 경로도', () => expect(tidyShellTitle('C:/Tools/cmd.exe - npm run dev')).toBe('npm run dev'))
  it('양성 대조 — 셸이 일부러 세운 제목은 안 건드린다', () => {
    expect(tidyShellTitle('deploy@web-01: ~/svc')).toBe('deploy@web-01: ~/svc')
    expect(tidyShellTitle('jun@kvt:~')).toBe('jun@kvt:~')
  })
  it('경로 없는 exe 이름 + 명령은 그대로(사람이 그렇게 지었을 수 있다)', () => {
    expect(tidyShellTitle('build.exe - done')).toBe('build.exe - done')
  })
})

// 함수가 맞는 것과 **탭 제목 경로가 그 함수를 쓰는 것**은 다른 사실이다 — 처음엔 위만 있어서,
// autoTitle 에서 호출을 빼도 전부 통과했다(위반을 심어 확인했다).
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import type { SessionBackend } from '../src/main/sessions/SessionBackend'
describe('autoTitle 이 제목을 다듬어 저장하고 돌려준다', () => {
  it('🔴 제보의 제목 → 탭에는 cd .. 가 저장된다', () => {
    const mgr = new MainSessionManager({ data() {}, exit() {}, cwd() {} })
    const b: SessionBackend = { write() {}, resize() {}, pause() {}, resume() {}, kill() {}, onData() {}, onExit() {} }
    mgr.adopt(b, { type: 'local', title: '셸 1', serverKey: 'localhost', profileId: null, cwd: undefined, shell: undefined }, 'a')
    expect(mgr.autoTitle('a', String.raw`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe - cd ..`)).toBe('cd ..')
    expect(mgr.snapshot()[0].title).toBe('cd ..')
  })
})
