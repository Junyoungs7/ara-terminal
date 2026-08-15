import { describe, it, expect } from 'vitest'
import { parseLogName, logFileName, sanitizeKey, stamp } from '../src/main/log/SessionLog'
import type { Session } from '../src/shared/types'

// #86(2026-08-16) 지난 세션 목록 — 파일 이름이 곧 색인이다.
//
// 별도 색인 파일을 만들지 않은 이유: 파일과 색인이 어긋나면 어느 쪽이 진실인지 정해야 하고,
// 보존 스윕(sweep)이 파일을 지울 때마다 색인도 손봐야 한다. 이름만 읽으면 그 문제가 없다.
// 대신 **이름을 정확히 되읽는 것**이 이 기능의 전부라 여기서 그것만 지킨다.

const meta = (serverKey: string, id: string): Session =>
  ({ id, type: 'ssh', title: 't', serverKey }) as Session

describe('parseLogName — 이름을 되읽는다', () => {
  it('logFileName 이 만든 이름을 그대로 되읽는다(왕복)', () => {
    const at = new Date(2026, 7, 16, 3, 45, 12) // 2026-08-16 03:45:12 로컬
    const name = logFileName(meta('dev-server', 'abcdef12-3456-7890-abcd-ef1234567890'), at)
    const got = parseLogName(name)
    expect(got).not.toBeNull()
    expect(got!.serverKey).toBe('dev-server')
    // stamp 는 **로컬 시각**이다 — UTC 로 되읽으면 시각이 밀린다(이 검사가 그걸 잡는다).
    expect(new Date(got!.startedAt).getHours()).toBe(3)
    expect(got!.startedAt).toBe(at.setMilliseconds(0))
  })

  it('★ 서버 이름에 밑줄이 있어도 가른다 — sanitizeKey 가 밑줄을 남긴다', () => {
    // 공백·슬래시가 밑줄이 되므로 실제로 흔하다.
    expect(sanitizeKey('내 서버/2')).toBe('내_서버_2')
    const name = logFileName(meta('내 서버/2', 'aabbccdd-0000-0000-0000-000000000000'), new Date(2026, 0, 2, 1, 2, 3))
    expect(parseLogName(name)!.serverKey).toBe('내_서버_2')
  })

  it('한글 서버 이름을 그대로 지킨다 — 전부 밑줄이 되면 로그를 못 찾는다', () => {
    const name = logFileName(meta('운영서버', '11112222-0000-0000-0000-000000000000'), new Date(2026, 4, 5, 6, 7, 8))
    expect(parseLogName(name)!.serverKey).toBe('운영서버')
  })

  it('우리 규칙이 아닌 이름은 null — 사용자가 그 폴더에 넣어 둔 파일은 목록에 안 낸다', () => {
    for (const bad of [
      'readme.txt',
      '20260816-034512_dev.log', // id8 없음
      '20260816-034512_dev_XYZ12345.log', // id8 이 16진수가 아니다
      '2026816-034512_dev_a1b2c3d4.log', // 날짜 자릿수
      '20260816-034512_dev_a1b2c3d4.txt' // 확장자
    ]) {
      expect(parseLogName(bad), bad).toBeNull()
    }
  })

  it('★ 있지도 않은 날짜는 거절한다 — Date 가 조용히 넘겨 버린다(13월 → 다음 해 1월)', () => {
    expect(parseLogName('20261301-000000_dev_a1b2c3d4.log')).toBeNull()
    expect(parseLogName('20260231-000000_dev_a1b2c3d4.log')).toBeNull() // 2월 31일
  })

  it('stamp 는 자리를 채운다 — 한 자리 달·시가 이름 길이를 흔들면 파싱이 깨진다', () => {
    expect(stamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405')
  })
})
