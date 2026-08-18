// FB-monitor(FB-0003) — [모니터] 탭 검색·범위 필터 순수 함수. 실제 파싱(parsePorts)은
// tests/telemetry.test.ts 가 이미 본다 — 여기는 그 결과를 걸러내는 filterPorts 만 본다.
import { describe, it, expect } from 'vitest'
import { filterPorts, parsePortInput } from '../src/renderer/components/PortMonitor'
import type { RemotePort } from '../src/shared/types'

const PORTS: RemotePort[] = [
  { proto: 'tcp', port: 22, pid: 812, process: 'sshd' },
  { proto: 'tcp6', port: 22, pid: 812, process: 'sshd' },
  { proto: 'tcp', port: 443, pid: 1180, process: 'nginx' },
  { proto: 'tcp', port: 5432, pid: 1044, process: 'postgres' },
  { proto: 'tcp', port: 8080, pid: 2451, process: 'node' },
  { proto: 'tcp', port: 33060 } // 권한 없음 — process/pid 없음
]

// 2026-08-18(제보 ②): [사용자 포트|전체] 세그를 걷었다 — 1024 라는 경계를 앱이 정해 놓고
// 그 아래를 **기본으로 감췄는데**, 정작 사람이 자주 찾는 22·443 이 거기 있었다. 감출지 말지는
// 범위 입력으로 사용자가 정한다(같은 일을 더 정확히 하는 컨트롤이 이미 옆에 있었다).
describe('filterPorts — 기본은 다 보여 준다', () => {
  it('★ 아무 필터도 안 걸면 시스템 포트도 나온다', () => {
    const r = filterPorts(PORTS, '')
    expect(r.visible).toHaveLength(6)
    expect(r.visible.map((p) => p.port)).toContain(22)
    expect(r.visible.map((p) => p.port)).toContain(443)
  })
})

describe('filterPorts — 검색', () => {
  it('포트 번호 부분일치로 찾는다', () => {
    const r = filterPorts(PORTS, '80')
    expect(r.visible.map((p) => p.port)).toEqual([8080])
  })

  it('프로세스명 부분일치로 찾는다(대소문자 무시)', () => {
    const r = filterPorts(PORTS, 'NGINX')
    expect(r.visible.map((p) => p.port)).toEqual([443])
  })

  it('★ 시스템 포트도 검색된다 — 예전엔 기본 범위에 가려 안 나왔다', () => {
    const r = filterPorts(PORTS, 'sshd')
    expect(r.visible.map((p) => p.port)).toEqual([22, 22])
  })

  it('프로세스를 모르는 포트(권한 없음)는 프로세스명 검색에 걸리지 않지만 포트 번호로는 찾을 수 있다', () => {
    expect(filterPorts(PORTS, '33060').visible.map((p) => p.port)).toEqual([33060])
    expect(filterPorts(PORTS, 'unknown').visible).toEqual([])
  })

  it('안 걸리면 빈 목록', () => {
    expect(filterPorts(PORTS, 'zzz-no-match').visible).toEqual([])
  })

  it('빈 배열 입력은 그대로 빈 결과다', () => {
    expect(filterPorts([], '')).toEqual({ visible: [] })
  })
})

// 실사용 피드백(A-2): 번호 구간 · 포워딩 상태로도 좁힐 수 있어야 한다. 조건은 전부 AND —
// 하나라도 OR 로 새면 "좁히려고 넣은 조건이 오히려 목록을 늘리는" 반대 동작이 된다.
describe('포트 구간·포워딩 상태 필터', () => {
  const p = (port: number, process: string): RemotePort => ({ proto: 'tcp', port, pid: 1, process })
  const ports = [p(22, 'sshd'), p(3000, 'vite'), p(5432, 'postgres'), p(8080, 'node'), p(9090, 'cockpit')]

  it('구간 안쪽만 남긴다(경계 포함)', () => {
    const r = filterPorts(ports, '', { min: 3000, max: 8080 })
    expect(r.visible.map((x) => x.port)).toEqual([3000, 5432, 8080])
  })

  it('한쪽만 줘도 된다', () => {
    expect(filterPorts(ports, '', { min: 8080, max: null }).visible.map((x) => x.port)).toEqual([8080, 9090])
    expect(filterPorts(ports, '', { min: null, max: 3000 }).visible.map((x) => x.port)).toEqual([22, 3000])
  })

  it('포워딩 중인 것만 / 아직 안 한 것만', () => {
    const fwd = [3000, 8080]
    expect(filterPorts(ports, '', { min: null, max: null }, 'fwd', fwd).visible.map((x) => x.port)).toEqual([
      3000, 8080
    ])
    expect(filterPorts(ports, '', { min: null, max: null }, 'free', fwd).visible.map((x) => x.port)).toEqual([
      22, 5432, 9090
    ])
  })

  it('검색어·범위·구간·상태는 함께 걸린다(AND)', () => {
    const r = filterPorts(ports, '0', { min: 3000, max: 9000 }, 'free', [3000])
    expect(r.visible.map((x) => x.port)).toEqual([8080]) // 22 는 사용자 포트 밖, 3000 은 포워딩 중, 9090 은 구간 밖
  })

  it('입력칸 파싱 — 빈 값·숫자 아님·범위 밖은 제한 없음(null)', () => {
    expect(parsePortInput('8080')).toBe(8080)
    expect(parsePortInput('  22 ')).toBe(22)
    expect(parsePortInput('')).toBeNull()
    expect(parsePortInput('abc')).toBeNull()
    expect(parsePortInput('70000')).toBeNull()
    expect(parsePortInput('-1')).toBeNull()
  })
})
