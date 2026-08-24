// #125 대화 화면의 접기 규칙 — **화면의 성격이 여기서 정해진다**(준영님이 고른 B+C 혼합).
// 도구는 접힌 묶음 한 줄, 되묻기는 맨 아래 홀로, 글 조각은 한 말풍선.
import { describe, it, expect } from 'vitest'
import {
  dropAsk,
  openAsk,
  pickByKey,
  pushAsk,
  pushMine,
  reduceChat,
  remainText,
  type ChatItem
} from '../src/renderer/store/araChatItems'
import type { AiEngineEvent } from '../src/shared/aiEngine'

const run = (...events: AiEngineEvent[]): ChatItem[] => events.reduce(reduceChat, [] as ChatItem[])
const tool = (id: string, name: string, brief = ''): AiEngineEvent => ({ t: 'tool', id, name, brief })
const ask = (askId: string, options: string[] = []) => ({
  askId,
  question: '어느 서버?',
  options,
  multi: false,
  expiresAt: Date.now() + 60_000
})

describe('접기 규칙', () => {
  it('★ 잇따른 도구 호출은 한 묶음으로 접힌다', () => {
    const items = run(tool('1', 'session_list'), tool('2', 'disk.usage', 'dev-server'))
    expect(items).toHaveLength(1)
    expect(items[0].k).toBe('tools')
    expect((items[0] as { lines: unknown[] }).lines).toHaveLength(2)
  })

  it('★ 글이 오면 묶음이 닫힌다 — 다음 도구는 새 묶음이다', () => {
    const items = run(tool('1', 'a'), { t: 'text', text: '봤습니다.' }, tool('2', 'b'))
    expect(items.map((i) => i.k)).toEqual(['tools', 'ai', 'tools'])
  })

  it('★ 스트리밍 글 조각은 한 말풍선에 붙는다', () => {
    const items = run({ t: 'text', text: '/var 가 ' }, { t: 'text', text: '91% 입니다.' })
    expect(items).toHaveLength(1)
    expect((items[0] as { text: string }).text).toBe('/var 가 91% 입니다.')
  })

  it('도구 결과는 그 줄에 표시된다 — 묶음이 이미 닫혔어도 찾아 올라간다', () => {
    const items = run(
      tool('t1', 'Bash', 'npm test'),
      { t: 'text', text: '기다리는 중' },
      { t: 'toolResult', id: 't1', ok: false, brief: 'exit 1' }
    )
    const lines = (items[0] as { lines: { ok: boolean | null; brief: string }[] }).lines
    expect(lines[0].ok).toBe(false)
    expect(lines[0].brief).toBe('npm test') // 이미 있던 요약을 덮지 않는다
  })

  it('요약이 비어 있던 도구는 결과 요약을 받는다', () => {
    const items = run(tool('t1', 'mcp__ara__session_list'), { t: 'toolResult', id: 't1', ok: true, brief: '세션 2개' })
    expect((items[0] as { lines: { brief: string }[] }).lines[0].brief).toBe('세션 2개')
  })

  it('모르는 결과 id 는 조용히 흘린다(늦게 온 것)', () => {
    expect(run({ t: 'toolResult', id: '없음', ok: true, brief: '' })).toEqual([])
  })

  it('시작하면 어디서 도는지 한 줄로 알린다 — 아라가 어느 폴더에 있는지 모르면 안 된다', () => {
    const items = run({ t: 'ready', sessionId: 's', model: 'm', cwd: 'D:\\AI\\OFA', tools: ['a', 'b'] })
    expect(items[0]).toMatchObject({ k: 'note', tone: 'plain' })
    expect((items[0] as { text: string }).text).toContain('D:\\AI\\OFA')
    expect((items[0] as { text: string }).text).toContain('2개')
  })

  it('오류는 눈에 띄는 줄로, 턴·종료는 목록에 쌓지 않는다(상태줄이 말한다)', () => {
    expect(run({ t: 'error', message: 'claude 없음' })[0]).toMatchObject({ tone: 'bad' })
    expect(run({ t: 'turn', costUsd: 1, ms: 2, turns: 1, text: '' })).toEqual([])
    expect(run({ t: 'exit', code: 0 })).toEqual([])
  })

  it('원본 배열을 건드리지 않는다 — React 가 바뀐 걸 알아야 한다', () => {
    const before: ChatItem[] = []
    const after = reduceChat(before, { t: 'text', text: 'x' })
    expect(before).toEqual([])
    expect(after).not.toBe(before)
  })
})

describe('되묻기 카드', () => {
  it('★ 항상 맨 아래 홀로 — 답할 것이 중간에 묻히면 안 된다', () => {
    let items = pushMine([], '테스트 돌려 줘')
    items = pushAsk(items, ask('a1', ['dev', 'prod']))
    items = reduceChat(items, { t: 'text', text: '확인했습니다.' })
    // 글이 뒤에 왔어도 되묻기를 다시 밀어 올린다(같은 id 는 갱신).
    items = pushAsk(items, ask('a1', ['dev', 'prod', '둘 다']))
    expect(items.filter((i) => i.k === 'ask')).toHaveLength(1)
    expect(items[items.length - 1].k).toBe('ask')
    expect(openAsk(items)?.options).toEqual(['dev', 'prod', '둘 다'])
  })

  it('답하거나 시간이 지나면 카드가 사라진다', () => {
    const items = pushAsk([], ask('a1'))
    expect(openAsk(dropAsk(items, 'a1'))).toBeNull()
  })

  it('★ 숫자 키로 고른다 · 없는 자리는 아무 일도 없다', () => {
    const opts = ['30일 넘은 것만', '압축만', '아무것도']
    expect(pickByKey('1', opts)).toBe('30일 넘은 것만')
    expect(pickByKey('3', opts)).toBe('아무것도')
    expect(pickByKey('4', opts)).toBeNull()
    expect(pickByKey('0', opts)).toBeNull()
    expect(pickByKey('a', opts)).toBeNull()
  })

  it('남은 시간을 분:초로 — 지났으면 빈 문자열', () => {
    const now = 1_000_000
    expect(remainText(now + 281_000, now)).toBe('4:41 남음')
    expect(remainText(now + 5_000, now)).toBe('0:05 남음')
    expect(remainText(now - 1, now)).toBe('')
  })
})
