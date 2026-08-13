// FB-monitor(FB-0003) — [모니터] 탭 검색·범위 필터 순수 함수. 실제 파싱(parsePorts)은
// tests/telemetry.test.ts 가 이미 본다 — 여기는 그 결과를 걸러내는 filterPorts 만 본다.
import { describe, it, expect } from 'vitest'
import { filterPorts, freePorts, parsePortInput } from '../src/renderer/components/PortMonitor'
import type { RemotePort } from '../src/shared/types'

const PORTS: RemotePort[] = [
  { proto: 'tcp', port: 22, pid: 812, process: 'sshd' },
  { proto: 'tcp6', port: 22, pid: 812, process: 'sshd' },
  { proto: 'tcp', port: 443, pid: 1180, process: 'nginx' },
  { proto: 'tcp', port: 5432, pid: 1044, process: 'postgres' },
  { proto: 'tcp', port: 8080, pid: 2451, process: 'node' },
  { proto: 'tcp', port: 33060 } // 권한 없음 — process/pid 없음
]

describe('filterPorts — 범위 필터', () => {
  it('기본값(user)은 1024 미만 시스템 포트를 숨긴다', () => {
    const r = filterPorts(PORTS, 'user', '')
    expect(r.visible.map((p) => p.port)).toEqual([5432, 8080, 33060])
    expect(r.hiddenByRange).toBe(3) // 22(tcp) · 22(tcp6) · 443
  })

  it('all 은 아무것도 숨기지 않는다', () => {
    const r = filterPorts(PORTS, 'all', '')
    expect(r.visible).toHaveLength(6)
    expect(r.hiddenByRange).toBe(0)
  })

  it('경계값 1024 는 사용자 포트로 취급한다(시스템 포트는 0~1023)', () => {
    const boundary: RemotePort[] = [{ proto: 'tcp', port: 1023 }, { proto: 'tcp', port: 1024 }]
    const r = filterPorts(boundary, 'user', '')
    expect(r.visible.map((p) => p.port)).toEqual([1024])
    expect(r.hiddenByRange).toBe(1)
  })
})

describe('filterPorts — 검색', () => {
  it('포트 번호 부분일치로 찾는다', () => {
    const r = filterPorts(PORTS, 'all', '80')
    expect(r.visible.map((p) => p.port)).toEqual([8080])
  })

  it('프로세스명 부분일치로 찾는다(대소문자 무시)', () => {
    const r = filterPorts(PORTS, 'all', 'NGINX')
    expect(r.visible.map((p) => p.port)).toEqual([443])
  })

  it('검색어는 범위 필터가 이미 걸러낸 것 안에서만 찾는다', () => {
    // sshd 는 22번(시스템 포트)에만 있다 — user 범위에서는 검색해도 안 나온다.
    const r = filterPorts(PORTS, 'user', 'sshd')
    expect(r.visible).toEqual([])
  })

  it('프로세스를 모르는 포트(권한 없음)는 프로세스명 검색에 걸리지 않지만 포트 번호로는 찾을 수 있다', () => {
    expect(filterPorts(PORTS, 'all', '33060').visible.map((p) => p.port)).toEqual([33060])
    expect(filterPorts(PORTS, 'all', 'unknown').visible).toEqual([])
  })

  it('hiddenByRange 는 검색어와 무관하게 범위 필터만 반영한다', () => {
    const r = filterPorts(PORTS, 'user', 'zzz-no-match')
    expect(r.visible).toEqual([])
    expect(r.hiddenByRange).toBe(3)
  })

  it('빈 배열 입력은 그대로 빈 결과다', () => {
    expect(filterPorts([], 'user', '')).toEqual({ visible: [], hiddenByRange: 0 })
  })
})

// 실사용 피드백(A-2): 번호 구간 · 포워딩 상태로도 좁힐 수 있어야 한다. 조건은 전부 AND —
// 하나라도 OR 로 새면 "좁히려고 넣은 조건이 오히려 목록을 늘리는" 반대 동작이 된다.
describe('포트 구간·포워딩 상태 필터', () => {
  const p = (port: number, process: string): RemotePort => ({ proto: 'tcp', port, pid: 1, process })
  const ports = [p(22, 'sshd'), p(3000, 'vite'), p(5432, 'postgres'), p(8080, 'node'), p(9090, 'cockpit')]

  it('구간 안쪽만 남긴다(경계 포함)', () => {
    const r = filterPorts(ports, 'all', '', { min: 3000, max: 8080 })
    expect(r.visible.map((x) => x.port)).toEqual([3000, 5432, 8080])
  })

  it('한쪽만 줘도 된다', () => {
    expect(filterPorts(ports, 'all', '', { min: 8080, max: null }).visible.map((x) => x.port)).toEqual([8080, 9090])
    expect(filterPorts(ports, 'all', '', { min: null, max: 3000 }).visible.map((x) => x.port)).toEqual([22, 3000])
  })

  it('포워딩 중인 것만 / 아직 안 한 것만', () => {
    const fwd = [3000, 8080]
    expect(filterPorts(ports, 'all', '', { min: null, max: null }, 'fwd', fwd).visible.map((x) => x.port)).toEqual([
      3000, 8080
    ])
    expect(filterPorts(ports, 'all', '', { min: null, max: null }, 'free', fwd).visible.map((x) => x.port)).toEqual([
      22, 5432, 9090
    ])
  })

  it('검색어·범위·구간·상태는 함께 걸린다(AND)', () => {
    const r = filterPorts(ports, 'user', '0', { min: 3000, max: 9000 }, 'free', [3000])
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

// 실사용 시나리오(준영님): "이 서버는 8000~9000 만 방화벽에 열려 있는데 어디가 비었는지 모르겠다."
// 이미 폴링해 둔 리슨 목록의 여집합이 답이다 — 원격에 뭘 더 묻지 않는다.
describe('구간 안의 빈 포트', () => {
  const listening = (...ns: number[]): RemotePort[] =>
    ns.map((port) => ({ proto: 'tcp' as const, port, pid: 1, process: 'x' }))

  it('리슨 중이 아닌 번호만 센다(양끝 포함)', () => {
    const r = freePorts(listening(8000, 8002, 8004), { min: 8000, max: 8004 })
    expect(r.list).toEqual([8001, 8003])
    expect(r.total).toBe(2)
  })

  it('총 개수는 다 세고 목록만 limit 만큼 준다(1000개를 다 그리지 않는다)', () => {
    const r = freePorts(listening(8500), { min: 8000, max: 9000 }, 3)
    expect(r.list).toEqual([8000, 8001, 8002])
    expect(r.total).toBe(1000) // 1001개 구간에서 8500 하나만 사용 중
  })

  it('구간이 없거나 뒤집혔으면 아무것도 안 센다(6만 개를 세지 않는다)', () => {
    expect(freePorts(listening(80), { min: null, max: 9000 })).toEqual({ list: [], total: 0 })
    expect(freePorts(listening(80), { min: 8000, max: null })).toEqual({ list: [], total: 0 })
    expect(freePorts(listening(80), { min: 9000, max: 8000 })).toEqual({ list: [], total: 0 })
  })

  it('tcp6 로만 잡힌 포트도 사용 중으로 본다(같은 번호를 또 못 연다)', () => {
    const r = freePorts([{ proto: 'tcp6', port: 8080, pid: 1, process: 'node' }], { min: 8080, max: 8081 })
    expect(r.list).toEqual([8081])
  })
})
