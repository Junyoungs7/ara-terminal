import { describe, it, expect } from 'vitest'
import { estimateTokens, trimToBudget, INPUT_BUDGET_TOKENS, type BudgetTurn } from '../src/main/ai/budget'
import { buildRequestCore } from '../src/main/ai/prompt'
import type { AiTurn } from '../src/shared/types'

// #80(2026-08-15) — 아라 입력 예산.
//
// 고치는 문제: 출력만 16,000 토큰으로 정해져 있었고 **입력에는 상한이 아예 없었다.**
// 대화 전량을 매 요청마다 보냈고, 옛 턴에 붙은 터미널 출력까지 다시 보냈다.
// 준영님 결정(2026-08-15): 10만 토큰.

const turn = (role: 'user' | 'assistant', content: string): BudgetTurn => ({ role, content })

describe('토큰 추정 — 넘겨 잡는 쪽으로만 틀린다', () => {
  it('한글은 1자 1토큰으로 본다(영어 4자/토큰 공식은 한국어를 크게 과소평가한다)', () => {
    expect(estimateTokens('안녕하세요')).toBe(5)
  })

  it('영문·기호는 3자당 1토큰(실제 4자/토큰보다 보수적)', () => {
    expect(estimateTokens('abcdef')).toBe(2)
  })

  it('★ 섞인 문장은 한글을 따로 센다 — 여기서 과소평가하면 400 을 맞는다', () => {
    // 한글 4 + 나머지 6자('  ls -al' 중 공백 포함) → 4 + ceil(6/3)
    const t = estimateTokens('디스크 확인 ls -al')
    expect(t).toBeGreaterThanOrEqual('디스크확인'.length)
    // 영어식 4자/토큰으로 재면 훨씬 작게 나온다 — 그 값보다 반드시 커야 한다.
    expect(t).toBeGreaterThan(Math.ceil('디스크 확인 ls -al'.length / 4))
  })

  it('빈 문자열은 0', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('trimToBudget — 오래된 턴부터 버린다', () => {
  it('예산 안에 들면 아무것도 안 버린다', () => {
    const turns = [turn('user', 'a'), turn('assistant', 'b')]
    expect(trimToBudget(turns, 1000)).toEqual({ kept: turns, dropped: 0 })
  })

  it('★ 첫 사용자 턴은 남긴다 — 거기에 과제 정의가 있다', () => {
    const turns = [
      turn('user', '가'.repeat(10)), // 과제 정의
      turn('assistant', '나'.repeat(100)),
      turn('user', '다'.repeat(100)),
      turn('assistant', '라'.repeat(100)),
      turn('user', '마'.repeat(10)) // 방금 한 질문
    ]
    const r = trimToBudget(turns, 40)
    expect(r.dropped).toBeGreaterThan(0)
    expect(r.kept[0]).toEqual(turns[0])
    expect(r.kept[r.kept.length - 1]).toEqual(turns[4])
  })

  it('★ 마지막 턴은 예산을 넘겨도 보낸다 — 안 보내면 요청이 성립하지 않는다', () => {
    const turns = [turn('user', '가'.repeat(10)), turn('user', '나'.repeat(5000))]
    const r = trimToBudget(turns, 50)
    expect(r.kept).toContain(turns[1])
  })

  it('최근 대화가 오래된 것보다 먼저 남는다', () => {
    const turns = [
      turn('user', '처음'),
      turn('assistant', '옛'.repeat(50)),
      turn('assistant', '최근'.repeat(2)),
      turn('user', '지금')
    ]
    const r = trimToBudget(turns, 30)
    expect(r.kept).toContain(turns[2])
    expect(r.kept).not.toContain(turns[1])
  })

  it('빈 대화는 그대로', () => {
    expect(trimToBudget([], 100)).toEqual({ kept: [], dropped: 0 })
  })

  it('예산 상수는 10만(준영님 결정) — 200K 한도를 다 쓰지 않는다', () => {
    expect(INPUT_BUDGET_TOKENS).toBe(100_000)
  })
})

// ── 요청 조립까지 붙여서 ──
const t = (role: 'user' | 'assistant', text: string, context?: string): AiTurn => ({
  id: `${role}-${text.slice(0, 4)}-${Math.abs(text.length)}`,
  at: 0,
  role,
  text,
  ...(context ? { context } : {})
})

describe('buildRequestCore — 첨부 출력은 마지막 질문에만', () => {
  it('★ 옛 턴의 터미널 출력은 다시 보내지 않는다', () => {
    const core = buildRequestCore(
      [t('user', '이 로그 봐줘', 'OLD_LOG_MARKER'), t('assistant', '네'), t('user', '그럼 이건?', 'NEW_LOG_MARKER')],
      'claude-sonnet-5'
    )
    const all = core.messages.map((m) => m.content).join('\n')
    expect(all).toContain('NEW_LOG_MARKER')
    // 예전에는 요청마다 옛 출력이 통째로 다시 갔다 — 컨텍스트의 대부분이 이것이었다.
    expect(all).not.toContain('OLD_LOG_MARKER')
    // 원본은 AiTurn.context 에 남아 있다(화면에서 "내가 뭘 보냈나"를 되짚는 용도).
  })

  it('짧은 대화는 아무것도 안 버린다', () => {
    const core = buildRequestCore([t('user', '안녕'), t('assistant', '네')], 'claude-sonnet-5')
    expect(core.droppedTurns).toBe(0)
    expect(core.messages).toHaveLength(2)
  })

  it('★ 예산을 넘기면 버린 수를 알려 준다 — 조용히 버리지 않는다', () => {
    // 한 턴 5만 자(한글) ≈ 5만 토큰 → 세 턴이면 예산(10만)을 넘는다.
    const big = '가'.repeat(50_000)
    const core = buildRequestCore(
      [t('user', big), t('assistant', big), t('user', big), t('user', '마지막')],
      'claude-sonnet-5'
    )
    expect(core.droppedTurns).toBeGreaterThan(0)
    expect(core.messages[core.messages.length - 1].content).toContain('마지막')
  })

  it('본문이 빈 assistant 턴(진행 중·취소)은 애초에 안 싣는다 — 기존 규칙 유지', () => {
    const core = buildRequestCore([t('user', '질문'), t('assistant', '')], 'claude-sonnet-5')
    expect(core.messages).toHaveLength(1)
  })
})
