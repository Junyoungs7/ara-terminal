// F26 서버 콘솔 검증 — ① 프로세스 표의 순수 함수(정렬·필터·강조·아라 맥락)
// ② RemoteConsoleService 의 실행 경로. ②의 핵심은 **카탈로그를 통과하지 못한 것은 exec 에 닿지 않는다**
// 이므로, 전부 "명령이 몇 개 나갔는가"를 세서 판정한다(결과 문자열이 아니라 나갔는지 여부가 보안 성질이다).
// 폴링 수명(busy 가드·세션 정리)은 tests/telemetry.test.ts 의 같은 이름 블록을 본떴다.
import { describe, it, expect } from 'vitest'
import type { Client } from 'ssh2'
import type { ProcRow, SvcRow, CmdId } from '../src/shared/remoteCatalog'
import { parseDf, parseDu, parsePs, parseSystemctl } from '../src/shared/remoteCatalog'
import { createRemoteConsoleService } from '../src/main/remote/RemoteConsoleService'
import {
  DEFAULT_SORT,
  filterProcs,
  nextSort,
  procContext,
  procTone,
  sortProcs
} from '../src/renderer/components/ProcessTable'
import {
  DEFAULT_SVC_SORT,
  filterSvcs,
  nextSvcSort,
  sortSvcs,
  svcContext,
  svcTone
} from '../src/renderer/components/ServiceTable'
import {
  diskTone,
  duChildren,
  isVirtualFs,
  pushStop,
  visibleDisks
} from '../src/renderer/components/DiskTable'

// 실제 `ps -eo pid=,user=,pcpu=,pmem=,rss=,stat=,etimes=,args=` 출력 모양.
const PS_OUT = `  1234 jun       12.5  3.2  1048576 Sl    88213 node /srv/app/server.js --port 3000
  9999 postgres   0.3 18.4  6029312 Ss   902133 postgres: checkpointer
  4242 jun        0.0  0.0        0 Z         5 [worker] <defunct>
     1 root      91.2  0.1    12288 Ss  1902133 /sbin/init splash
`
const ROWS: ProcRow[] = parsePs(PS_OUT)

describe('프로세스 표 — 필터', () => {
  it('명령·사용자를 부분일치로 거른다(대소문자 무시)', () => {
    expect(filterProcs(ROWS, 'node').map((r) => r.pid)).toEqual([1234])
    expect(filterProcs(ROWS, 'JUN').map((r) => r.pid)).toEqual([1234, 4242])
    expect(filterProcs(ROWS, 'postgres').map((r) => r.pid)).toEqual([9999]) // 사용자·명령 양쪽에 걸려도 한 번
  })

  it('빈 검색어는 아무 것도 거르지 않는다', () => {
    expect(filterProcs(ROWS, '   ').length).toBe(ROWS.length)
  })

  it('원본 배열을 건드리지 않는다(폴링이 같은 배열을 계속 넘긴다)', () => {
    const before = [...ROWS]
    filterProcs(ROWS, 'node')
    expect(ROWS).toEqual(before)
  })
})

describe('프로세스 표 — 정렬', () => {
  it('첫 화면은 CPU 내림차순(ps 가 준 순서를 그대로 이어받는다)', () => {
    expect(sortProcs(ROWS, DEFAULT_SORT).map((r) => r.pid)).toEqual([1, 1234, 9999, 4242])
  })

  it('PID·메모리는 숫자로, 사용자·명령은 사전순으로 정렬한다', () => {
    expect(sortProcs(ROWS, { key: 'pid', desc: false }).map((r) => r.pid)).toEqual([1, 1234, 4242, 9999])
    expect(sortProcs(ROWS, { key: 'mem', desc: true }).map((r) => r.pid)).toEqual([9999, 1234, 1, 4242])
    expect(sortProcs(ROWS, { key: 'user', desc: false }).map((r) => r.user)).toEqual([
      'jun',
      'jun',
      'postgres',
      'root'
    ])
  })

  it('값이 같으면 PID 오름차순으로 고정한다(폴링마다 행이 들썩이지 않게)', () => {
    // cpu 0.0 인 4242 와 새로 넣은 4243 — 같은 값이면 언제나 같은 순서여야 한다.
    const tie: ProcRow[] = [
      { ...ROWS[2], pid: 4243 },
      { ...ROWS[2], pid: 4242 }
    ]
    expect(sortProcs(tie, { key: 'cpu', desc: true }).map((r) => r.pid)).toEqual([4242, 4243])
    expect(sortProcs(tie, { key: 'cpu', desc: false }).map((r) => r.pid)).toEqual([4242, 4243])
  })

  it('열 머리 클릭: 같은 열이면 방향만 뒤집고, 다른 열이면 쓸모 있는 쪽으로 시작한다', () => {
    expect(nextSort({ key: 'cpu', desc: true }, 'cpu')).toEqual({ key: 'cpu', desc: false })
    expect(nextSort({ key: 'cpu', desc: true }, 'mem')).toEqual({ key: 'mem', desc: true }) // 숫자는 큰 것부터
    expect(nextSort({ key: 'cpu', desc: true }, 'user')).toEqual({ key: 'user', desc: false }) // 글자는 사전순
  })
})

describe('프로세스 표 — 강조', () => {
  it('좀비(STAT 에 Z)와 고CPU 만 색을 받는다', () => {
    const byPid = (pid: number): ProcRow => ROWS.find((r) => r.pid === pid)!
    expect(procTone(byPid(4242))).toBe('zombie')
    expect(procTone(byPid(1))).toBe('hot') // 91.2%
    expect(procTone(byPid(1234))).toBeNull() // 12.5% — 평범하다
    expect(procTone(byPid(9999))).toBeNull()
  })
})

describe('프로세스 표 — 아라에게 보낼 맥락', () => {
  it('고른 행 하나만 담고, 명령줄의 비밀은 마스킹한다', () => {
    const row: ProcRow = { ...ROWS[0], cmd: 'mysqldump --password=hunter2 db' }
    const text = procContext(row)
    expect(text).toContain('PID 1234')
    expect(text).toContain('--password=****')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('postgres') // 목록의 다른 행은 들어가지 않는다
  })
})

// ── 서비스 표(R2) ────────────────────────────────────────────────────────────

// 실제 `systemctl list-units --type=service --all --no-pager --plain --no-legend` 출력 모양.
// 상태가 나쁜 유닛 앞에는 ● 가 붙어 나온다 — 파서가 걷어낸다.
const SVC_OUT = `  ssh.service        loaded active   running OpenBSD Secure Shell server
● postgresql.service loaded failed   failed  PostgreSQL RDBMS
  cups.service       loaded inactive dead    CUPS Scheduler
  nginx.service      loaded active   running The nginx HTTP and reverse proxy server
`
const SVCS: SvcRow[] = parseSystemctl(SVC_OUT)

describe('서비스 표 — 정렬', () => {
  it('첫 화면은 죽은 것부터 — failed 가 맨 위로 온다', () => {
    // 목록을 여는 이유가 대개 "뭐가 죽었나"다. 이름순이면 죽은 유닛이 아래에 묻힌다.
    expect(sortSvcs(SVCS, DEFAULT_SVC_SORT).map((r) => r.unit)).toEqual([
      'postgresql.service',
      'nginx.service',
      'ssh.service',
      'cups.service'
    ])
  })

  it('active 는 사전순이 아니라 급한 순서로 갈린다(failed → active → 그 밖)', () => {
    // sub 만 failed 인 유닛도 죽은 것으로 본다(active 는 activating 인데 실제로는 올라오지 못한 경우).
    const half: SvcRow[] = [
      { unit: 'a.service', load: 'loaded', active: 'activating', sub: 'failed', desc: '' },
      { unit: 'b.service', load: 'loaded', active: 'active', sub: 'running', desc: '' }
    ]
    expect(sortSvcs(half, DEFAULT_SVC_SORT).map((r) => r.unit)).toEqual(['a.service', 'b.service'])
  })

  it('같은 상태면 유닛 이름순으로 고정한다(폴링마다 행이 들썩이지 않게)', () => {
    const same = sortSvcs(SVCS, DEFAULT_SVC_SORT).filter((r) => r.active === 'active')
    expect(same.map((r) => r.unit)).toEqual(['nginx.service', 'ssh.service'])
  })

  it('유닛·설명 열은 사전순, 열 머리를 다시 누르면 뒤집힌다', () => {
    expect(sortSvcs(SVCS, { key: 'unit', desc: false })[0].unit).toBe('cups.service')
    expect(sortSvcs(SVCS, { key: 'unit', desc: true })[0].unit).toBe('ssh.service')
    expect(nextSvcSort({ key: 'unit', desc: false }, 'unit')).toEqual({ key: 'unit', desc: true })
    expect(nextSvcSort({ key: 'unit', desc: true }, 'active')).toEqual({ key: 'active', desc: false })
  })

  it('원본 배열을 건드리지 않는다(폴링이 같은 배열을 계속 넘긴다)', () => {
    const before = [...SVCS]
    sortSvcs(SVCS, { key: 'desc', desc: true })
    expect(SVCS).toEqual(before)
  })
})

describe('서비스 표 — 필터·강조', () => {
  it('유닛 이름과 설명을 부분일치로 거른다(대소문자 무시)', () => {
    expect(filterSvcs(SVCS, 'nginx').map((r) => r.unit)).toEqual(['nginx.service'])
    expect(filterSvcs(SVCS, 'RDBMS').map((r) => r.unit)).toEqual(['postgresql.service']) // 설명에만 있는 낱말
    expect(filterSvcs(SVCS, '없는유닛')).toEqual([])
    expect(filterSvcs(SVCS, '  ').length).toBe(SVCS.length)
  })

  it('상태 점은 셋으로만 갈린다 — 죽음 · 돌고 있음 · 그 밖', () => {
    const by = (unit: string): SvcRow => SVCS.find((r) => r.unit === unit)!
    expect(svcTone(by('postgresql.service'))).toBe('bad')
    expect(svcTone(by('nginx.service'))).toBe('ok')
    expect(svcTone(by('cups.service'))).toBeNull() // inactive 는 고장이 아니다 — 색을 쓰지 않는다
  })
})

describe('서비스 표 — 아라에게 보낼 맥락', () => {
  it('고른 행 하나만 담고, 설명의 비밀은 마스킹한다', () => {
    const row: SvcRow = { ...SVCS[1], desc: 'backup job --password=hunter2' }
    const text = svcContext(row)
    expect(text).toContain('postgresql.service')
    expect(text).toContain('--password=****')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('nginx') // 목록의 다른 행은 들어가지 않는다
  })
})

// ── 디스크 표(R2) ────────────────────────────────────────────────────────────

// 실제 `df -PT` 출력 모양. 가상 파일시스템(tmpfs·devtmpfs·squashfs)이 섞여 있다.
const DF_OUT = `Filesystem     Type     1024-blocks      Used Available Capacity Mounted on
/dev/sda1      ext4        41152812  13123456  25934567      34% /
/dev/sdb1      xfs        209715200 199229440  10485760      95% /data
/dev/sda2      ext4        20511356  15383517   4074983      80% /var
tmpfs          tmpfs        3286916         0   3286916       0% /dev/shm
devtmpfs       devtmpfs     1643456         0   1643456       0% /dev
/dev/loop0     squashfs       66432     66432         0     100% /snap/core20/2015
udev           devtmpfs           0         0         0       0% /proc/sys/fs/binfmt_misc
`
const DISKS = parseDf(DF_OUT)

describe('디스크 표 — 가상 파일시스템', () => {
  it('기본으로는 사람이 관리하는 파일시스템만 남는다', () => {
    // 파서는 일부러 안 걸러 준다 — 무엇을 숨길지는 화면이 정한다는 규칙(remoteCatalog parseDf 주석).
    expect(DISKS.length).toBe(7)
    expect(visibleDisks(DISKS, false).map((r) => r.mount)).toEqual(['/', '/data', '/var'])
  })

  it('체크박스를 켜면 숨긴 것까지 전부 보여 준다', () => {
    expect(visibleDisks(DISKS, true).length).toBe(DISKS.length)
  })

  it('크기 0 도 가상 취급한다(남은 용량을 말할 수 없는 항목이다)', () => {
    const zero = DISKS.find((r) => r.mount === '/proc/sys/fs/binfmt_misc')!
    expect(isVirtualFs(zero)).toBe(true)
  })
})

describe('디스크 표 — 용량 톤(90 / 75 경계)', () => {
  it('90 이상은 빨강, 75 이상은 주황, 그 아래는 색 없음', () => {
    expect(diskTone(95)).toBe('crit')
    expect(diskTone(90)).toBe('crit') // 경계 포함
    expect(diskTone(89)).toBe('warn')
    expect(diskTone(75)).toBe('warn') // 경계 포함
    expect(diskTone(74)).toBeNull()
    expect(diskTone(0)).toBeNull()
  })
})

describe('디스크 표 — 폴더 파고들기', () => {
  // 실제 `du -x -d1 -k /data` 출력. 대상 폴더 자신도 한 줄로 나오고, 대개 그게 제일 큰 줄이다.
  const DU_OUT = `47185920\t/data/postgres
2097152\t/data/logs
125829120\t/data/backup
175112192\t/data
`

  it('자기 자신을 뺀 자식만 남기고 큰 것부터 보여 준다', () => {
    const rows = duChildren(parseDu(DU_OUT), '/data')
    expect(rows.map((r) => r.path)).toEqual(['/data/backup', '/data/postgres', '/data/logs'])
    expect(rows[0].kb).toBe(125829120)
  })

  it('이름이 겹치는 형제(/database)를 자식으로 착각하지 않는다', () => {
    const rows = duChildren(parseDu('100\t/database\n200\t/data/x\n300\t/data\n'), '/data')
    expect(rows.map((r) => r.path)).toEqual(['/data/x'])
  })

  it('루트에서도 접두사 비교가 어긋나지 않는다(// 가 되지 않게)', () => {
    const rows = duChildren(parseDu('10\t/usr\n20\t/var\n99\t/\n'), '/')
    expect(rows.map((r) => r.path)).toEqual(['/var', '/usr'])
  })

  it('[뒤로] 이력은 방문한 자리를 순서대로 쌓는다', () => {
    let h = pushStop([], { mount: '/data', path: '/data' })
    h = pushStop(h, { mount: '/data', path: '/data/backup' })
    expect(h).toEqual([
      { mount: '/data', path: '/data' },
      { mount: '/data', path: '/data/backup' }
    ])
  })

  it('★ 같은 자리는 두 번 쌓지 않는다 — [새로고침]·같은 폴더 재클릭으로 이력이 부풀지 않게', () => {
    const h = pushStop([{ mount: '/data', path: '/data/backup' }], { mount: '/data', path: '/data/backup' })
    expect(h).toHaveLength(1)
  })

  it('★ 마운트를 갈아탄 것도 이력이다 — [상위로]가 못 하던 복귀가 여기서 된다', () => {
    const h = pushStop([], { mount: '/data', path: '/data' })
    // 위 표에서 `/` 를 골라도 직전 자리(/data)가 남아 있어 되돌아올 수 있다.
    expect(h[h.length - 1]).toEqual({ mount: '/data', path: '/data' })
    // 경로만 같고 마운트가 다르면 다른 자리다(같은 자리 판정에 마운트도 들어간다).
    expect(pushStop(h, { mount: '/', path: '/data' })).toHaveLength(2)
  })
})

// ── 실행 서비스 ──────────────────────────────────────────────────────────────

// exec 을 세는 가짜 클라이언트(telemetry.test.ts 의 fakeClient 와 같은 모양).
// hang: 응답하지 않는 서버 — busy 가드 검증용.
function fakeClient(
  log: string[],
  opts: { hang?: boolean; out?: string; err?: string; code?: number } = {}
): Client {
  return {
    exec(cmd: string, cb: (err: Error | null, stream: unknown) => void) {
      log.push(cmd)
      const handlers = new Map<string, ((...a: unknown[]) => void)[]>()
      const on = (ev: string, fn: (...a: unknown[]) => void): unknown => {
        handlers.set(ev, [...(handlers.get(ev) ?? []), fn])
        return null
      }
      const fire = (ev: string, ...a: unknown[]): void => {
        for (const fn of handlers.get(ev) ?? []) fn(...a)
      }
      cb(null, { on, stderr: { on: (ev: string, fn: (...a: unknown[]) => void) => on('stderr:' + ev, fn) }, close: () => {} })
      if (opts.hang) return
      setImmediate(() => {
        if (opts.out) fire('data', Buffer.from(opts.out))
        if (opts.err) fire('stderr:data', Buffer.from(opts.err))
        fire('close', opts.code ?? 0)
      })
    }
  } as unknown as Client
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('RemoteConsoleService — 카탈로그를 통과하지 못한 것은 실행되지 않는다', () => {
  it('표에 없는 id 는 exec 을 한 번도 열지 않고 badArgs 로 끝난다', async () => {
    const log: string[] = []
    const svc = createRemoteConsoleService(() => fakeClient(log), () => {})
    expect(await svc.run('s1', 'rm.rf' as CmdId, { path: '/' })).toEqual({ ok: false, reason: 'badArgs' })
    expect(await svc.run('s1', '' as CmdId, null)).toEqual({ ok: false, reason: 'badArgs' })
    expect(log).toEqual([])
  })

  it('인자 검증에 걸리면(PID 0·음수·모르는 시그널) 아무 것도 실행하지 않는다', async () => {
    const log: string[] = []
    const svc = createRemoteConsoleService(() => fakeClient(log), () => {})
    // pid 0 은 kill(2) 에서 프로세스 그룹 전체를 뜻한다 — 여기서 막지 못하면 서버가 통째로 죽는다.
    for (const args of [{ pid: 0, signal: 'TERM' }, { pid: -1, signal: 'TERM' }, { pid: 1, signal: 'HUP' }, { pid: '1; rm -rf /', signal: 'TERM' }, null]) {
      expect(await svc.run('s1', 'ps.kill', args)).toEqual({ ok: false, reason: 'badArgs' })
    }
    expect(log).toEqual([])
  })

  it('정상 인자는 카탈로그가 조립한 명령 그대로 나간다', async () => {
    const log: string[] = []
    const svc = createRemoteConsoleService(() => fakeClient(log, { out: 'ok\n' }), () => {})
    const r = await svc.run('s1', 'ps.kill', { pid: 1234, signal: 'TERM' })
    expect(r).toEqual({ ok: true, out: 'ok\n', code: 0 })
    expect(log).toEqual(['kill -TERM 1234 2>&1'])
  })

  it('SSH 세션이 없으면 noSession — 명령은 나가지 않는다', async () => {
    const log: string[] = []
    const svc = createRemoteConsoleService(() => null, () => {})
    expect(await svc.run('gone', 'ps.list', {})).toEqual({ ok: false, reason: 'noSession' })
    expect(log).toEqual([])
  })
})

describe('RemoteConsoleService — 실패를 숨기지 않는다', () => {
  it('종료코드와 stderr 를 함께 돌려준다(권한 부족을 "실패"로 뭉개지 않는다)', async () => {
    const svc = createRemoteConsoleService(
      () => fakeClient([], { err: 'kill: (1) - Operation not permitted\n', code: 1 }),
      () => {}
    )
    const r = await svc.run('s1', 'ps.kill', { pid: 1, signal: 'TERM' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.code).toBe(1)
    expect(r.out).toContain('Operation not permitted')
  })
})

describe('RemoteConsoleService — 폴링 수명', () => {
  it('watch 는 즉시 한 바퀴 돌고, unwatch 이후에는 명령이 나가지 않는다', async () => {
    const log: string[] = []
    const got: string[] = []
    const svc = createRemoteConsoleService(
      () => fakeClient(log, { out: PS_OUT }),
      (e) => got.push(`${e.sessionId}:${e.cmdId}:${e.out.length}`),
      20
    )
    svc.watch('s1', 'ps.list', {})
    await wait(80)
    expect(svc.activeCount()).toBe(1)
    expect(got[0]).toBe(`s1:ps.list:${PS_OUT.length}`)
    svc.unwatch('s1', 'ps.list')
    const after = log.length
    await wait(80)
    expect(svc.activeCount()).toBe(0)
    expect(log.length).toBe(after)
  })

  it('busy 가드 — 이전 바퀴가 안 끝났으면 다음 바퀴를 건너뛴다(채널이 쌓이지 않는다)', async () => {
    const log: string[] = []
    const svc = createRemoteConsoleService(() => fakeClient(log, { hang: true }), () => {}, 20)
    svc.watch('s1', 'ps.list', {})
    await wait(120) // 주기로만 따지면 대여섯 바퀴가 돌았을 시간
    expect(log.length).toBe(1)
    svc.stopAll()
  })

  it('세션이 사라지면 폴러가 스스로 정리된다', async () => {
    let client: Client | null = fakeClient([], { out: PS_OUT })
    const svc = createRemoteConsoleService(() => client, () => {}, 20)
    svc.watch('s1', 'ps.list', {})
    await wait(40)
    expect(svc.activeCount()).toBe(1)
    client = null
    await wait(60)
    expect(svc.activeCount()).toBe(0)
  })

  it('쓰기 명령은 구독할 수 없다 — 2.5초마다 kill 을 보내는 폴러는 만들지 않는다', async () => {
    const log: string[] = []
    const svc = createRemoteConsoleService(() => fakeClient(log), () => {}, 20)
    svc.watch('s1', 'ps.kill', { pid: 1234, signal: 'TERM' })
    await wait(60)
    expect(svc.activeCount()).toBe(0)
    expect(log).toEqual([])
  })

  it('인자가 틀린 구독은 폴러를 만들지 않는다', async () => {
    const log: string[] = []
    const svc = createRemoteConsoleService(() => fakeClient(log), () => {}, 20)
    svc.watch('s1', 'disk.du', { path: 'relative/path' })
    expect(svc.activeCount()).toBe(0)
    expect(log).toEqual([])
  })

  it('같은 (세션, 명령) 에 watch 를 두 번 불러도 폴러는 하나다(= 새로고침)', async () => {
    const svc = createRemoteConsoleService(() => fakeClient([], { out: PS_OUT }), () => {}, 50)
    svc.watch('s1', 'ps.list', {})
    svc.watch('s1', 'ps.list', {})
    expect(svc.activeCount()).toBe(1)
    // 다른 세션·다른 명령은 별개 구독이다.
    svc.watch('s2', 'ps.list', {})
    svc.watch('s1', 'svc.list', {})
    expect(svc.activeCount()).toBe(3)
    svc.stopAll()
    expect(svc.activeCount()).toBe(0)
  })
})
