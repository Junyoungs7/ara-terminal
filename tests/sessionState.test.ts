import { describe, it, expect } from 'vitest'
import {
  forgetSessionState,
  rdpSessionState,
  sessionState,
  setSessionState,
  type RdpPhase
} from '../src/renderer/store/sessionState'
import { sessionTip, type Session } from '../src/renderer/store/sessions'

// #166: 점 하나가 자리마다 다른 뜻(서버색·복원 실패·AI 상태)을 말하던 것을 **상태 하나**로 모았다.
// 여기서 못 박는 것은 그 판정이다 — 화면 셋이 같은 함수를 보므로 여기가 갈리면 셋이 함께 갈린다.

describe('rdpSessionState (RDP 단계 → 점)', () => {
  it('붙어 있으면 켜짐', () => {
    expect(rdpSessionState('connected')).toBe('on')
  })

  // 이 한 줄이 #166 의 본체다: 예전 칸 머리 점은 phase 를 안 봐서 끊겨도 초록이었다.
  it('끊기거나 오류면 켜짐이 아니다', () => {
    expect(rdpSessionState('error')).toBe('lost')
  })

  it('아직 안 붙었으면(비밀번호 대기 포함) 연결 중', () => {
    expect(rdpSessionState('connecting')).toBe('connecting')
    expect(rdpSessionState('creds')).toBe('connecting')
  })

  it('어휘는 셋뿐 — 어떤 단계도 그 밖을 가리키지 않는다', () => {
    const phases: RdpPhase[] = ['creds', 'connecting', 'connected', 'error']
    for (const p of phases) expect(['on', 'connecting', 'lost']).toContain(rdpSessionState(p))
  })
})

describe('sessionState (세션 → 점)', () => {
  it('모르는 세션은 켜짐 — 목록에 있다는 것은 main 이 살아 있다고 말한 것이다', () => {
    expect(sessionState('never-registered')).toBe('on')
  })

  it('끊김을 등록하면 그 세션만 바뀐다', () => {
    setSessionState('dropped-1', 'lost')
    expect(sessionState('dropped-1')).toBe('lost')
    expect(sessionState('other-1')).toBe('on')
  })

  it('세션이 닫히면 흔적이 남지 않는다(id 를 재사용해도 끊김이 따라붙지 않는다)', () => {
    setSessionState('gone-1', 'lost')
    forgetSessionState('gone-1')
    expect(sessionState('gone-1')).toBe('on')
  })
})

describe('sessionTip (점이 잃은 서버 단서를 글자로)', () => {
  const s = (title: string, serverKey: string): Session => ({ id: 'x', title, serverKey, type: 'ssh' })

  it('제목이 서버 이름과 다르면 서버를 함께 적는다 — 이름 변경·OSC 제목이 덮은 경우다', () => {
    expect(sessionTip(s('~/work', 'web-prod-01'))).toBe('~/work · web-prod-01')
  })

  it('같으면 두 번 적지 않는다', () => {
    expect(sessionTip(s('web-prod-01', 'web-prod-01'))).toBe('web-prod-01')
  })
})
