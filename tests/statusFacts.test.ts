import { describe, it, expect } from 'vitest'
import { hostFacts, NA, uptimeShort } from '../src/renderer/components/StatusBar'
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

  it('로컬 — OS 는 내 PC, 가동은 읽는 길이 없어 —(개요는 무시)', () => {
    const f = hostFacts(local, { ...parseOverview(''), distro: 'Ubuntu', uptimeSec: 1 })
    expect(['Windows', 'macOS']).toContain(f.os)
    expect(f.uptime).toBe(NA)
  })
})
