import { describe, it, expect } from 'vitest'
import { diskOf, mountsFor } from '../src/main/telemetry/HostStats'
import { HISTORY_MAX, memPctOf, pushSample, realDisks, sampleOf, sparkPoints } from '../src/renderer/store/sysMonitor'
import type { DiskUsage } from '../src/shared/types'

// F29 시스템 모니터 — 순수 로직. 그래프·표는 이 함수들이 만든 숫자를 그대로 그리므로,
// 여기서 틀리면 화면이 조용히 거짓말을 한다(NaN 은 선이 사라지고, 0 나눗셈은 100% 로 보인다).

describe('디스크 계산(main)', () => {
  it('statfs 원자료를 사용량·퍼센트로 바꾼다(bavail 기준 = df 와 같은 기준)', () => {
    // 1KiB 블록 100개 중 사용 가능 25개 → 75% 사용.
    const d = diskOf('/', { bsize: 1024, blocks: 100, bavail: 25 })
    expect(d).toEqual({ mount: '/', totalKb: 100, usedKb: 75, usePct: 75 })
  })

  it('총량이 0 이거나 이상치면 그 칸을 버린다(0 나눗셈 금지)', () => {
    expect(diskOf('/', { bsize: 1024, blocks: 0, bavail: 0 })).toBeNull()
    expect(diskOf('/', { bsize: 0, blocks: 100, bavail: 10 })).toBeNull()
  })

  it('가용량이 총량을 넘는 이상치에도 사용량이 음수가 되지 않는다', () => {
    const d = diskOf('/', { bsize: 1024, blocks: 10, bavail: 99 })
    expect(d?.usedKb).toBe(0)
    expect(d?.usePct).toBe(0)
  })

  it('Windows 는 존재하는 드라이브 문자만, POSIX 는 / 하나', () => {
    expect(mountsFor('linux', () => true)).toEqual(['/'])
    expect(mountsFor('win32', (p) => p === 'C:\\' || p === 'D:\\')).toEqual(['C:\\', 'D:\\'])
    // 하나도 못 찾아도 빈 화면을 내지 않는다 — C: 로 떨어뜨린다.
    expect(mountsFor('win32', () => false)).toEqual(['C:\\'])
  })
})

describe('시계열 버퍼(렌더러)', () => {
  const s = (cpu: number) => ({ cpuPct: cpu, memPct: 0 })

  it('상한을 넘으면 가장 오래된 것부터 버린다(그래프가 왼쪽으로 흐른다)', () => {
    let list = [] as ReturnType<typeof s>[]
    for (let i = 0; i < HISTORY_MAX + 5; i += 1) list = pushSample(list, s(i))
    expect(list).toHaveLength(HISTORY_MAX)
    expect(list[0]!.cpuPct).toBe(5) // 0~4 가 밀려났다
    expect(list[list.length - 1]!.cpuPct).toBe(HISTORY_MAX + 4)
  })

  it('메모리 퍼센트는 총량이 0 이어도 NaN 이 되지 않는다', () => {
    expect(memPctOf(500, 1000)).toBe(50)
    expect(memPctOf(10, 0)).toBe(0)
    expect(memPctOf(10, Number.NaN)).toBe(0)
    expect(memPctOf(2000, 1000)).toBe(100) // 상한
  })

  it('표본은 0~100 으로 잘리고, GPU 는 값이 있을 때만 실린다', () => {
    expect(sampleOf({ cpuPct: 150, memUsedKb: 1, memTotalKb: 2 })).toEqual({ cpuPct: 100, memPct: 50 })
    expect(sampleOf({ cpuPct: -3, memUsedKb: 0, memTotalKb: 100 }).cpuPct).toBe(0)
    expect(sampleOf({ cpuPct: 10, memUsedKb: 1, memTotalKb: 2, gpuPct: 42 }).gpuPct).toBe(42)
    expect('gpuPct' in sampleOf({ cpuPct: 10, memUsedKb: 1, memTotalKb: 2 })).toBe(false)
  })
})

describe('스파크라인 좌표', () => {
  it('표본이 없으면 빈 문자열(선을 그리지 않는다)', () => {
    expect(sparkPoints([], 100, 10)).toBe('')
  })

  it('표본이 하나면 양 끝을 같은 값으로 — 점 하나는 선으로 안 보인다', () => {
    // 최댓값 50 → 스케일 50 → 천장에 닿는다.
    expect(sparkPoints([50], 100, 10)).toBe('0.0,0.0 100.0,0.0')
  })

  it('0 은 바닥, 최댓값은 천장(y 축이 뒤집혀 있다)', () => {
    expect(sparkPoints([0, 100], 100, 10)).toBe('0.0,10.0 100.0,0.0')
  })

  it('범위를 벗어난 값도 그래프 밖으로 삐져나가지 않는다', () => {
    expect(sparkPoints([-50, 250], 100, 10)).toBe('0.0,10.0 100.0,0.0')
  })

  // 2026-08-22 준영님 제보 27번 — 유휴 서버에서 그래프가 일직선으로 보이던 것.
  it('낮은 값 구간은 스케일을 좁혀 변화가 보이게 한다', () => {
    // 0~100 고정이면 1 과 3 은 10px 안에서 0.2px 차이 — 직선이다.
    // 스케일 10 이면 각각 바닥에서 1px, 3px 로 갈린다.
    expect(sparkPoints([1, 3], 100, 10)).toBe('0.0,9.0 100.0,7.0')
  })

  it('스케일은 10 단위로 올려 잡는다 — 표본마다 흔들리지 않게', () => {
    // 최댓값 42 → 스케일 50. 42/50 = 84% 높이.
    expect(sparkPoints([0, 42], 100, 10)).toBe('0.0,10.0 100.0,1.6')
    // 최댓값 44 도 같은 스케일 50 이라 선의 기울기만 조금 달라진다(축이 안 튄다).
    expect(sparkPoints([0, 44], 100, 10)).toBe('0.0,10.0 100.0,1.2')
  })

  it('스케일 하한이 있어 측정 노이즈가 산맥이 되지 않는다', () => {
    // 전부 0 이어도 스케일 10 — 바닥에 붙은 평평한 선이다(0 으로 나누지 않는다).
    expect(sparkPoints([0, 0, 0], 100, 10)).toBe('0.0,10.0 50.0,10.0 100.0,10.0')
  })
})

describe('가상 파일시스템 숨김', () => {
  const d = (mount: string): DiskUsage => ({ mount, totalKb: 100, usedKb: 1, usePct: 1 })

  it('tmpfs·overlay 등은 빼고 실제 것만 남긴다(F26 디스크 창과 같은 규칙)', () => {
    const list = [d('/'), d('/run'), d('/data')]
    expect(realDisks(list, ['ext4', 'tmpfs', 'xfs']).map((x) => x.mount)).toEqual(['/', '/data'])
  })

  it('타입을 모르면 거르지 않는다(로컬 statfs 는 타입을 안 준다)', () => {
    expect(realDisks([d('C:\\'), d('D:\\')])).toHaveLength(2)
  })
})
