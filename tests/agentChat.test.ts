// M5 AI-13·17 — transcript 줄 해석·메시지 모델·꼬리 읽기(main 감시, 임시 폴더 — 사용자 ~/.claude 안 읽음)·초안.
// 픽스처는 Orca native-chat 디코더 시험의 Claude 레코드 모양을 줄였다(orcaRef fdfcfb3551). 개인정보 꼴 없는 글만.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { composeChatText, createChatModel, decodeClaudeLine, decodeCodexLine, decodeGeminiLine, DECODERS, draftOf, geminiDocLines, mergeMessages, takeLines, transcriptHint, type AgentChatEvent, type ChatMessage } from '@shared/agentChat'
import { claudeProjectsDirs, codexSessionsDirs, createChatWatcher, findCodexRollout, INITIAL_TAIL_BYTES, resolveClaudeTranscript, resolveGeminiTranscript } from '../src/main/agents/chat'

const J = (o: unknown): string => JSON.stringify(o)
const user = (uuid: string, content: unknown, extra: object = {}): string => J({ type: 'user', uuid, message: { role: 'user', content }, ...extra })
const asst = (uuid: string, mid: string, content: unknown[]): string => J({ type: 'assistant', uuid, message: { id: mid, role: 'assistant', content } })

const convo = [
  J({ type: 'summary', summary: 'x' }),
  user('u0', '<command-name>/clear</command-name>', { isMeta: true }),
  user('u1', '목록 정렬을 고쳐 줘'),
  asst('a1', 'm1', [{ type: 'thinking', thinking: '생각' }]),
  asst('a2', 'm1', [{ type: 'text', text: '**보겠습니다**' }]),
  asst('a3', 'm1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test -- --run' } }]),
  user('u2', [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '3 passed' }] }]),
  asst('a4', 'm2', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: '어느 쪽으로 정렬할까요?' }] } }]),
  user('u3', [{ type: 'text', text: '[Request interrupted by user]' }]),
  '{"broken',
  asst('a5', 'm3', [{ type: 'text', text: '고쳤습니다' }])
]

describe('줄 해석(decodeClaudeLine)', () => {
  it('대화 줄만 · 주입·isMeta 사용자 글은 버리고 tool_result 는 살린다', () => {
    expect(decodeClaudeLine(convo[0], 'f')).toBeNull()
    expect(decodeClaudeLine(convo[1], 'f')).toBeNull()
    expect(decodeClaudeLine(user('x', '<system-reminder>hi</system-reminder>'), 'f')).toBeNull()
    const meta = decodeClaudeLine(user('m', [{ type: 'tool_result', tool_use_id: 't9', content: 'ok', is_error: true }], { isMeta: true }), 'f')
    expect(meta?.blocks).toEqual([])
    expect(meta?.results).toEqual([{ id: 't9', text: 'ok', error: true }])
    expect(decodeClaudeLine(convo[3], 'f')).toBeNull() // thinking 만 — 1차는 뺀다
    expect(decodeClaudeLine('{"broken', 'f')).toBeNull()
  })
  it('끊김 문구는 시스템 줄, 이미지는 칩, 긴 결과는 자른다', () => {
    expect(decodeClaudeLine(convo[8], 'f')?.role).toBe('system')
    expect(decodeClaudeLine(user('i', [{ type: 'image', source: {} }, { type: 'text', text: '이거 봐' }]), 'f')?.blocks).toEqual([{ type: 'image' }, { type: 'text', text: '이거 봐' }])
    const big = decodeClaudeLine(user('r', [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(10_000) }]), 'f')
    expect(big!.results[0].text.length).toBeLessThan(4100)
  })
})

describe('메시지 모델', () => {
  it('한 응답(message.id)은 한 말풍선 · 도구 결과는 그 블록에 · 질문 카드', () => {
    const m = createChatModel()
    m.add(convo)
    const list = m.messages()
    expect(list.map((x) => x.role)).toEqual(['user', 'assistant', 'assistant', 'system', 'assistant'])
    expect(list[1].blocks).toEqual([
      { type: 'text', text: '**보겠습니다**' },
      { type: 'tool', id: 't1', name: 'Bash', summary: 'npm test -- --run', result: '3 passed', error: false }
    ])
    expect(list[2].blocks[0]).toEqual({ type: 'question', id: 'q1', questions: ['어느 쪽으로 정렬할까요?'], answered: false })
  })
  it('나눠 넣어도 결과가 같고, 바뀐 메시지만 돌려준다(결과가 앞 메시지를 바꾼다)', () => {
    const m = createChatModel()
    m.add(convo.slice(0, 6))
    const changed = m.add(convo.slice(6, 7))
    expect(changed.map((x) => x.id)).toEqual(['a2'])
    expect(changed[0].blocks[1]).toMatchObject({ result: '3 passed' })
    m.add(convo.slice(7))
    expect(m.add([convo[4], convo[5]])).toEqual([]) // 묶인 줄을 다시 읽어도 블록이 두 번 붙지 않는다
    const whole = createChatModel()
    whole.add(convo)
    expect(m.messages()).toEqual(whole.messages())
  })
  it('같은 줄을 다시 읽어도 겹치지 않는다 · 상한을 넘으면 오래된 것부터', () => {
    const m = createChatModel(3)
    m.add(convo)
    m.add([convo[10]])
    expect(m.messages()[2].blocks).toHaveLength(1)
    expect(m.messages().map((x) => x.id)).toEqual(['a4', 'u3', 'a5'])
    const fresh = m.add([user('u9', '다음'), asst('a9', 'm9', [{ type: 'text', text: '네' }])])
    expect(fresh.map((x) => x.id)).toEqual(['u9', 'a9'])
    expect(m.messages().map((x) => x.id)).toEqual(['a5', 'u9', 'a9'])
  })
  it('렌더러 합치기 — 같은 id 는 그 자리, 새 것은 뒤, reset 은 비우고 시작', () => {
    const a: ChatMessage = { id: 'a', role: 'user', blocks: [] }
    const b: ChatMessage = { id: 'b', role: 'assistant', blocks: [] }
    const b2: ChatMessage = { ...b, blocks: [{ type: 'text', text: 'x' }] }
    expect(mergeMessages([a, b], [b2, { id: 'c', role: 'user', blocks: [] }]).map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(mergeMessages([a, b], [b2])[1]).toBe(b2)
    expect(mergeMessages([a, b], [b2], true)).toEqual([b2])
  })
})

describe('줄 자르기·입력 글·초안', () => {
  it('덜 쓴 마지막 줄은 carry 로 미룬다(CRLF·빈 줄 포함)', () => {
    const r1 = takeLines('', 'a\r\n\nb\n{"par')
    expect(r1).toEqual({ lines: ['a', 'b'], carry: '{"par' })
    expect(takeLines(r1.carry, 'tial":1}\n')).toEqual({ lines: ['{"partial":1}'], carry: '' })
  })
  it('첨부는 경로만, 공백 든 경로는 큰따옴표 · 따옴표·줄바꿈 글은 그대로', () => {
    expect(composeChatText('hello "따옴표" & 100%\n둘째 줄  ', ['C:\\a b\\x.png', '/tmp/y.txt'])).toBe('hello "따옴표" & 100%\n둘째 줄\n"C:\\a b\\x.png"\n/tmp/y.txt')
    expect(composeChatText('', [])).toBe('')
  })
  it('초안 읽기 — 깨진 값은 빈 초안', () => {
    expect(draftOf({ text: 'x', files: ['a', 3, ''] })).toEqual({ text: 'x', files: ['a'] })
    expect(draftOf('nope')).toEqual({ text: '', files: [] })
  })
  it('훅 힌트 — .jsonl 경로만, 위험한 세션 id 는 거절', () => {
    expect(transcriptHint({ transcript_path: '/h/.claude/projects/p/s.jsonl', session_id: 's-1' })).toEqual({ path: '/h/.claude/projects/p/s.jsonl', sessionId: 's-1' })
    expect(transcriptHint({ transcript_path: '/etc/passwd', session_id: '../x' })).toEqual({ path: null, sessionId: null })
  })
})

describe('chatDraft(localStorage)', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('탭별로 남고 비우면 지운다', async () => {
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) })
    const { readDraft, writeDraft, clearDraft } = await import('../src/renderer/features/aiws/chatDraft')
    writeDraft('s1', { text: '쓰던 글', files: ['C:\\x.png'] })
    expect(readDraft('s1')).toEqual({ text: '쓰던 글', files: ['C:\\x.png'] })
    expect(readDraft('s2')).toEqual({ text: '', files: [] })
    clearDraft('s1')
    expect(mem.size).toBe(0)
  })
})

describe('main 꼬리 읽기(createChatWatcher)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ara-chat-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('세션 id → projects/*/<id>.jsonl (CLAUDE_CONFIG_DIR 먼저)', () => {
    const home = join(root, 'home')
    const cfg = join(root, 'cfg')
    mkdirSync(join(home, '.claude', 'projects', 'D--w-app'), { recursive: true })
    writeFileSync(join(home, '.claude', 'projects', 'D--w-app', 'sid-1.jsonl'), '')
    expect(claudeProjectsDirs(home, { CLAUDE_CONFIG_DIR: cfg })).toEqual([join(cfg, 'projects'), join(home, '.claude', 'projects')])
    expect(resolveClaudeTranscript('sid-1', claudeProjectsDirs(home, {}))).toBe(join(home, '.claude', 'projects', 'D--w-app', 'sid-1.jsonl'))
    expect(resolveClaudeTranscript('nope', claudeProjectsDirs(home, {}))).toBeNull()
  })

  it('훅 경로 → 열면 스냅숏 · 이어 쓰면 바뀐 것만 push · 경로 기억(다시 켜도) · 잘리면 reset · 닫으면 안 읽음', async () => {
    const dir = join(root, 'w1')
    mkdirSync(dir)
    const file = join(dir, 's.jsonl')
    const store = join(dir, 'agent-chat.json')
    const events: AgentChatEvent[] = []
    const w = createChatWatcher({ push: (e) => events.push(e), store, home: dir, throttleMs: 20 })
    // 파일이 아직 없을 때 열어도 된다(경로 모름).
    expect(w.open('p1')).toEqual({ messages: [], file: null })
    w.hook('p1', { hook_event_name: 'UserPromptSubmit', transcript_path: file, session_id: 's' })
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ p1: file })
    writeFileSync(file, convo.slice(0, 5).join('\n') + '\n')
    await vi.waitFor(() => expect(events.flatMap((e) => e.messages).map((m) => m.id)).toContain('a2'), { timeout: 3000 })
    events.length = 0
    // 덜 쓴 줄은 기다린다.
    const rest = convo.slice(5).join('\n') + '\n'
    appendFileSync(file, rest.slice(0, 30))
    await wait(150)
    appendFileSync(file, rest.slice(30))
    await vi.waitFor(() => expect(events.flatMap((e) => e.messages).map((m) => m.id)).toContain('a5'), { timeout: 3000 })
    expect(events.some((e) => e.reset)).toBe(false)
    // 다시 켠 앱(새 감시자)은 기억한 경로로 바로 연다.
    const w2 = createChatWatcher({ push: () => {}, store, home: dir, throttleMs: 20 })
    const snap = w2.open('p1')
    expect(snap.file).toBe(file)
    expect(snap.messages.map((m) => m.id)).toEqual(['u1', 'a2', 'a4', 'u3', 'a5'])
    w2.stop()
    // 잘림 → reset 과 함께 처음부터.
    events.length = 0
    writeFileSync(file, user('n1', '새로') + '\n')
    await vi.waitFor(() => expect(events.find((e) => e.reset)?.messages.map((m) => m.id)).toEqual(['n1']), { timeout: 3000 })
    // 닫으면 더 안 민다.
    w.close('p1')
    events.length = 0
    appendFileSync(file, user('n2', '닫힘') + '\n')
    await wait(300)
    expect(events).toEqual([])
    // 탭이 끝나면 기억도 지운다.
    w.forget('p1')
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({})
    w.stop()
  })

  it('/clear 뒤 새 파일 — 열린 화면은 reset 으로 새 파일의 메시지를 받는다', async () => {
    const dir = join(root, 'w2')
    mkdirSync(dir)
    const a = join(dir, 'a.jsonl')
    const b = join(dir, 'b.jsonl')
    writeFileSync(a, convo.join('\n') + '\n')
    writeFileSync(b, user('b1', '두 번째 세션') + '\n')
    const events: AgentChatEvent[] = []
    const w = createChatWatcher({ push: (e) => events.push(e), store: join(dir, 's.json'), home: dir, throttleMs: 20 })
    w.hook('p', { transcript_path: a })
    expect(w.open('p').messages).toHaveLength(5)
    w.hook('p', { transcript_path: b })
    expect(events).toEqual([{ sessionId: 'p', messages: [expect.objectContaining({ id: 'b1' })], reset: true }])
    w.stop()
  })

  it('큰 파일은 끝 2MB 만 — 잘린 첫 줄은 버린다', () => {
    const dir = join(root, 'w3')
    mkdirSync(dir)
    const f = join(dir, 'big.jsonl')
    const filler = user('old', 'x'.repeat(1000)).replace('"old"', '"OLD"')
    const n = Math.ceil(INITIAL_TAIL_BYTES / filler.length) + 50
    writeFileSync(f, Array.from({ length: n }, (_, i) => filler.replace('"OLD"', `"o${i}"`)).join('\n') + '\n' + user('last', '끝') + '\n')
    const w = createChatWatcher({ push: () => {}, store: join(dir, 's.json'), home: dir })
    w.hook('p', { transcript_path: f })
    const msgs = w.open('p').messages
    expect(msgs[msgs.length - 1].id).toBe('last')
    expect(msgs.length).toBeLessThan(n)
    expect(msgs.length).toBeGreaterThan(1000)
    expect(msgs.some((m) => m.id === 'o0')).toBe(false)
    w.stop()
  })
})

// R2 Codex·Gemini — 픽스처는 Orca 디코더 시험(transcript-line-decoders-codex)·ai-vault gemini 파서의 레코드 모양을 줄였다.
describe('Codex·Gemini 해석', () => {
  const ri = (payload: object): string => J({ type: 'response_item', timestamp: '2026-11-01T00:00:00Z', payload })
  const codex = [
    J({ type: 'session_meta', payload: { id: 'cx', cwd: 'C:\\w\\app', timestamp: '2026-11-01T00:00:00Z' } }),
    ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>C:\\w</cwd>\n</environment_context>' }] }),
    ri({ type: 'message', role: 'user', id: 'cu1', content: [{ type: 'input_text', text: '테스트 돌려 줘' }] }),
    J({ type: 'event_msg', payload: { type: 'user_message', message: '테스트 돌려 줘' } }), // 같은 말 — 겹치지 않게 버린다
    ri({ type: 'function_call', id: 'fc1', name: 'shell', call_id: 'call_1', arguments: J({ command: ['bash', '-lc', 'npm test'] }) }),
    ri({ type: 'function_call_output', call_id: 'call_1', output: J({ output: '3 passed', metadata: { exit_code: 0 } }) }),
    ri({ type: 'message', role: 'assistant', id: 'ca1', content: [{ type: 'output_text', text: '다 통과했습니다' }] }),
    J({ type: 'event_msg', payload: { type: 'turn_aborted' } })
  ]
  it('Codex: 주입 맥락·event_msg 겹침은 버리고 도구 호출에 결과가 붙는다', () => {
    const m = createChatModel(undefined, DECODERS.codex)
    m.add(codex)
    const list = m.messages()
    expect(list.map((x) => x.role)).toEqual(['user', 'assistant', 'assistant', 'system'])
    expect(list[0].blocks).toEqual([{ type: 'text', text: '테스트 돌려 줘' }])
    expect(list[1].blocks[0]).toEqual({ type: 'tool', id: 'call_1', name: 'shell', summary: 'bash -lc npm test', result: '3 passed', error: false })
    expect(decodeCodexLine(codex[0], 'f')).toBeNull()
  })
  it('Gemini: user/gemini · toolCalls 는 도구 블록 · .json 문서는 messages 를 줄로', () => {
    const doc = J({
      sessionId: 'g-1',
      messages: [
        { id: 'g1', type: 'user', content: '파일 목록 보여 줘' },
        { id: 'g2', type: 'gemini', content: '보겠습니다', toolCalls: [{ id: 'tc1', name: 'list_directory', args: { path: '.' }, resultDisplay: 'a.txt', status: 'success' }] },
        { id: 'g3', type: 'info', content: 'x' }
      ]
    })
    const lines = geminiDocLines(doc)!
    const m = createChatModel(undefined, DECODERS.gemini)
    m.add(lines)
    expect(m.messages().map((x) => x.role)).toEqual(['user', 'assistant'])
    expect(m.messages()[1].blocks[1]).toEqual({ type: 'tool', id: 'tc1', name: 'list_directory', summary: '.', result: 'a.txt', error: false })
    expect(geminiDocLines('{"messages":[')).toBeNull() // 쓰는 중
    expect(decodeGeminiLine(J({ $set: { lastUpdated: 'x' } }), 'f')).toBeNull()
  })
  it('훅 힌트 — Gemini 옛 .json 경로도 받는다', () => {
    expect(transcriptHint({ transcript_path: '/h/.gemini/tmp/p/chats/session-1-abcd1234.json' }).path).toBe('/h/.gemini/tmp/p/chats/session-1-abcd1234.json')
  })
})

describe('Codex·Gemini 파일 찾기(임시 폴더)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ara-chat2-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const pad = (n: number): string => String(n).padStart(2, '0')

  it('Codex: 그 폴더(session_meta.cwd)·띄운 뒤에 시작한 rollout 중 가장 이른 것, 다른 탭 것은 뺀다', () => {
    const now = Date.now()
    const d = new Date(now)
    const day = join(root, 'codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
    mkdirSync(day, { recursive: true })
    const roll = (name: string, cwd: string, at: number): string => {
      const p = join(day, `rollout-${name}.jsonl`)
      writeFileSync(p, J({ type: 'session_meta', payload: { cwd, timestamp: new Date(at).toISOString() } }) + '\n')
      return p
    }
    const cwd = join(root, 'app')
    roll('old', cwd, now - 60_000) // 띄우기 전 — 아님
    roll('other', join(root, 'other'), now + 1000) // 다른 폴더 — 아님
    const a = roll('a', cwd, now + 1000)
    const b = roll('b', cwd, now + 2000)
    const roots = codexSessionsDirs(join(root, 'nohome'), { CODEX_HOME: join(root, 'codex') })
    expect(findCodexRollout(roots, cwd, now, new Set(), now)).toBe(a)
    expect(findCodexRollout(roots, cwd, now, new Set([a]), now)).toBe(b)
    expect(findCodexRollout(roots, join(root, 'none'), now, new Set(), now)).toBeNull()
  })

  it('Codex 탭은 훅 없이 rollout 을 찾아 채팅에 민다', async () => {
    const home = join(root, 'h2')
    const cwd = join(root, 'app2')
    const d = new Date()
    const day = join(home, '.codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
    const events: AgentChatEvent[] = []
    const w = createChatWatcher({ push: (e) => events.push(e), store: join(root, 's2.json'), home, env: {}, throttleMs: 20 })
    w.bind('cx', { agent: 'codex', cwd, startedAt: Date.now() })
    expect(w.open('cx')).toEqual({ messages: [], file: null }) // 아직 파일 없음 — 1초마다 다시
    mkdirSync(day, { recursive: true })
    const meta = J({ type: 'session_meta', payload: { cwd, timestamp: new Date().toISOString() } })
    const said = J({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'q', content: [{ type: 'input_text', text: '안녕' }] } })
    writeFileSync(join(day, 'rollout-x.jsonl'), meta + '\n' + said + '\n')
    await new Promise((r) => setTimeout(r, 1500))
    expect(events.flatMap((e) => e.messages.map((m) => m.id))).toContain('q')
    w.stop()
  })

  it('Gemini: 훅 session_id → tmp/*/chats/session-…-<앞 8자>.json, 바뀌면 통째로 다시(reset)', async () => {
    const home = join(root, 'h3')
    const chats = join(home, '.gemini', 'tmp', 'hash1', 'chats')
    mkdirSync(chats, { recursive: true })
    const f = join(chats, 'session-2026-11-01T00-00-abcd1234.json')
    const doc = (n: number): string => J({ sessionId: 'abcd1234-ffff', messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, type: i % 2 ? 'gemini' : 'user', content: `글 ${i}` })) })
    writeFileSync(f, doc(1))
    expect(resolveGeminiTranscript('abcd1234-ffff', home)).toBe(f)
    const events: AgentChatEvent[] = []
    const w = createChatWatcher({ push: (e) => events.push(e), store: join(root, 's3.json'), home, throttleMs: 20 })
    w.bind('g', { agent: 'gemini', cwd: root, startedAt: 0 })
    w.hook('g', { session_id: 'abcd1234-ffff' }, 'gemini')
    expect(w.open('g').messages.map((m) => m.id)).toEqual(['m0'])
    writeFileSync(f, doc(3))
    await new Promise((r) => setTimeout(r, 400))
    expect(events.at(-1)).toMatchObject({ sessionId: 'g', reset: true })
    expect(events.at(-1)!.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2'])
    w.stop()
  })
})
