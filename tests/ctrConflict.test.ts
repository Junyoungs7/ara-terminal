// 오류 신고 #11 — 컨테이너 시작·새로 만들기 전 포트·이름 확인, 그리고 `run` 명령 조립.
//
// 지키는 것 셋:
//  1) **파싱**: docker·podman·ss 의 실제 출력 모양을 읽는다(잘못 읽으면 엉뚱한 컨테이너를 지우자고 한다).
//  2) **판정**: 누가 막고 있나 → 어떤 다이얼로그인가(순수 함수 — 화면은 결과만 그린다).
//  3) **조립**: 렌더러 값이 원격 셸에서 글자 그대로 남는가. 가짜 docker(셸 함수)를 실제 sh 로 돌려
//     인자를 받아 본다 — 서버에는 아무것도 나가지 않는다.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  conflictChoice,
  findConflicts,
  isPortClash,
  needsStop,
  parseBindings,
  parsePortsProbe,
  parsePsPorts,
  parseRunForm,
  parseSs,
  portsClash,
  uniqueCtrs,
  type RunForm
} from '../src/shared/ctrConflict'
import { HUMAN_ONLY, PORTS_PB, PORTS_SS, buildCommand, buildCtrRunArgs, type CtrRow } from '../src/shared/remoteCatalog'

const row = (over: Partial<CtrRow>): CtrRow => ({
  id: 'a'.repeat(64),
  name: 'x',
  image: 'img',
  state: 'running',
  status: 'Up 1 hour',
  ports: '',
  ...over
})

describe('파싱', () => {
  it('docker ps Ports — v4·v6·범위·EXPOSE 만', () => {
    expect(parsePsPorts('0.0.0.0:8512->6379/tcp, :::8512->6379/tcp')).toEqual([
      { ip: '', port: 8512, proto: 'tcp' },
      { ip: '', port: 8512, proto: 'tcp' }
    ])
    expect(parsePsPorts('[::]:8512->6379/tcp')).toEqual([{ ip: '', port: 8512, proto: 'tcp' }])
    expect(parsePsPorts('127.0.0.1:5432->5432/tcp')).toEqual([{ ip: '127.0.0.1', port: 5432, proto: 'tcp' }])
    expect(parsePsPorts('0.0.0.0:8000-8002->8000-8002/tcp').map((p) => p.port)).toEqual([8000, 8001, 8002])
    expect(parsePsPorts('0.0.0.0:53->53/udp')).toEqual([{ ip: '', port: 53, proto: 'udp' }])
    // publish 안 한 EXPOSE 는 호스트를 안 잡는다
    expect(parsePsPorts('6379/tcp')).toEqual([])
    expect(parsePsPorts('')).toEqual([])
  })

  it('inspect PortBindings — null·빈 HostPort·못 읽음', () => {
    expect(parseBindings('{"6379/tcp":[{"HostIp":"","HostPort":"8512"}]}')).toEqual([{ ip: '', port: 8512, proto: 'tcp' }])
    expect(parseBindings('{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}],"53/udp":[{"HostIp":"","HostPort":"53"}]}')).toEqual([
      { ip: '127.0.0.1', port: 8080, proto: 'tcp' },
      { ip: '', port: 53, proto: 'udp' }
    ])
    expect(parseBindings('null')).toEqual([])
    expect(parseBindings('{}')).toEqual([])
    // 임의 포트(빈 HostPort)는 다툴 일이 없다
    expect(parseBindings('{"6379/tcp":[{"HostIp":"","HostPort":""}]}')).toEqual([])
    // 없는 컨테이너 — 오류 문장은 "모름"(null)이지 "포트 없음"이 아니다
    expect(parseBindings('Error: No such object: abc')).toBeNull()
    expect(parseBindings('')).toBeNull()
  })

  it('ss — 프로세스 있음·없음·머리줄·v6', () => {
    const out = [
      'Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
      'tcp   LISTEN 0      511          0.0.0.0:8512      0.0.0.0:*    users:(("docker-proxy",pid=2345,fd=4))',
      'tcp   LISTEN 0      128             [::]:22           [::]:*',
      'udp   UNCONN 0      0       127.0.0.53%lo:53        0.0.0.0:*'
    ].join('\n')
    expect(parseSs(out)).toEqual([
      { ip: '', port: 8512, proto: 'tcp', proc: 'docker-proxy', pid: 2345 },
      { ip: '', port: 22, proto: 'tcp', proc: null, pid: null },
      { ip: '127.0.0.53', port: 53, proto: 'udp', proc: null, pid: null }
    ])
  })

  it('ctr.ports 출력 두 칸', () => {
    const out = `${PORTS_PB}\n{"6379/tcp":[{"HostIp":"","HostPort":"8512"}]}\n${PORTS_SS}\ntcp LISTEN 0 1 0.0.0.0:8512 0.0.0.0:* users:(("nginx",pid=9,fd=1))\n`
    expect(parsePortsProbe(out)).toEqual({
      bindings: [{ ip: '', port: 8512, proto: 'tcp' }],
      listeners: [{ ip: '', port: 8512, proto: 'tcp', proc: 'nginx', pid: 9 }]
    })
    // id 없이 부른 것(새 컨테이너) — 바인딩은 모름
    expect(parsePortsProbe(`${PORTS_PB}\n${PORTS_SS}\n`).bindings).toBeNull()
    // 표식이 없는 출력은 아무것도 믿지 않는다
    expect(parsePortsProbe('sh: ss: not found')).toEqual({ bindings: null, listeners: [] })
  })
})

describe('판정', () => {
  const want = [{ ip: '', port: 8512, proto: 'tcp' }]

  it('주소 겹침 — 전체 주소는 누구와도, 특정 주소끼리는 같을 때만, 프로토콜이 다르면 아님', () => {
    expect(portsClash({ ip: '', port: 1, proto: 'tcp' }, { ip: '127.0.0.1', port: 1, proto: 'tcp' })).toBe(true)
    expect(portsClash({ ip: '10.0.0.1', port: 1, proto: 'tcp' }, { ip: '127.0.0.1', port: 1, proto: 'tcp' })).toBe(false)
    expect(portsClash({ ip: '[::]', port: 1, proto: 'tcp' }, { ip: '10.0.0.1', port: 1, proto: 'tcp' })).toBe(true)
    expect(portsClash({ ip: '', port: 1, proto: 'udp' }, { ip: '', port: 1, proto: 'tcp' })).toBe(false)
    expect(portsClash({ ip: '', port: 1, proto: 'tcp' }, { ip: '', port: 2, proto: 'tcp' })).toBe(false)
  })

  it('★ 제보 재현 — 8512 를 jarvis-redis 가 쓰면 그 컨테이너를 짚고 [정지/제거] 갈래', () => {
    const rows = [
      row({ id: '1'.repeat(64), name: 'jarvis-redis', image: 'redis:7-alpine', ports: '0.0.0.0:8512->6379/tcp, :::8512->6379/tcp' }),
      row({ id: '2'.repeat(64), name: 'web', ports: '0.0.0.0:80->80/tcp' })
    ]
    const ss = parseSs('tcp LISTEN 0 1 0.0.0.0:8512 0.0.0.0:* users:(("docker-proxy",pid=1,fd=1))')
    const c = findConflicts(want, rows, ss)
    expect(c.ctrs.map((x) => x.name)).toEqual(['jarvis-redis'])
    // docker-proxy 는 그 컨테이너의 그림자다 — 프로세스로 다시 세면 "안내만"으로 떨어진다
    expect(c.procs).toEqual([])
    expect(conflictChoice(c)).toBe('resolve')
  })

  it('멈춘 컨테이너는 포트를 안 쥔다 · 자기 자신은 뺀다', () => {
    const stopped = row({ state: 'exited', ports: '0.0.0.0:8512->6379/tcp' })
    expect(conflictChoice(findConflicts(want, [stopped], []))).toBe('none')
    const self = row({ id: 'f'.repeat(64), ports: '0.0.0.0:8512->6379/tcp' })
    expect(conflictChoice(findConflicts(want, [self], [], ['f'.repeat(64)]))).toBe('none')
    // 일시정지도 포트를 쥔다
    expect(conflictChoice(findConflicts(want, [row({ state: 'paused', ports: '0.0.0.0:8512->1/tcp' })], []))).toBe('resolve')
  })

  it('★ 컨테이너가 아닌 프로세스가 끼면 안내만(info) — 이름을 몰라도', () => {
    const c = findConflicts(want, [], parseSs('tcp LISTEN 0 1 *:8512 *:* users:(("nginx",pid=77,fd=6))'))
    expect(c.procs).toEqual([{ port: want[0], proc: 'nginx', pid: 77 }])
    expect(conflictChoice(c)).toBe('info')
    const anon = findConflicts(want, [], parseSs('tcp LISTEN 0 1 0.0.0.0:8512 0.0.0.0:*'))
    expect(anon.procs[0].proc).toBeNull()
    expect(conflictChoice(anon)).toBe('info')
    // 컨테이너와 프로세스가 섞여도 info — 프로세스를 못 치우니 [정지하고 시작]은 거짓 약속이다
    const mixed = findConflicts(
      [...want, { ip: '', port: 9000, proto: 'tcp' }],
      [row({ ports: '0.0.0.0:8512->1/tcp' })],
      parseSs('tcp LISTEN 0 1 0.0.0.0:9000 0.0.0.0:*')
    )
    expect(conflictChoice(mixed)).toBe('info')
  })

  it('아무도 안 쓰면 none · 같은 컨테이너를 두 번 치우지 않는다', () => {
    expect(conflictChoice(findConflicts(want, [], []))).toBe('none')
    const r = row({ ports: '0.0.0.0:8512->1/tcp, 0.0.0.0:9000->2/tcp' })
    const c = findConflicts([...want, { ip: '', port: 9000, proto: 'tcp' }], [r], [])
    expect(c.ctrs).toHaveLength(2)
    expect(uniqueCtrs(c.ctrs)).toHaveLength(1)
  })

  it('지우기 전에 멈출지', () => {
    expect(needsStop('running')).toBe(true)
    expect(needsStop('paused')).toBe(true)
    expect(needsStop('exited')).toBe(false)
    expect(needsStop('created')).toBe(false)
  })

  it('경합 실패 문구 — docker·podman', () => {
    expect(isPortClash('Error response from daemon: driver failed programming external connectivity on endpoint x: Bind for 0.0.0.0:8512 failed: port is already allocated')).toBe(true)
    expect(isPortClash('Error: rootlessport listen tcp 0.0.0.0:8512: bind: address already in use')).toBe(true)
    expect(isPortClash('Error: No such container: x')).toBe(false)
  })
})

describe('[새 컨테이너] 입력 → 인자', () => {
  const base: RunForm = { image: 'redis:8-alpine', name: 'jarvis-redis', ports: '8512:6379\n', env: '', restart: 'unless-stopped', cmd: '' }

  it('정상 — 빈 줄은 버리고 원하는 호스트 포트를 같이 낸다', () => {
    const r = parseRunForm({ ...base, ports: '8512:6379\n\n127.0.0.1:8080:80\n53:53/udp', env: 'TZ=Asia/Seoul\n\nA=b c' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.args).toEqual({
      image: 'redis:8-alpine',
      name: 'jarvis-redis',
      ports: ['8512:6379', '127.0.0.1:8080:80', '53:53/udp'],
      env: ['TZ=Asia/Seoul', 'A=b c'],
      restart: 'unless-stopped'
    })
    expect(r.want).toEqual([
      { ip: '', port: 8512, proto: 'tcp' },
      { ip: '127.0.0.1', port: 8080, proto: 'tcp' },
      { ip: '', port: 53, proto: 'udp' }
    ])
  })

  it('틀린 칸을 짚는다 — env 는 값이 아니라 키만 돌려준다(비밀값이 화면 오류로 새지 않게)', () => {
    expect(parseRunForm({ ...base, image: '' })).toEqual({ ok: false, field: 'image' })
    expect(parseRunForm({ ...base, name: 'a;b' })).toEqual({ ok: false, field: 'name' })
    expect(parseRunForm({ ...base, ports: '8512' })).toEqual({ ok: false, field: 'ports', line: '8512' })
    expect(parseRunForm({ ...base, ports: '70000:1' })).toEqual({ ok: false, field: 'ports', line: '70000:1' })
    const bad = parseRunForm({ ...base, env: 'BAD KEY=hunter2-not-real' })
    expect(bad).toEqual({ ok: false, field: 'env', line: 'BAD KEY' })
    expect(JSON.stringify(bad)).not.toContain('hunter2')
    expect(parseRunForm({ ...base, restart: 'sometimes' })).toEqual({ ok: false, field: 'restart' })
  })
})

describe('ctr.run 조립', () => {
  it('정상 조립 — 이름·포트·재시작은 그대로, env·추가 인자는 인용', () => {
    expect(
      buildCtrRunArgs({
        image: 'redis:8-alpine',
        name: 'jarvis-redis',
        ports: ['8512:6379'],
        env: ['TZ=Asia/Seoul'],
        restart: 'unless-stopped',
        cmd: 'redis-server --appendonly yes'
      })
    ).toBe(
      "run -d --name jarvis-redis -p 8512:6379 -e 'TZ=Asia/Seoul' --restart unless-stopped redis:8-alpine 'redis-server' '--appendonly' 'yes'"
    )
    // 'no' 는 기본값이라 붙이지 않는다
    expect(buildCtrRunArgs({ image: 'nginx', restart: 'no' })).toBe('run -d nginx')
  })

  it('★ 주입 시도는 null — 부분 조립 없음', () => {
    const ok = { image: 'nginx' }
    for (const bad of [
      { ...ok, image: 'nginx; reboot' },
      { ...ok, image: '-v/:/host' },
      { ...ok, image: '$(id)' },
      { ...ok, name: 'a b' },
      { ...ok, name: 'x;id' },
      { ...ok, name: '-rm' },
      { ...ok, ports: ['8512:6379;id'] },
      { ...ok, ports: ['8512:6379 -v /:/h'] },
      { ...ok, ports: '8512:6379' },
      { ...ok, env: ['A B=1'] },
      { ...ok, env: ['$(id)=1'] },
      { ...ok, env: ['NOEQ'] },
      { ...ok, env: ['A=1\nB=2'] },
      { ...ok, restart: 'always; id' },
      { ...ok, cmd: 'a\nb' },
      { ...ok, cmd: 42 },
      { ...ok, ports: Array.from({ length: 65 }, (_, i) => `${i + 1}:1`) }
    ]) {
      expect(buildCtrRunArgs(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('표 — 쓰기 · 사람 전용 · 상한 2분 / ctr.ports 는 읽기', () => {
    const r = buildCommand('ctr.run', { image: 'nginx' })!
    expect(r.write).toBe(true)
    expect(r.timeoutMs).toBe(120000)
    expect(r.cmd).toContain('docker run -d nginx')
    expect(r.cmd).toContain('podman run -d nginx')
    expect(HUMAN_ONLY.has('ctr.run')).toBe(true)
    expect(buildCommand('ctr.action', { id: 'a'.repeat(12), action: 'stop' })!.timeoutMs).toBe(30000)
    const p = buildCommand('ctr.ports', { id: 'b'.repeat(12) })!
    expect(p.write).toBe(false)
    expect(p.cmd).toContain(`inspect --format '{{json .HostConfig.PortBindings}}' ${'b'.repeat(12)}`)
    expect(buildCommand('ctr.ports', undefined)!.cmd).not.toContain('inspect')
    expect(buildCommand('ctr.ports', { id: 'x; id' })).toBeNull()
  })

  /**
   * ★ 가짜 실행기 — 조립한 줄을 **진짜 sh** 로 돌리되 `docker` 는 받은 인자를 한 줄씩 찍는 셸 함수다
   * (함수가 PATH 보다 먼저 잡힌다 — 이 PC 의 docker 는 불리지 않는다). 인용이 맞으면 악의적인
   * 값이 **글자 그대로 한 인자**로 도착하고, 그 안의 `$(…)`·`;`·`'` 는 아무 일도 하지 않는다.
   */
  it('★ 가짜 docker 로 받아 본 인자 — 값이 글자 그대로 도착하고 아무것도 실행되지 않는다', () => {
    const nasty = "P=it's $(echo PWNED) `echo PWNED`; echo PWNED"
    const cmd = buildCommand('ctr.run', { image: 'nginx', env: [nasty], cmd: "--x=$(echo PWNED) ';echo' PWNED" })!.cmd
    const r = spawnSync('sh', ['-c', `docker() { for a in "$@"; do printf '[%s]\\n' "$a"; done; }; ${cmd}`], {
      encoding: 'utf8'
    })
    expect(r.status).toBe(0)
    const args = r.stdout.trim().split('\n')
    expect(args).toEqual([
      '[run]',
      '[-d]',
      '[-e]',
      `[${nasty}]`,
      '[nginx]',
      // 추가 인자는 공백으로만 나눈다(설계 — 토크나이저 없음). 나뉘어도 각 조각은 글자 그대로다.
      '[--x=$(echo]',
      '[PWNED)]',
      "[';echo']",
      '[PWNED]'
    ])
    // 명령 치환이 돌았다면 대괄호 밖에 PWNED 가 단독 줄로 찍힌다
    expect(r.stdout.split('\n').filter((l) => l.trim() === 'PWNED')).toEqual([])
  })
})
