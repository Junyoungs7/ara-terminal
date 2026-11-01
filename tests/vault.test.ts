// M4 AI-07 지난 에이전트 세션 — jsonl 파서(claude·codex·gemini)·머리/꼬리·정렬·재개 명령, main 스캔(가짜 홈 — 사용자 ~/.claude 안 읽음).
// 픽스처는 Orca src/main/ai-vault 시험의 레코드 모양을 줄였다(orcaRef fdfcfb3551). 개인정보 꼴 없는 글만.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (e: unknown, req: unknown) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (c: string, fn: (e: unknown, req: unknown) => unknown) => handlers.set(c, fn) }, app: { getPath: () => tmpdir() } }))
vi.mock('../src/main/sessions/PtyBackend', () => ({ defaultLaunchShell: () => 'posix' }))

import { defaultAgentSettings, planAgentLaunch, resumeArgs } from '@shared/agents'
import { headTailLines, parseGeminiDocument, parseSessionLines, pathKey, resumeCommandText, sortSessions, type VaultSession } from '@shared/vault'
import { registerVaultFeature } from '../src/main/vault/feature'

const J = (o: unknown): string => JSON.stringify(o)
const ID = '11111111-2222-4333-8444-555555555555'

const claudeLines = [
  J({ type: 'user', isMeta: true, sessionId: ID, cwd: '/w/app', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
  J({ type: 'user', sessionId: ID, cwd: '/w/app', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } }),
  J({ type: 'user', sessionId: ID, cwd: '/w/app', message: { role: 'user', content: [{ type: 'text', text: '목록 정렬을 고쳐 줘' }] } }),
  J({ type: 'assistant', sessionId: ID, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Grep' }, { type: 'text', text: '보겠습니다' }] } }),
  J({ type: 'user', sessionId: ID, cwd: '/w/other', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }),
  J({ type: 'ai-title', aiTitle: '정렬 수정' }),
  '{"broken',
  J({ type: 'assistant', sessionId: ID, message: { content: [{ type: 'text', text: '고쳤습니다' }] } })
]

describe('parseSessionLines', () => {
  it('claude: 첫 진짜 지시(하네스 주입·isMeta·tool_result 제외), 첫 cwd, ai-title, 깨진 줄 건너뜀, 최근 턴', () => {
    const p = parseSessionLines('claude', claudeLines, 8)
    expect(p).toMatchObject({ id: ID, cwd: '/w/app', title: '정렬 수정', firstPrompt: '목록 정렬을 고쳐 줘' })
    expect(p.turns).toEqual([
      { role: 'user', text: '목록 정렬을 고쳐 줘' },
      { role: 'assistant', text: '보겠습니다' },
      { role: 'assistant', text: '고쳤습니다' }
    ])
    expect(parseSessionLines('claude', claudeLines, 1).turns).toEqual([{ role: 'assistant', text: '고쳤습니다' }])
  })

  it('claude: custom-title 이 ai-title 을 이긴다', () => {
    const p = parseSessionLines('claude', [...claudeLines, J({ type: 'custom-title', customTitle: '내 제목' })])
    expect(p.title).toBe('내 제목')
  })

  it('codex: 첫 session_meta 가 id·cwd(갈래의 두 번째 메타 무시), event_msg 사용자·에이전트 글', () => {
    const p = parseSessionLines('codex', [
      J({ type: 'session_meta', payload: { id: 'cx-1', cwd: '/w/api' } }),
      J({ type: 'session_meta', payload: { id: 'parent', cwd: '/w/else' } }),
      J({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>' }] } }),
      J({ type: 'event_msg', payload: { type: 'user_message', message: '테스트 돌려 줘' } }),
      J({ type: 'event_msg', payload: { type: 'agent_message', message: '통과' } })
    ])
    expect(p).toMatchObject({ id: 'cx-1', cwd: '/w/api', firstPrompt: '테스트 돌려 줘' })
    expect(p.turns.map((x) => x.role)).toEqual(['user', 'assistant'])
  })

  it('gemini: jsonl 레코드와 옛 json 문서', () => {
    const lines = [J({ sessionId: 'gm-1', startTime: 't' }), J({ type: 'user', content: [{ text: '설명해 줘' }] }), J({ type: 'gemini', content: '네' })]
    expect(parseSessionLines('gemini', lines)).toMatchObject({ id: 'gm-1', cwd: null, firstPrompt: '설명해 줘' })
    const doc = parseGeminiDocument(J({ sessionId: 'gm-2', messages: [{ type: 'user', content: '안녕' }, { type: 'gemini', content: '반가워요' }] }))
    expect(doc).toMatchObject({ id: 'gm-2', firstPrompt: '안녕' })
    expect(doc.turns).toHaveLength(2)
    expect(parseGeminiDocument('{not json').id).toBeNull()
  })

  it('셸에 못 넣을 id 는 버린다(파일 내용은 신뢰 경계 밖)', () => {
    expect(parseSessionLines('claude', [J({ type: 'user', sessionId: 'x; rm -rf ~', message: { content: 'a' } })]).id).toBeNull()
  })
})

describe('headTailLines', () => {
  it('꼬리가 없으면 머리 전부, 있으면 경계에서 잘린 줄을 버린다', () => {
    expect(headTailLines('a\nb', null)).toEqual(['a', 'b'])
    expect(headTailLines('a\nb\npart', 'ial\nc\nd')).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('sortSessions · pathKey', () => {
  it('최신이 위, 같은 시각은 id 순', () => {
    const s = (id: string, at: number) => ({ id, at })
    expect(sortSessions([s('b', 1), s('c', 3), s('a', 1)]).map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })
  it('Windows 드라이브 경로는 구분자·대소문자·끝 구분자를 무시, POSIX 는 대소문자 유지', () => {
    expect(pathKey('D:\\Work\\App\\')).toBe(pathKey('d:/work/app'))
    expect(pathKey('/w/App')).not.toBe(pathKey('/w/app'))
  })
})

describe('재개 명령(Orca buildAgentResumeInvocation)', () => {
  const settings = defaultAgentSettings()
  it('claude·gemini --resume, codex resume 하위 명령', () => {
    expect(resumeArgs('claude', ID)).toEqual(['--resume', ID])
    expect(resumeArgs('gemini', ID)).toEqual(['--resume', ID])
    expect(resumeArgs('codex', ID)).toEqual(['resume', ID])
  })
  it('재개는 실행 명령 + 재개 인자만 — 권한 플래그·첫 지시 없음, 명령 바꾸기는 따른다', () => {
    const p = planAgentLaunch({ agent: 'claude', settings, shell: 'posix', resume: ID, prompt: '무시' })
    expect(p).toMatchObject({ ok: true, line: `claude --resume ${ID}`, env: {} })
    const custom = { ...settings, agents: { ...settings.agents, codex: { ...settings.agents.codex, command: 'npx codex' } } }
    expect(planAgentLaunch({ agent: 'codex', settings: custom, shell: 'powershell', resume: 'cx-1' })).toMatchObject({ ok: true, line: '& npx codex resume cx-1' })
  })
  it('복사용: 셸 문법으로 폴더 이동을 붙인다', () => {
    expect(resumeCommandText('claude --resume a', '/w/my app', 'posix')).toBe("cd '/w/my app' && claude --resume a")
    expect(resumeCommandText('& claude --resume a', 'D:\\w\\app', 'powershell')).toBe('Set-Location -LiteralPath D:\\w\\app; & claude --resume a')
    expect(resumeCommandText('claude --resume a', 'D:\\w\\my app', 'cmd')).toBe('cd /d "D:\\w\\my app" && claude --resume a')
    expect(resumeCommandText('claude --resume a', 'D:\\100%', 'cmd')).toBe('claude --resume a')
    expect(resumeCommandText('claude --resume a', null, 'posix')).toBe('claude --resume a')
  })
})

describe('main vault 스캔(가짜 홈)', () => {
  const home = mkdtempSync(join(tmpdir(), 'ara-vault-'))
  const userData = mkdtempSync(join(tmpdir(), 'ara-vault-ud-'))
  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })
  const put = (rel: string, body: string, mtimeSec: number): string => {
    const p = join(home, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
    utimesSync(p, mtimeSec, mtimeSec)
    return p
  }
  const geminiCwd = join(home, 'proj-g')
  const hash = createHash('sha256').update(geminiCwd).digest('hex')
  put(join('.claude', 'projects', '-w-app', `${ID}.jsonl`), claudeLines.join('\n'), 3000)
  put(join('.claude', 'projects', '-w-app', ID, 'subagents', 'agent-x.jsonl'), J({ type: 'user', sessionId: 'sub', message: { content: 'sub' } }), 4000)
  put(join('.codex', 'sessions', '2026', '11', '01', 'rollout-1.jsonl'), [J({ type: 'session_meta', payload: { id: 'cx-1', cwd: '/w/api' } })].join('\n'), 2000)
  put(join('.gemini', 'tmp', hash, 'chats', 'session-1.json'), J({ sessionId: 'gm-1', messages: [{ type: 'user', content: '안녕' }] }), 1000)
  put(join('.gemini', 'tmp', hash, 'logs.json'), J({ sessionId: 'not-a-session' }), 5000)
  // 큰 파일 — 머리(첫 지시)와 꼬리(마지막 턴)만 읽는다.
  const filler = J({ type: 'progress', data: 'x'.repeat(1000) })
  const big = [J({ type: 'user', sessionId: 'big-1', cwd: '/w/big', message: { content: '큰 작업' } }), ...Array(400).fill(filler), J({ type: 'assistant', message: { content: '마지막 답' } })]
  put(join('.claude', 'projects', '-w-big', 'big-1.jsonl'), big.join('\n'), 2500)

  registerVaultFeature({ home, userData })
  const call = (c: string, req: unknown): Promise<unknown> => Promise.resolve(handlers.get(c)!({}, req))

  it('세 CLI 를 최신순으로, 하위 에이전트·gemini 곁 파일은 빼고, gemini 폴더는 해시로 맞춘다', async () => {
    const list = (await call('vault:list', { cwds: [geminiCwd] })) as VaultSession[]
    expect(list.map((s) => [s.agent, s.id, s.cwd])).toEqual([
      ['claude', ID, '/w/app'],
      ['claude', 'big-1', '/w/big'],
      ['codex', 'cx-1', '/w/api'],
      ['gemini', 'gm-1', geminiCwd]
    ])
    expect(list[1].firstPrompt).toBe('큰 작업')
  })

  it('상세: 큰 파일의 꼬리에서 최근 턴, 목록에 없는 파일은 거절', async () => {
    const list = (await call('vault:list', { cwds: [] })) as VaultSession[]
    const big1 = list.find((s) => s.id === 'big-1')!
    const d = (await call('vault:detail', { file: big1.file })) as { ok: true; turns: { text: string }[] }
    expect(d.ok).toBe(true)
    expect(d.turns.at(-1)?.text).toBe('마지막 답')
    expect(await call('vault:detail', { file: join(home, 'elsewhere.jsonl') })).toMatchObject({ ok: false })
  })

  it('재개 명령 복사: 저장된 설정(agents.json 없으면 기본) + 폴더 이동', async () => {
    expect(await call('vault:resumeCommand', { agent: 'claude', id: ID, cwd: '/w/app' })).toEqual({ ok: true, text: `cd /w/app && claude --resume ${ID}` })
    expect(await call('vault:resumeCommand', { agent: 'nope', id: ID, cwd: null })).toMatchObject({ ok: false })
  })
})
