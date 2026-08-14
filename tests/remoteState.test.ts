import { describe, it, expect } from 'vitest'
import { remoteError } from '../src/renderer/store/remoteState'

// #68(2026-08-14) — 원격 표가 "읽기 실패"와 "아직 안 옴"을 가르는 규칙.
//
// 왜 필요했나: main 이 실패한 폴링 한 바퀴를 조용히 버려서 행이 0 인 채로 남았고, 화면은
// "불러오는 중"을 영원히 보여 줬다. 권한 부족·명령 없음·연결 끊김이 전부 로딩으로 보였다.
// #57(런치패드 [패키지]가 빈 표)이 같은 종류의 사고였다.

describe('remoteError — 읽기 실패 판정', () => {
  it('한 바퀴가 아예 실패하면 그 사유를 한국어로 돌려준다', () => {
    expect(remoteError({ out: '', err: 'noSession' }, 0)).toBe('SSH 세션이 끊어졌습니다')
    expect(remoteError({ out: '', err: 'timeout' }, 0)).toBe('서버가 제때 답하지 않았습니다')
    expect(remoteError({ out: '', err: 'exec' }, 0)).toBe('명령을 실행하지 못했습니다')
    expect(remoteError({ out: '', err: 'badArgs' }, 0)).toBe('값이 올바르지 않아 실행하지 않았습니다')
  })

  it('★ 행이 0 이고 종료코드가 0 이 아니면 출력이 곧 오류 메시지다', () => {
    // stdout·stderr 가 한 버퍼로 오므로 권한 메시지가 여기 들어 있다.
    expect(remoteError({ out: 'ps: permission denied\n', code: 1 }, 0)).toBe('ps: permission denied')
  })

  it('★ 행이 하나라도 나왔으면 오류가 아니다 — 종료코드가 0 이 아니어도', () => {
    // 카탈로그의 일부 스크립트는 정상 출력을 내면서도 0 이 아니다(`command -v` 로 없는 프로그램을
    // 건너뛰는 pkg.probe). 코드만 보고 판정하면 멀쩡한 표에 오류가 뜬다.
    expect(remoteError({ out: 'bash\t/bin/bash\t5.1\t0', code: 1 }, 3)).toBeNull()
  })

  it('정상(코드 0)은 행이 0 이어도 오류가 아니다 — 로딩·빈 결과는 표가 구분한다', () => {
    expect(remoteError({ out: '', code: 0 }, 0)).toBeNull()
    expect(remoteError({ out: 'HEADER ONLY\n', code: 0 }, 0)).toBeNull()
  })

  it('코드가 0 이 아니어도 출력이 비어 있으면 띄울 말이 없다 — 오류로 보지 않는다', () => {
    expect(remoteError({ out: '   \n', code: 2 }, 0)).toBeNull()
  })

  it('아직 아무 정보도 없는 첫 상태(code 미지정)는 오류가 아니다', () => {
    expect(remoteError({ out: '' }, 0)).toBeNull()
  })

  it('err 는 코드보다 우선한다', () => {
    expect(remoteError({ out: 'ignored', code: 1, err: 'timeout' }, 0)).toBe('서버가 제때 답하지 않았습니다')
  })
})
