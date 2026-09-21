// F26 서버 콘솔 검증 — ① 프로세스 표의 순수 함수(정렬·필터·강조·아라 맥락)
// ② RemoteConsoleService 의 실행 경로. ②의 핵심은 **카탈로그를 통과하지 못한 것은 exec 에 닿지 않는다**
// 이므로, 전부 "명령이 몇 개 나갔는가"를 세서 판정한다(결과 문자열이 아니라 나갔는지 여부가 보안 성질이다).
// 폴링 수명(busy 가드·세션 정리)은 tests/telemetry.test.ts 의 같은 이름 블록을 본떴다.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from 'ssh2'
// sudoPasswordOf 를 부르려면 registerRemoteIpc 를 불러와야 하고, 그 파일은 ipc/handle.ts 를 거쳐
// electron 을 잡는다. 여기서 보는 것은 vault 조회 규칙뿐이라 electron 은 껍데기로 세운다
// (tests/secrets.test.ts·localfs.test.ts 와 같은 방식).
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))
import type { ProcRow, SvcRow, CmdId, CtrRow, PkgRow } from '../src/shared/remoteCatalog'
import { ctrActions, sortCtrs, nextCtrSort, DEFAULT_CTR_SORT } from '../src/renderer/components/ContainerTable'
import {
  groupPods,
  podRank,
  sortPodGroups,
  nextPodSort,
  DEFAULT_POD_SORT,
  type CtrPodGroup
} from '../src/renderer/components/K8sPanel'
import { tidyReason } from '../src/renderer/components/ctrShared'
import { DEFAULT_PKG_SORT, filterPkgs, nextPkgSort, sortPkgs } from '../src/renderer/components/PkgTable'
import { parseDf, parseDu, parsePs, parseSystemctl } from '../src/shared/remoteCatalog'
import { createRemoteConsoleService } from '../src/main/remote/RemoteConsoleService'
import { sudoPasswordOf } from '../src/main/ipc/registerRemoteIpc'
import { ProfileStore } from '../src/main/secrets/ProfileStore'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import type { SecretStore } from '../src/main/secrets/SecretStore'
import type { Session } from '../src/shared/types'
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
  opts: { hang?: boolean; out?: string; err?: string; code?: number; stdinLog?: string[]; onEnd?: () => void } = {}
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
      cb(null, {
        on,
        stderr: { on: (ev: string, fn: (...a: unknown[]) => void) => on('stderr:' + ev, fn) },
        close: () => {},
        // 권한 올리기(sudo -S)는 비밀번호를 **stdin 으로만** 보낸다 — 명령줄에 실렸는지
        // 여기서 갈라 본다(log 에는 명령만, stdinLog 에는 stdin 만 쌓인다).
        write: (d: string) => opts.stdinLog?.push(String(d)),
        // stdin 을 **닫았는지**도 센다: 안 닫으면 비밀번호 없는 sudo 가 입력을 기다리며 매달린다.
        end: () => opts.onEnd?.()
      })
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

  /**
   * ★ 2026-08-27 준영님 제보. 끊긴 커넥션에서 ssh2 는 콜백이 아니라 **동기로 던진다**.
   * 안 잡으면 Promise 가 reject → IPC reject → 화면은 이유를 모르는 실패를 받았다.
   */
  it('★ 끊긴 커넥션에서 exec 이 던져도 터지지 않고 noSession 으로 끝난다', async () => {
    const dead = {
      exec() {
        throw new Error('Not connected')
      }
    } as unknown as Client
    const svc = createRemoteConsoleService(() => dead, () => {})
    expect(await svc.run('s1', 'ps.list', {})).toEqual({ ok: false, reason: 'noSession' })
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

// 2026-08-24 제보(쿠버네티스 워커 노드) 후속 — crictl 로 읽은 목록에서는 CRI 에 **없는 명령**을
// 내주면 안 된다. 눌러 봐야 `unknown command "pause"` 로 떨어진다.
describe('컨테이너 버튼 — 런타임이 없는 명령은 내주지 않는다', () => {
  const row = (state: string): CtrRow => ({ id: 'a'.repeat(64), name: 'app', image: 'busybox', state, status: '', ports: '' })

  it('docker 는 그대로 — 돌면 정지·일시정지·재시작, 멈췄으면 시작·제거', () => {
    expect(ctrActions(row('running'))).toEqual(['stop', 'pause', 'restart'])
    expect(ctrActions(row('exited'))).toEqual(['start', 'rm'])
    expect(ctrActions(null)).toEqual([])
  })

  // 2026-08-24: crictl 분기는 사라졌다 — 쿠버는 탭이 갈렸고 **그 탭에는 조작 줄이 없다**
  // (컨테이너를 멈춰도 kubelet 이 되살린다). 버튼을 잠그는 대신 아예 만들지 않는다.
  it('★ 쿠버 탭에는 조작이 없다 — 이 함수는 도커·포드먼 전용이다', () => {
    expect(ctrActions(row('paused'))).toEqual(['unpause', 'stop'])
  })

  /**
   * ★ #192(2026-09-21) — **crictl 이 컨테이너 탭으로 오면서 이 규칙이 다시 필요해졌다.**
   *
   * `ctr.action` 이 조립하는 명령은 docker·podman 만 찾는다(`ctrCmd`). crictl 뿐인 노드에서는
   * `if …; elif …; fi` 가 어느 갈래도 안 타서 **종료코드 0 · 빈 출력**으로 돌아오고,
   * ContainerTable.act() 가 그걸 성공으로 읽는다 — 눌렀는데 아무 일도 안 일어나는데 화면은
   * 조용하다. 그래서 런타임을 보고 버튼을 통째로 잠근다.
   */
  it('★ crictl 노드에서는 조작 버튼이 하나도 안 열린다 — 조용한 no-op 을 막는다', () => {
    expect(ctrActions(row('running'), 'crictl')).toEqual([])
    expect(ctrActions(row('exited'), 'crictl')).toEqual([])
    // docker·podman 은 그대로다(고치면서 기능을 죽이지 않았다).
    expect(ctrActions(row('running'), 'docker')).toEqual(['stop', 'pause', 'restart'])
    expect(ctrActions(row('exited'), 'podman')).toEqual(['start', 'rm'])
  })
})

// 2026-08-24 준영님 요청 — 패키지 탭도 다른 탭처럼 표(.con-tbl)로. 열 머리를 눌러 정렬한다.
describe('설치된 프로그램 표 — 정렬', () => {
  const rows: PkgRow[] = [
    { bin: 'nginx', path: '/usr/sbin/nginx', version: '1.24.0', installedAt: 1_700_000_000_000 },
    { bin: 'node', path: '/home/jun/.nvm/versions/node/v20.11.1/bin/node', version: 'v20.11.1', installedAt: 1_710_374_400_000 },
    { bin: 'jq', path: '/usr/bin/jq', version: '1.6', installedAt: null }
  ]

  it('기본은 이름순 — 찾는 프로그램이 어디 있는지 아는 정렬이다', () => {
    expect(sortPkgs(rows, DEFAULT_PKG_SORT).map((r) => r.bin)).toEqual(['jq', 'nginx', 'node'])
  })

  it('★ 설치일을 모르는 행은 어느 방향으로 정렬해도 맨 아래 — 빈 값이 최신인 척하면 안 된다', () => {
    expect(sortPkgs(rows, { key: 'date', desc: false }).map((r) => r.bin)).toEqual(['nginx', 'node', 'jq'])
    expect(sortPkgs(rows, { key: 'date', desc: true }).map((r) => r.bin)).toEqual(['node', 'nginx', 'jq'])
  })

  it('같은 열을 다시 누르면 방향만 뒤집고, 다른 열은 오름차순으로 시작한다', () => {
    expect(nextPkgSort(DEFAULT_PKG_SORT, 'bin')).toEqual({ key: 'bin', desc: true })
    expect(nextPkgSort({ key: 'bin', desc: true }, 'date')).toEqual({ key: 'date', desc: false })
  })

  it('검색은 이름·버전에 걸린다(정렬과 섞이지 않는다)', () => {
    expect(filterPkgs(rows, 'ngin').map((r) => r.bin)).toEqual(['nginx'])
    expect(filterPkgs(rows, 'v20').map((r) => r.bin)).toEqual(['node'])
  })
})

// 2026-08-24 — 쿠버 노드 목록을 파드로 묶어서 본다(준영님 선택). 묶기·순위는 순수 함수다.
describe('쿠버 파드 묶기', () => {
  const c = (over: Partial<CtrRow>): CtrRow => ({
    id: over.id ?? 'x',
    name: 'app',
    image: 'img',
    state: 'running',
    status: '',
    ports: '',
    ns: 'prod',
    pod: 'api-7d9',
    restarts: 0,
    ...over
  })

  it('같은 파드의 컨테이너가 한 묶음이 되고 재시작·메모리는 합계다', () => {
    const g = groupPods([c({ id: '1', restarts: 3, memBytes: 100 }), c({ id: '2', name: 'istio', memBytes: 20 })], [])
    expect(g).toHaveLength(1)
    expect(g[0].key).toBe('prod/api-7d9')
    expect(g[0].total).toBe(2)
    expect(g[0].readyN).toBe(2)
    expect(g[0].restarts).toBe(3)
    expect(g[0].memBytes).toBe(120)
  })

  it('★ 자료가 아예 없으면 합계는 0 이 아니라 null — "안 쓴다"와 "모른다"는 다르다', () => {
    expect(groupPods([c({ id: '1' })], []).at(0)?.memBytes).toBeNull()
    expect(groupPods([c({ id: '1' })], []).at(0)?.cpuNs).toBeNull()
  })

  it('★ 아픈 파드가 위로 — ① 준비 안 됨 ② 재시작 있음 ③ 정상', () => {
    const rows = [
      c({ id: '1', pod: 'healthy' }),
      c({ id: '2', pod: 'restarted', restarts: 5 }),
      c({ id: '3', pod: 'down', state: 'exited' })
    ]
    expect(groupPods(rows, []).map((g) => g.name)).toEqual(['down', 'restarted', 'healthy'])
    expect(groupPods(rows, []).map(podRank)).toEqual([0, 1, 2])
  })

  it('파드 목록이 준비 안 됨이라고 하면 컨테이너가 다 떠 있어도 아픈 것으로 본다', () => {
    const pods = [{ key: 'prod/api-7d9', ns: 'prod', name: 'api-7d9', state: 'notready' }]
    expect(podRank(groupPods([c({ id: '1' })], pods)[0])).toBe(0)
  })

  it('파드 목록을 못 받아도(권한·구버전) 라벨만으로 묶인다 — 화면이 비지 않는다', () => {
    const g = groupPods([c({ id: '1' })], [])
    expect(g[0].ready).toBe(true) // 모르는 것을 고장으로 몰지 않는다
    expect(g[0].rows).toHaveLength(1)
  })
})

// 2026-08-24 준영님 요청 — 서버 설정을 바꾸지 않고 권한을 올린다(sudo + 접속에 쓴 비밀번호).
// 이 블록이 지키는 것 셋: **비밀번호는 명령줄에 없다** · 요청하지 않은 명령에는 안 보낸다 ·
// 거절당하면 화면이 즉시 끈다(반복 전송 = 계정 잠김).
// 진짜 비밀이 아니라 **표식**이다 — "이 값이 어디로 갔나"만 보면 되므로 비밀번호처럼 생길 이유가
// 없다. 저장소 규칙: 검사 자료에도 실제 비밀번호·패스프레이즈를 적지 않는다.
const SUDO_PW = '<sudo-pw>'
const PASSPHRASE = '<key-passphrase>'

describe('컨테이너 권한 올리기 — 비밀번호는 stdin 으로만', () => {
  it('★ sudo 를 요청하면 stdin 으로 가고, 명령줄에는 한 글자도 안 남는다', async () => {
    const log: string[] = []
    const stdinLog: string[] = []
    const svc = createRemoteConsoleService(
      () => fakeClient(log, { out: '', stdinLog }),
      () => {},
      50,
      () => SUDO_PW
    )
    await svc.run('s1', 'ctr.list', { sudo: true })
    expect(log[0]).toContain('sudo -S -p ')
    expect(log[0]).not.toContain(SUDO_PW) // 명령줄에 실리면 원격 `ps` 목록과 감사 로그에 찍힌다
    expect(stdinLog.join('')).toBe(SUDO_PW + '\n')
  })

  it('★ 권한을 요청하지 않은 명령에는 비밀번호를 보내지 않는다', async () => {
    const log: string[] = []
    const stdinLog: string[] = []
    const svc = createRemoteConsoleService(() => fakeClient(log, { out: '', stdinLog }), () => {}, 50, () => SUDO_PW)
    await svc.run('s1', 'ctr.list')
    await svc.run('s1', 'ps.list')
    expect(stdinLog).toEqual([])
    expect(log.every((c) => !c.includes('sudo -S'))).toBe(true)
  })

  it('저장된 비밀번호가 없으면(키 인증·미저장) 아무것도 안 보낸다 — sudo 가 스스로 실패한다', async () => {
    const log: string[] = []
    const stdinLog: string[] = []
    const svc = createRemoteConsoleService(() => fakeClient(log, { out: '', stdinLog }), () => {}, 50)
    await svc.run('s1', 'ctr.list', { sudo: true })
    expect(stdinLog).toEqual([])
  })

  /**
   * ★ 2026-08-28 배포 전 감사. **판단 근거가 렌더러가 보낸 불리언이었다.**
   *
   * 표 17개 중 sudo 를 쓰는 건 셋뿐인데 `args.sudo` 만 보고 비밀번호를 넣어서,
   * `remote:run(id,'pkg.probe',{sudo:true})` 가 sudo 를 안 붙인 평범한 스크립트의 stdin 으로
   * SSH 비밀번호를 흘려보냈다. 그 스크립트가 stdin 을 안 읽어 새지 않았을 뿐, 이 파일 머리가
   * 스스로 약속한 불변식("`sudo -S` 를 붙인 그 명령에만")을 코드가 안 지키고 있었다.
   */
  it('★ sudo 를 안 씌운 명령에는 {sudo:true} 를 실어도 비밀번호가 안 나간다', async () => {
    const log: string[] = []
    const stdinLog: string[] = []
    const svc = createRemoteConsoleService(
      () => fakeClient(log, { out: '', stdinLog }),
      () => {},
      50,
      () => SUDO_PW
    )
    for (const id of ['pkg.probe', 'ps.list', 'svc.list'] as CmdId[]) {
      await svc.run('s1', id, { sudo: true })
    }
    expect(log.every((c) => !c.startsWith('sudo -S'))).toBe(true)
    expect(stdinLog).toEqual([]) // 한 글자도 나가지 않았다
    // 진짜 sudo 명령에는 그대로 간다(고치면서 기능을 죽이지 않았다).
    await svc.run('s1', 'ctr.list', { sudo: true })
    expect(stdinLog.join('')).toBe(SUDO_PW + '\n')
  })

  /**
   * ★ 비밀번호가 없어도 **stdin 을 닫는다.** 안 닫으면 `sudo -S` 가 입력을 기다리며 10초
   * 타임아웃까지 매달리고, 화면에는 `timeout` 만 올라가 "서버가 느리다"는 엉뚱한 이유가 된다.
   * 닫으면 sudo 가 스스로 "a password is required" 를 뱉어 화면이 진짜 이유를 보여 준다
   * (그 문장을 ctrSudoFailed 가 알아본다).
   */
  it('★ 비밀번호가 없어도 stdin 을 닫는다 — sudo 가 매달리지 않고 스스로 실패한다', async () => {
    const log: string[] = []
    const stdinLog: string[] = []
    let ended = 0
    const svc = createRemoteConsoleService(
      () => fakeClient(log, { out: '', stdinLog, onEnd: () => (ended += 1) }),
      () => {},
      50
    )
    await svc.run('s1', 'ctr.list', { sudo: true })
    expect(stdinLog).toEqual([])
    expect(ended).toBe(1)
  })
})

// 2026-08-28 배포 전 감사 — **어떤 비밀이 sudo 로 나가는가.**
describe('sudo 비밀번호 조회 — 인증 방식을 본다', () => {
  const sess = (profileId: string): Pick<import('../src/main/sessions/MainSessionManager').MainSessionManager, 'snapshot'> => ({
    snapshot: (): Session[] => [{ id: 's1', type: 'ssh', title: 'srv', serverKey: 'srv', profileId }]
  })

  /** 인메모리 vault(profiles.test.ts 의 FakeVault 와 같은 물건 — 여기선 한 번만 쓴다). */
  function fakeVault(): SecretStore {
    const m = new Map<string, string>()
    return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k), has: (k) => m.has(k) }
  }

  function store(): { profiles: ProfileStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ara-sudopw-'))
    const ws = new WorkspaceStore(join(dir, 'workspace.json'), '0.0.0')
    return { profiles: new ProfileStore(ws, fakeVault()), dir }
  }

  /**
   * ★ 키 인증 프로필의 vault 값은 로그인 비밀번호가 아니라 **개인키 패스프레이즈**다
   * (SshBackend 가 `cfg.passphrase` 로 쓴다). 감사 전에는 인증 방식을 안 보고 lookupSecret 을
   * 그대로 돌려줘서, 암호화된 개인키로 붙은 사용자가 [관리자 권한으로 찾기]를 누르면 그
   * 패스프레이즈가 원격 sudo 의 stdin 으로 나갔다 — sudo 는 거절하니 화면엔 아무 일도 없고,
   * 개인키를 지키는 문자열만 남의 장비에 남는다.
   */
  it('★ 키 인증이면 null — 개인키 패스프레이즈가 원격 sudo 로 나가지 않는다', () => {
    const { profiles, dir } = store()
    const p = profiles.save({
      type: 'ssh',
      name: 'key-srv',
      host: 'h',
      port: 22,
      username: 'u',
      authType: 'key',
      keyPath: '~/.ssh/id_ed25519',
      secret: PASSPHRASE // 개인키 패스프레이즈 — 저장은 되지만 sudo 로는 나가면 안 된다
    })
    // 전제 확인: lookupSecret 자체는 인증 방식을 안 본다(refOf 가 키 인증의 secretRef 도 준다).
    // 그래서 **부르는 쪽**이 걸러야 한다는 것이 이 검사의 요지다.
    expect(profiles.lookupSecret(p)).toEqual({ ok: true, secret: PASSPHRASE })
    expect(sudoPasswordOf(sess(p.id), profiles, 's1')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('비밀번호 인증이면 그 비밀번호를 준다 — 기능은 그대로다', () => {
    const { profiles, dir } = store()
    const p = profiles.save({ type: 'ssh', name: 'pw-srv', host: 'h', port: 22, username: 'u', authType: 'password', secret: SUDO_PW })
    expect(sudoPasswordOf(sess(p.id), profiles, 's1')).toBe(SUDO_PW)
    // 프로필이 없는 세션(로컬 셸 등)은 애초에 줄 것이 없다.
    expect(sudoPasswordOf(sess('없는프로필'), profiles, 's1')).toBeNull()
    expect(sudoPasswordOf(sess(p.id), profiles, '다른세션')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

// 2026-08-24 — 표를 다른 하단 탭 규격으로 옮기면서 열 머리 정렬이 붙었다(순수 함수).
describe('컨테이너 표 정렬', () => {
  const c = (over: Partial<CtrRow>): CtrRow => ({
    id: over.id ?? 'x',
    name: 'a',
    image: 'img',
    state: 'running',
    status: '',
    ports: '',
    ...over
  })

  it('기본은 멈춘 것부터 — "왜 안 떠 있지"가 이 화면을 여는 이유다', () => {
    const rows = [c({ id: '1', name: 'web' }), c({ id: '2', name: 'db', state: 'exited' })]
    expect(sortCtrs(rows, DEFAULT_CTR_SORT).map((r) => r.name)).toEqual(['db', 'web'])
    expect(sortCtrs(rows, { key: 'name', desc: false }).map((r) => r.name)).toEqual(['db', 'web'])
    expect(sortCtrs(rows, { key: 'name', desc: true }).map((r) => r.name)).toEqual(['web', 'db'])
  })

  it('열 머리를 다시 누르면 방향만 뒤집는다', () => {
    expect(nextCtrSort({ key: 'name', desc: false }, 'name')).toEqual({ key: 'name', desc: true })
    expect(nextCtrSort({ key: 'name', desc: true }, 'image')).toEqual({ key: 'image', desc: false })
  })
})

describe('파드 표 정렬', () => {
  const g = (name: string, over: Partial<CtrPodGroup> = {}): CtrPodGroup => ({
    key: 'ns/' + name,
    ns: 'ns',
    name,
    readyN: 1,
    total: 1,
    ready: true,
    restarts: 0,
    createdAt: null,
    cpuNs: null,
    memBytes: null,
    rows: [],
    ...over
  })

  it('기본은 아픈 파드부터(health)', () => {
    const gs = [g('ok'), g('sick', { readyN: 0 }), g('restarted', { restarts: 4 })]
    expect(sortPodGroups(gs, DEFAULT_POD_SORT).map((x) => x.name)).toEqual(['sick', 'restarted', 'ok'])
  })

  it('숫자 열은 큰 것부터 시작한다 — 열 머리를 처음 누를 때 보고 싶은 쪽', () => {
    expect(nextPodSort(DEFAULT_POD_SORT, 'mem')).toEqual({ key: 'mem', desc: true })
    expect(nextPodSort(DEFAULT_POD_SORT, 'pod')).toEqual({ key: 'pod', desc: false })
  })

  it('★ 값이 없는 파드는 어느 방향이든 아래로 — 모른다는 0 이 아니다', () => {
    const gs = [g('none'), g('big', { memBytes: 900 }), g('small', { memBytes: 10 })]
    expect(sortPodGroups(gs, { key: 'mem', desc: true }).map((x) => x.name)).toEqual(['big', 'small', 'none'])
    expect(sortPodGroups(gs, { key: 'mem', desc: false }).map((x) => x.name)).toEqual(['small', 'big', 'none'])
  })

  it('★ CPU 는 화면이 계산한 사용률로 정렬한다(누적 나노초로 하면 오래 산 파드가 이긴다)', () => {
    const a = g('a', { cpuNs: 999_999 })
    const b = g('b', { cpuNs: 1 })
    const pct = new Map([['ns/a', 0.1], ['ns/b', 42]])
    expect(sortPodGroups([a, b], { key: 'cpu', desc: true }, (x) => pct.get(x.key) ?? null).map((x) => x.name)).toEqual([
      'b',
      'a'
    ])
  })
})

describe('막힌 이유 다듬기', () => {
  it('★ time=/level=/msg= 껍데기를 벗기고 알맹이만 남긴다', () => {
    const raw =
      'time="2026-08-24T10:50:03+09:00" level=fatal msg="validate service connection: validate CRI v1 runtime API for endpoint \\"unix:///run/containerd/containerd.sock\\": rpc error: code = Unavailable desc = connection error: desc = \\"transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: permission denied\\""'
    const out = tidyReason(raw)
    expect(out).not.toContain('level=fatal')
    expect(out).not.toContain('time=')
    expect(out).toContain('permission denied')
    expect(out.length).toBeLessThan(90)
  })

  it('짧은 문장은 그대로 둔다(억지로 자르지 않는다)', () => {
    expect(tidyReason('docker: command not found')).toBe('docker: command not found')
  })
})
