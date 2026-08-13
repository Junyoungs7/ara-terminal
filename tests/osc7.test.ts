import { describe, it, expect } from 'vitest'
import { parseOsc7Cwd, SHELL_INTEGRATION } from '../src/main/sessions/osc7'
import { SHELL_PID_CMD, cwdLink, parseShellPid } from '../src/main/sessions/ssh/remoteCwd'

const ESC = '\x1b'
const BEL = '\x07'
const osc7 = (url: string, term: 'bel' | 'st' = 'bel') =>
  `${ESC}]7;${url}${term === 'bel' ? BEL : ESC + '\\'}`

describe('parseOsc7Cwd (F6 로컬 CWD 추적)', () => {
  it('POSIX 경로를 추출한다(BEL 종결)', () => {
    expect(parseOsc7Cwd(osc7('file://myhost/home/deploy/app'))).toBe('/home/deploy/app')
  })

  it('ST(ESC \\) 종결도 처리한다', () => {
    expect(parseOsc7Cwd(osc7('file://host/var/log', 'st'))).toBe('/var/log')
  })

  it('Windows 드라이브 경로는 선행 슬래시를 제거한다', () => {
    expect(parseOsc7Cwd(osc7('file://PC/C:/Users/dev/work'))).toBe('C:/Users/dev/work')
  })

  it('퍼센트 인코딩된 경로를 디코드한다(공백 등)', () => {
    expect(parseOsc7Cwd(osc7('file://h/home/dev/my%20app'))).toBe('/home/dev/my app')
  })

  it('OSC7 이 없으면 null(일반 출력은 무시)', () => {
    expect(parseOsc7Cwd('hello world\r\n$ ls -la\r\n')).toBeNull()
  })

  it('여러 OSC7 이 있으면 마지막(가장 최근 cwd)을 쓴다', () => {
    const data = osc7('file://h/a') + 'ls\r\n' + osc7('file://h/b/c')
    expect(parseOsc7Cwd(data)).toBe('/b/c')
  })

  it('일반 출력 사이에 낀 OSC7 도 추출한다', () => {
    const data = `prompt${osc7('file://h/srv/www')}$ `
    expect(parseOsc7Cwd(data)).toBe('/srv/www')
  })
})

// 백로그 M-9: SSH 는 더 이상 셸에 아무것도 주입하지 않는다(remoteCwd.ts 로 대체). 되살아나면
// 접속할 때마다 화면에 스크립트가 찍히므로 여기서 못 박는다.
describe('SHELL_INTEGRATION (SSH 주입 폐지)', () => {
  it('SSH 용 주입 문자열이 없다', () => {
    expect('ssh' in SHELL_INTEGRATION).toBe(false)
  })

  it('남은 통합 경로는 로컬 전용(스폰 인자·env)이라 화면에 안 보인다', () => {
    // powershell = -EncodedCommand, bashPromptCommand = env PROMPT_COMMAND, posix = zsh stdin 폴백.
    expect(Object.keys(SHELL_INTEGRATION).sort()).toEqual(['bashPromptCommand', 'posix', 'powershell'])
  })
})

describe('remoteCwd (셸을 건드리지 않는 원격 CWD 추적)', () => {
  it('PID 질의는 tty 없는 형제 채널(exec·sftp)을 걸러낸다', () => {
    // $PPID = 이 커넥션의 sshd 세션. 그 자식 중 tty 를 가진 것 = 대화형 셸.
    expect(SHELL_PID_CMD).toContain('$PPID')
    expect(SHELL_PID_CMD).toContain('$3!="?"')
  })

  it('질의 출력에서 PID 를 뽑고, 없으면 null 로 추적을 포기한다', () => {
    expect(parseShellPid('12345\n')).toBe(12345)
    expect(parseShellPid(' 12345 \n67890\n')).toBe(12345) // 첫 줄만
    expect(parseShellPid('')).toBeNull()
    expect(parseShellPid('\n')).toBeNull()
    expect(parseShellPid('ps: command not found\n')).toBeNull()
    expect(parseShellPid('0\n')).toBeNull()
  })

  it('cwd 는 /proc/<pid>/cwd 심볼릭 링크에서 읽는다', () => {
    expect(cwdLink(4242)).toBe('/proc/4242/cwd')
  })
})
