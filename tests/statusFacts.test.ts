import { describe, it, expect, vi } from 'vitest'
import * as os from 'node:os'
import { hostFacts, loadOverview, localPrimary, NA, osLabel, statusModel, uptimeShort } from '../src/renderer/components/StatusBar'
import { createHostStatsService } from '../src/main/telemetry/HostStats'
import type { HostStats } from '../src/shared/types'
import { parseOverview } from '../src/shared/remoteCatalog'
import type { Session } from '../src/renderer/store/sessions'

// 2.0 상태바 OS·가동 칸 — 활성 탭 기준, 값이 없으면 — (칸은 그대로).
describe('2.0 상태바 hostFacts', () => {
  const ssh: Session = { id: 's2', title: 'web-01', serverKey: '결제서버', type: 'ssh' }
  const local: Session = { id: 's1', title: '셸 1', serverKey: 'localhost', type: 'local' }

  it('가동 짧은 표기 — 일·시 / 시·분 / 분, 못 읽으면 —', () => {
    expect(uptimeShort(12 * 86400 + 3 * 3600 + 59)).toBe('12d 3h')
    expect(uptimeShort(2 * 3600 + 5 * 60)).toBe('2h 5m')
    expect(uptimeShort(42)).toBe('0m')
    expect(uptimeShort(null)).toBe(NA)
    expect(uptimeShort(undefined)).toBe(NA)
  })

  it('세션이 없으면 둘 다 —', () => {
    expect(hostFacts(null, null)).toEqual({ os: NA, uptime: NA })
  })

  it('SSH — 개요가 오기 전엔 —, 오면 배포판·가동', () => {
    expect(hostFacts(ssh, null)).toEqual({ os: NA, uptime: NA })
    const ov = { ...parseOverview(''), distro: 'Ubuntu 22.04', uptimeSec: 90000 }
    expect(hostFacts(ssh, ov)).toEqual({ os: 'Ubuntu 22.04', uptime: '1d 1h' })
  })

  it('로컬 — 내 PC 값이 오기 전엔 —, 오면 OS·가동(개요는 무시)', () => {
    const ov = { ...parseOverview(''), distro: 'Ubuntu', uptimeSec: 1 }
    expect(hostFacts(local, ov)).toEqual({ os: NA, uptime: NA })
    expect(hostFacts(local, ov, host)).toEqual({ os: 'Windows 11 23H2', uptime: '2h 5m' })
    // 세션이 없어도 내 PC(다듬기 R3 — 켜자마자)
    expect(hostFacts(null, null, host)).toEqual({ os: 'Windows 11 23H2', uptime: '2h 5m' })
    // SSH 탭은 내 PC 를 무시하고 그 서버
    expect(hostFacts(ssh, null, host)).toEqual({ os: NA, uptime: NA })
  })
})

const host: HostStats = {
  cpuPct: 34,
  memUsedKb: 7.4 * 1024 * 1024,
  memTotalKb: 15.6 * 1024 * 1024,
  disks: [],
  hostname: 'DESKTOP-1',
  platform: 'win32',
  user: 'jun',
  osRelease: '10.0.22631',
  uptimeSec: 2 * 3600 + 5 * 60
}

// 다듬기 R3 — 켜자마자 상태바에 내 PC.
describe('상태바 내 PC', () => {
  const local: Session = { id: 's1', title: '셸 1', serverKey: 'localhost', type: 'local' }
  const ssh: Session = { id: 's2', title: 'web-01', serverKey: '결제서버', type: 'ssh' }

  it('osLabel — Windows 빌드 → 기능 업데이트 이름, 모르는 빌드는 번호', () => {
    expect(osLabel('win32', '10.0.22631')).toBe('Windows 11 23H2')
    expect(osLabel('win32', '10.0.26100')).toBe('Windows 11 24H2')
    expect(osLabel('win32', '10.0.19045')).toBe('Windows 10 22H2')
    expect(osLabel('win32', '10.0.27000')).toBe('Windows 11 (27000)')
    expect(osLabel('win32', '10.0.18363')).toBe('Windows 10 (18363)')
    expect(osLabel('win32', '')).toBe('Windows')
    expect(osLabel('darwin', '23.4.0')).toBe('macOS 14')
    expect(osLabel('linux', '6.8.0-45-generic')).toBe('Linux 6.8.0')
  })

  it('계정@호스트 — 계정을 못 읽으면 호스트만', () => {
    expect(localPrimary(host)).toBe('jun@DESKTOP-1')
    expect(localPrimary({ ...host, user: '' })).toBe('DESKTOP-1')
  })

  it('세션 없음 — 유휴 문구 대신 내 PC 와 게이지(CPU% · MEM 사용/전체 · GPU 없음)', () => {
    const m = statusModel(null, undefined, {}, null, null, [], host)
    expect(m.idle).toBe(true)
    expect(m.primary).toBe('jun@DESKTOP-1')
    expect(m.gauges.map((g) => [g.key, g.text])).toEqual([
      ['cpu', '34%'],
      ['mem', '7.4/15.6G']
    ])
    // 첫 표본 전에는 예전 유휴 문구
    expect(statusModel(null, undefined, {}, null).primary).toContain('유휴')
  })

  it('로컬 탭 — 셸 이름 대신 내 PC, 경로는 그대로 / SSH 탭은 그 서버', () => {
    const m = statusModel(local, undefined, {}, 'D:/AI', null, [], host)
    expect(m.primary).toBe('jun@DESKTOP-1')
    expect(m.cwd).toBe('D:/AI')
    expect(m.gauges[0]?.text).toBe('34%')
    expect(statusModel(ssh, undefined, {}, null, null, [], null).primary).toBe('결제서버')
  })
})

// 내 PC 폴러가 새 칸(계정·OS 원문·가동)을 실어 보낸다 — os 모듈만, 자식 프로세스 없음.
describe('HostStats 폴러', () => {
  it('첫 표본에 user·osRelease·uptimeSec 를 싣고, stop 하면 멈춘다', () => {
    vi.useFakeTimers()
    const got: HostStats[] = []
    const svc = createHostStatsService((s) => got.push(s), 1000)
    svc.start()
    expect(got).toHaveLength(1)
    expect(got[0]!.osRelease).toBe(os.release())
    expect(typeof got[0]!.user).toBe('string')
    expect(got[0]!.uptimeSec).toBeGreaterThan(0)
    vi.advanceTimersByTime(2000)
    expect(got).toHaveLength(3)
    svc.stop()
    vi.advanceTimersByTime(5000)
    expect(got).toHaveLength(3)
    vi.useRealTimers()
  })
})

// 다듬기 R2(리뷰 B8): 접속 직후 한 번 실패하면 그 세션 내내 — 였다. 실패하면 한 번만 다시 묻는다.
describe('상태바 개요 재시도', () => {
  const wait = vi.fn(() => Promise.resolve())
  it('첫 번째가 실패하면 한 번 더 묻고, 그 답을 쓴다', async () => {
    const run = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, out: '' })
    expect(await loadOverview(run, wait)).not.toBeNull()
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('던져도 실패로 치고 재시도한다 — 두 번 다 실패하면 null(더 묻지 않는다)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('x'))
    expect(await loadOverview(run, wait)).toBeNull()
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('첫 번째가 되면 다시 묻지 않는다', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, out: '' })
    await loadOverview(run, wait)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
