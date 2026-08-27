/**
 * 백그라운드 서버의 로그 추적(2026-08-27 준영님 요청).
 *
 * > *"원격 서버에서 실행 중인 ai가 백그라운드로 띄운 서버의 로그를 실시간으로 확인"*
 *
 * **실측으로 정한 갈래다**(WSL). 같은 서버를 세 방식으로 띄워 `/proc/<pid>/fd/1` 을 읽어 봤다:
 *   `> a.log 2>&1 &` → `/tmp/…/a.log`   tmux → `/dev/pts/6`   그냥 `&` → `pipe:[20023050]`
 * 그리고 tmux 는 `pipe-pane` 으로 **이미 돌고 있는** 팬을 파일로 실시간 복사할 수 있다(확인함).
 */
import { describe, it, expect } from 'vitest'
import { COMMANDS, parseAppTrace, validPane, validPort } from '../src/shared/remoteCatalog'

const trace = (lines: string[], port = 8000) => parseAppTrace(lines.join('\n'), port)

describe('추적 결과 읽기', () => {
  it('★ stdout 이 파일이면 그 경로를 준다 — 그대로 tail 하면 된다', () => {
    const r = trace(['pid=1234', 'fd1=/srv/app/out.log', 'pane=', 'cmd=node server.js'])
    expect(r).toMatchObject({ kind: 'file', pid: 1234, path: '/srv/app/out.log', cmd: 'node server.js' })
  })

  it('★ tmux 팬이면 팬 이름과 만들 파일 자리를 준다', () => {
    const r = trace(['pid=99', 'fd1=/dev/pts/6', 'pane=dev:0.1'], 8080)
    expect(r).toMatchObject({ kind: 'tmux', pane: 'dev:0.1', path: '/tmp/ara-tail-8080.log' })
  })

  it('터미널인데 tmux 가 아니면 tty — 그 화면을 보는 사람만 본다', () => {
    expect(trace(['pid=99', 'fd1=/dev/pts/3', 'pane=']).kind).toBe('tty')
  })

  it('파이프·/dev/null 은 원리상 못 본다(그렇게 말해야 한다)', () => {
    expect(trace(['pid=99', 'fd1=pipe:[20023050]']).kind).toBe('pipe')
    expect(trace(['pid=99', 'fd1=/dev/null']).kind).toBe('null')
  })

  it('그 포트를 듣는 프로세스가 없으면 none', () => {
    expect(trace(['pid=']).kind).toBe('none')
    expect(trace([]).kind).toBe('none')
  })

  /**
   * ★ 실측에서 나온 위험 — cmdline 은 **남의 프로세스 인자**다. 거기에 개행과 `pane=` 을 심으면
   * 우리 파서가 속을 수 있었다. 그래서 명령이 cmd 를 **한 줄로 눌러 맨 끝에** 낸다.
   */
  it('★ cmd 안에 pane= 이 들어 있어도 진짜 pane 을 덮지 못한다', () => {
    const r = trace(['pid=1', 'fd1=/var/log/a.log', 'pane=', 'cmd=node x.js --evil=y pane=hack:0.0'])
    expect(r.kind).toBe('file')
    expect(r.pane).toBeUndefined()
  })
})

describe('명령 조립', () => {
  it('포트가 숫자가 아니면 아무것도 만들지 않는다', () => {
    expect(COMMANDS['app.trace'].build({ port: '8000; rm -rf /' })).toBeNull()
    expect(COMMANDS['app.trace'].build({ port: 0 })).toBeNull()
    expect(COMMANDS['app.trace'].build({ port: 70000 })).toBeNull()
    expect(validPort(8000)).toBe(8000)
  })

  it('★ 팬 이름은 우리가 준 형식만 받는다 — 셸 인용 안에 들어가는 값이다', () => {
    expect(validPane('dev:0.1')).toBe('dev:0.1')
    expect(validPane("dev:0.1' ; rm -rf / ; '")).toBeNull()
    expect(validPane('dev')).toBeNull()
    expect(validPane(42)).toBeNull()
  })

  it('pipe 는 쓰기다 — 남의 팬에 리다이렉트를 거는 일이라 확인을 받아야 한다', () => {
    expect(COMMANDS['app.pipe'].write).toBe(true)
    const cmd = COMMANDS['app.pipe'].build({ pane: 'dev:0.1', port: 8080 })
    expect(cmd).toContain("pipe-pane -o -t 'dev:0.1'")
    expect(cmd).toContain('/tmp/ara-tail-8080.log')
  })

  it('추적은 읽기만 한다(readlink·list-panes 뿐)', () => {
    expect(COMMANDS['app.trace'].write).toBeUndefined()
    const cmd = COMMANDS['app.trace'].build({ port: 8000})!
    expect(cmd).toContain('readlink')
    expect(cmd).not.toContain('rm ')
  })
})
