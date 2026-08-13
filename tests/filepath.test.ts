// [파일] 탭 경로·표기 헬퍼 (R7). 로컬(Windows)과 원격(posix) 경로를 한 트리가 다루므로
// 구분자 추론·브레드크럼 분해가 양쪽에서 맞아야 한다.
import { describe, it, expect } from 'vitest'
import { sepOf, joinPath, crumbs, humanSize, relTime, cdCommand } from '../src/renderer/components/filePath'

describe('filePath — 경로 헬퍼', () => {
  it('구분자 추론: 역슬래시가 있으면 Windows, 없으면 posix', () => {
    expect(sepOf('C:\\Users\\me')).toBe('\\')
    expect(sepOf('/srv/서비스')).toBe('/')
    expect(sepOf('.')).toBe('/')
  })

  it('joinPath — 각 플랫폼 구분자로 붙이고 중복 구분자를 만들지 않는다', () => {
    expect(joinPath('/srv/서비스', '로그')).toBe('/srv/서비스/로그')
    expect(joinPath('/', '로그')).toBe('/로그')
    expect(joinPath('C:\\Users\\me', '문서')).toBe('C:\\Users\\me\\문서')
    expect(joinPath('C:\\', '문서')).toBe('C:\\문서')
  })

  it('브레드크럼 — posix 는 루트가 /, Windows 는 드라이브가 첫 조각', () => {
    expect(crumbs('/srv/서비스')).toEqual([
      { label: '/', path: '/' },
      { label: 'srv', path: '/srv' },
      { label: '서비스', path: '/srv/서비스' }
    ])
    expect(crumbs('/')).toEqual([{ label: '/', path: '/' }])
    expect(crumbs('C:\\Users\\me')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'me', path: 'C:\\Users\\me' }
    ])
    expect(crumbs('')).toEqual([])
  })

  it('humanSize — 1024 단위, 10 이상은 정수', () => {
    expect(humanSize(512)).toBe('512')
    expect(humanSize(2150)).toBe('2.1K')
    expect(humanSize(18 * 1024 * 1024)).toBe('18M')
  })

  it('relTime — 일주일 안쪽은 상대시간, 그 뒤는 날짜', () => {
    const now = Date.UTC(2026, 7, 4, 12, 0, 0)
    expect(relTime(0, now)).toBe('')
    expect(relTime(now - 30 * 1000, now)).toBe('방금')
    expect(relTime(now - 5 * 60 * 1000, now)).toBe('5분 전')
    expect(relTime(now - 3 * 3600 * 1000, now)).toBe('3시간 전')
    expect(relTime(now - 2 * 86400 * 1000, now)).toBe('2일 전')
    // 8일 전 → 날짜 표기(YY.MM.DD). 로컬 타임존 기준으로 포맷하므로 같은 규칙으로 기대값을 만든다.
    const old = now - 8 * 86400 * 1000
    const d = new Date(old)
    const expected = `${String(d.getFullYear()).slice(2)}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
    expect(relTime(old, now)).toBe(expected)
  })

  // T1 BLOCKER-2 회귀: LF 로 보내면 conpty/PowerShell 이 줄을 실행하지 않고 연속 입력(`>>`)에 빠진다.
  it('cdCommand — 줄 실행은 CR(\\r), 경로는 따옴표로 감싼다', () => {
    expect(cdCommand('C:\\Users\\me\\문서')).toBe('cd "C:\\Users\\me\\문서"\r')
    expect(cdCommand('/srv/서비스/로그')).toBe('cd "/srv/서비스/로그"\r')
    expect(cdCommand('C:\\Program Files')).not.toContain('\n')
  })
})
