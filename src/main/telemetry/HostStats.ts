// F29 시스템 모니터 — **세션과 무관한** 내 PC 통계.
//
// 왜 LocalTelemetry 로 안 되는가: 그쪽은 "로컬 셸 세션 하나"의 게이지라 sessionId 로 구독한다.
// 사이드바의 [로컬] 탭은 로컬 셸을 하나도 안 열어 둔 상태(SSH 만 쓰는 중)에서도 내 PC 를 보여 줘야
// 하므로 세션에 매달 수 없다. 계산은 LocalTelemetry 의 순수 함수를 그대로 재사용한다(중복 금지).
//
// 디스크가 CPU·메모리와 다른 주기인 이유: df/statfs 는 무겁고 디스크 사용량은 초 단위로 변하지 않는다.
// 같은 2.5초로 돌리면 얻는 것 없이 I/O 만 늘어난다.
import * as os from 'node:os'
import { existsSync, statfs } from 'node:fs'
import type { DiskUsage, HostStats } from '@shared/types'
import { cpuPctOf, type CpuSample } from './RemoteTelemetry'
import { cpuSampleOf, memStatsOf } from './LocalTelemetry'

const POLL_MS = 2500 // CPU·메모리 — LocalTelemetry.POLL_MS 와 같은 박자(표시 형식 통일).
const DISK_EVERY = 12 // 디스크는 12틱마다 = 30초.

// ── 순수 함수(단위 테스트 대상) ──

/** statfs 원자료 → 표시용. bavail(비권한 사용자 가용)을 쓴다 — df 가 보여 주는 값과 같은 기준이다. */
export function diskOf(mount: string, s: { bsize: number; blocks: number; bavail: number }): DiskUsage | null {
  const totalKb = Math.round((s.blocks * s.bsize) / 1024)
  const freeKb = Math.round((s.bavail * s.bsize) / 1024)
  if (!Number.isFinite(totalKb) || totalKb <= 0) return null
  const usedKb = Math.max(0, totalKb - freeKb)
  return { mount, totalKb, usedKb, usePct: Math.min(100, Math.round((usedKb / totalKb) * 100)) }
}

/**
 * 검사할 마운트 목록. Windows 는 드라이브 문자를 훑는다 — 목록을 주는 무의존 API 가 없다.
 * 한 번만 구하고 캐시한다(USB 를 꽂았다 빼는 것까지 따라가지 않는다 — 그건 이 화면의 목적이 아니다).
 */
export function mountsFor(platform: string, exists: (p: string) => boolean): string[] {
  if (platform !== 'win32') return ['/']
  const out: string[] = []
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c += 1) {
    const drive = `${String.fromCharCode(c)}:\\`
    if (exists(drive)) out.push(drive)
  }
  return out.length > 0 ? out : ['C:\\']
}

// ── 폴링 ──

export type HostStatsService = { start(): void; stop(): void; running(): boolean }

export function createHostStatsService(
  emit: (s: HostStats) => void,
  intervalMs: number = POLL_MS
): HostStatsService {
  let timer: NodeJS.Timeout | null = null
  let prev: CpuSample | null = null
  let tick = 0
  let mounts: string[] | null = null
  let disks: DiskUsage[] = [] // 마지막으로 읽은 값 — 디스크 틱이 아닌 회차에도 그대로 실어 보낸다.

  async function readDisks(): Promise<void> {
    if (!mounts) mounts = mountsFor(process.platform, existsSync)
    const read = mounts.map(
      (m) =>
        new Promise<DiskUsage | null>((resolve) => {
          // CD 드라이브·연결 끊긴 네트워크 드라이브는 던진다 — 그 칸만 조용히 빼고 나머지는 보여 준다.
          statfs(m, (err, s) => resolve(err ? null : diskOf(m, s as unknown as { bsize: number; blocks: number; bavail: number })))
        })
    )
    disks = (await Promise.all(read)).filter((d): d is DiskUsage => d !== null)
  }

  function sample(): void {
    const cur = cpuSampleOf(os.cpus())
    const cpuPct = cpuPctOf(cur, prev)
    prev = cur
    if (tick % DISK_EVERY === 0) void readDisks()
    tick += 1
    emit({ cpuPct, ...memStatsOf(os.totalmem(), os.freemem()), disks, hostname: os.hostname(), platform: process.platform })
  }

  return {
    start() {
      if (timer) return
      tick = 0
      timer = setInterval(sample, intervalMs)
      sample() // 첫 화면을 주기만큼 기다리지 않게(RemoteTelemetry 관행과 동일).
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
      prev = null
    },
    running: () => timer !== null
  }
}
