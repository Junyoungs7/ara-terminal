// 아라 채팅 v3(2026-10-20, B안) — 맥락 파싱(#21), 상태줄 문구(#21·#25), 선택지 표식(#23), 저장 한도(#24-1), 새 세션 규칙(#24-2).
import { describe, it, expect } from 'vitest'
import { araLimitsOf, parseStreamJson } from '../src/shared/aiEngine'
import { reduceChat, riskyChoice, splitChoices } from '../src/renderer/store/araChatItems'
import { statusSegs, untilText, usageTitle } from '../src/renderer/store/araUsage'
import { buildPersona } from '../src/shared/araPersona'

describe('stream-json — 맥락', () => {
  it('assistant 의 usage 세 값(input·cache_read·cache_creation) 합을 맥락 사용량으로', () => {
    const line = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: '안녕하세요' }],
        usage: { input_tokens: 3, cache_read_input_tokens: 500000, cache_creation_input_tokens: 29997, output_tokens: 9 }
      }
    })
    expect(parseStreamJson(line)).toEqual([
      { t: 'text', text: '안녕하세요' },
      { t: 'context', used: 530000 }
    ])
  })
  it('하위 에이전트의 말(parent_tool_use_id 있음)·usage 없는 말은 맥락을 안 낸다', () => {
    const sub = { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [], usage: { input_tokens: 9 } } }
    expect(parseStreamJson(JSON.stringify(sub))).toEqual([])
    expect(parseStreamJson(JSON.stringify({ type: 'assistant', message: { content: [] } }))).toEqual([])
  })
  it('result.modelUsage 의 contextWindow — 여럿이면 최댓값, 없으면 사건 없음', () => {
    const base = { type: 'result', total_cost_usd: 0.1, duration_ms: 1, num_turns: 1, result: 'ok' }
    const evs = parseStreamJson(
      JSON.stringify({ ...base, modelUsage: { 'claude-haiku': { contextWindow: 200000 }, 'claude-opus': { contextWindow: 1000000 } } })
    )
    expect(evs[0]).toMatchObject({ t: 'turn' })
    expect(evs[1]).toEqual({ t: 'context', window: 1000000 })
    expect(parseStreamJson(JSON.stringify(base))).toHaveLength(1)
  })
  it('맥락 사건은 대화 목록에 줄을 쌓지 않는다', () => {
    expect(reduceChat([], { t: 'context', used: 1 })).toEqual([])
  })
})

describe('상태줄 문구', () => {
  const now = 1_000_000_000_000
  const limits = { five: { pct: 42, resetsAt: now + 130 * 60_000 }, week: { pct: 17, resetsAt: now + (6 * 24 + 1) * 3_600_000 } }
  it('한 줄 칸 — 5H · 주간 · 맥락, 남은 시간은 짧은 꼴', () => {
    const s = statusSegs('cli', limits, { input: 40000, output: 2100, costUsd: 0.4211 }, { used: 530000, window: 1000000 }, now)
    expect(s).toEqual([
      { key: 'five', label: '5H', pct: 42, note: '2h10m' },
      { key: 'week', label: '주간', pct: 17, note: '6d1h' },
      { key: 'ctx', label: '맥락', pct: 53, note: '' }
    ])
  })
  it('짧은 시간 꼴 — 분만 · 시간+분 · 일+시간, 지났으면 빈 글', () => {
    expect(untilText(now + 45 * 60_000, now)).toBe('45m')
    expect(untilText(now + 158 * 60_000, now)).toBe('2h38m')
    expect(untilText(now + (5 * 24 + 4) * 3_600_000, now)).toBe('5d4h')
    expect(untilText(now - 1, now)).toBe('')
  })
  it('이번 대화 토큰·비용은 칸이 아니라 툴팁 글', () => {
    expect(usageTitle({ input: 40000, output: 2100, costUsd: 0.4211 })).toBe('이번 대화 42.1k 토큰 · $0.42')
    expect(usageTitle({ input: 980, output: 0, costUsd: null })).toBe('이번 대화 980 토큰')
    expect(usageTitle(null)).toBe('')
  })
  it('resetsAt 이 지난 창은 0% · 괄호 없음(초기화됨)', () => {
    const old = { five: { pct: 80, resetsAt: now - 1 }, week: { pct: 30, resetsAt: now + 60_000 } }
    expect(statusSegs('cli', old, null, null, now)).toEqual([
      { key: 'five', label: '5H', pct: 0, note: '' },
      { key: 'week', label: '주간', pct: 30, note: '1m' }
    ])
  })
  it('맥락 값이 하나라도 없으면 칸을 숨긴다', () => {
    expect(statusSegs('cli', limits, null, { used: 5, window: null }, now).map((g) => g.key)).toEqual(['five', 'week'])
    expect(statusSegs('cli', limits, null, null, now).map((g) => g.key)).toEqual(['five', 'week'])
  })
  it('한도가 없으면 기존 대체 글(usageLine) 한 칸', () => {
    expect(statusSegs('cli', null, null, null, now)).toEqual([{ key: 'text', label: '', pct: null, note: '—' }])
    const s = statusSegs('cli', null, { input: 30000, output: 8200, costUsd: 0.4123 }, null, now)
    expect(s[0].note).toBe('한도 확인 불가 · 이번 대화 38.2k 토큰 · 약 $0.41 (추정)')
  })
  it('API 모드는 한도가 와 있어도 토큰 줄', () => {
    const s = statusSegs('api', limits, { input: 10100, output: 2300, costUsd: null }, null, now)
    expect(s).toEqual([{ key: 'text', label: '', pct: null, note: '이번 대화 12.4k 토큰 (입력 10.1k · 출력 2.3k)' }])
  })
})

describe('저장한 한도(ui.araLimits) 검사', () => {
  it('정상 값은 그대로, 한쪽만 깨졌으면 그쪽만 null', () => {
    const ok = { five: { pct: 25, resetsAt: 1700000000000 }, week: { pct: 22, resetsAt: null } }
    expect(araLimitsOf(ok)).toEqual(ok)
    expect(araLimitsOf({ five: { pct: 'x', resetsAt: 1 }, week: { pct: 22, resetsAt: null } })).toEqual({ five: null, week: { pct: 22, resetsAt: null } })
  })
  it('깨진 값은 무시(null)', () => {
    for (const bad of [undefined, null, 'x', 1, {}, { five: null, week: null }, { five: { pct: 120, resetsAt: 1 } }, { five: { pct: 5, resetsAt: 'soon' } }, { week: { pct: 5 } }]) {
      expect(araLimitsOf(bad)).toBeNull()
    }
  })
})

describe('선택지 표식', () => {
  it('끝 줄의 [[선택: …]] 를 걷고 선택지를 낸다', () => {
    const r = splitChoices('214개 파일을 영구 삭제합니다. 진행할까요?\n\n[[선택: 삭제 진행 | 휴지통으로 이동 | 취소]]')
    expect(r).toEqual({ body: '214개 파일을 영구 삭제합니다. 진행할까요?', choices: ['삭제 진행', '휴지통으로 이동', '취소'] })
    expect(splitChoices('[[선택: 예 | 아니오]]\n')).toEqual({ body: '', choices: ['예', '아니오'] })
  })
  it('깨진 표식은 그냥 글이다 — 닫힘 없음 · 하나뿐 · 다섯 개 · 20자 초과 · 빈 칸', () => {
    for (const bad of [
      '진행할까요?\n[[선택: 예 | 아니오',
      '진행할까요?\n[[선택: 예]]',
      '진행할까요?\n[[선택: 1 | 2 | 3 | 4 | 5]]',
      '진행할까요?\n[[선택: 예 | ' + '가'.repeat(21) + ']]',
      '진행할까요?\n[[선택: 예 |  | 아니오]]'
    ]) {
      expect(splitChoices(bad)).toEqual({ body: bad, choices: null })
    }
  })
  it('끝 줄이 아니면 표식이 아니다', () => {
    const t = '[[선택: 예 | 아니오]]\n그다음 설명이 이어집니다.'
    expect(splitChoices(t)).toEqual({ body: t, choices: null })
    // 줄 중간에 붙은 것도 아니다.
    const mid = '진행할까요? [[선택: 예 | 아니오]]'
    expect(splitChoices(mid)).toEqual({ body: mid, choices: null })
  })
  it('위험해 보이는 선택만 경고색', () => {
    expect(riskyChoice('삭제 진행')).toBe(true)
    expect(riskyChoice('DROP TABLE')).toBe(true)
    expect(riskyChoice('rm -rf 로 지움')).toBe(true)
    expect(riskyChoice('휴지통으로 이동')).toBe(false)
    expect(riskyChoice('취소')).toBe(false)
    expect(riskyChoice('confirm')).toBe(false)
  })
  it('페르소나가 표식 형식을 시킨다(두 엔진 모두)', () => {
    expect(buildPersona('준영')).toContain('[[선택: 삭제 진행 | 취소]]')
    expect(buildPersona('준영', [], false)).toContain('[[선택: 삭제 진행 | 취소]]')
  })
  it('페르소나 — 요청 없이 새 세션을 만들지 않고, 맞지 않으면 선택지로 묻는다(#24-2)', () => {
    const p = buildPersona('준영')
    expect(p).toContain('새 탭·새 세션을 명시적으로 요청하지 않는 한 session_create 로 새 세션을 만들지 않습니다')
    expect(p).toContain('[[선택: 여기서 실행 | 새 탭에서 실행 | 취소]]')
  })
})
