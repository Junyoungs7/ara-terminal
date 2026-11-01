// M11 지난 세션 2차 — 전문 검색(main/vault/search.ts, utility process 가 부르는 부분)·삭제(vault:delete — 휴지통은 가짜)·범위·필터·정렬·묶기(vaultView.ts).
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultSession } from '@shared/vault'

const handlers = new Map<string, (e: unknown, req: unknown) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (c: string, fn: (e: unknown, req: unknown) => unknown) => handlers.set(c, fn) }, app: { getPath: () => tmpdir() } }))
vi.mock('../src/main/sessions/PtyBackend', () => ({ defaultLaunchShell: () => 'posix' }))

import { searchSessionFiles, type SearchFile } from '../src/main/vault/search'
import { deleteTargets, registerVaultFeature } from '../src/main/vault/feature'
import { DEFAULT_VAULT_VIEW, groupSessions, inScope, mergeSearch, vaultViewOf, viewSessions } from '../src/renderer/features/aiws/vaultView'

const J = (o: unknown): string => JSON.stringify(o)
const home = mkdtempSync(join(tmpdir(), 'ara-vsearch-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const put = (rel: string, body: string): string => {
  const p = join(home, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
  return p
}
const file = (agent: SearchFile['agent'], path: string, mtimeMs: number): SearchFile => ({ agent, path, mtimeMs, size: statSync(path).size, createdAt: mtimeMs })

describe('전문 검색(searchSessionFiles)', () => {
  const c1 = put(join('.claude', 'projects', '-w-a', 'c1.jsonl'), [
    J({ type: 'user', sessionId: 'c1', cwd: '/w/a', message: { content: '<system-reminder>needle in harness</system-reminder>' } }),
    J({ type: 'user', sessionId: 'c1', cwd: '/w/a', message: { content: '로그인 버그 고쳐 줘' } }),
    J({ type: 'assistant', sessionId: 'c1', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'Needle' } }] } }),
    J({ type: 'user', sessionId: 'c1', message: { content: [{ type: 'tool_result', content: 'needle in tool output' }] } }),
    J({ type: 'assistant', sessionId: 'c1', message: { content: [{ type: 'text', text: '세션 토큰 갱신이 빠져 있었습니다. 이제 NEEDLE 처리를 합니다.' }] } })
  ].join('\n'))
  const x1 = put(join('.codex', 'sessions', '2026', '11', '01', 'r.jsonl'), [
    J({ type: 'session_meta', payload: { id: 'x1', cwd: '/w/b' } }),
    J({ type: 'event_msg', payload: { type: 'user_message', message: 'harness only mention: no match here' } })
  ].join('\n'))
  const g1 = put(join('.gemini', 'tmp', 'h', 'chats', 's.json'), J({ sessionId: 'g1', messages: [{ type: 'user', content: '토큰 갱신 needle?' }] }))
  const named = put(join('.claude', 'projects', '-w-a', 'n1.jsonl'), J({ type: 'user', sessionId: 'n1', message: { content: '__ara_chat_name__ needle' } }))

  it('대화 글만 본다(하네스 주입·도구 입력·도구 출력 제외), 대소문자 무시, 조각을 돌려준다', async () => {
    const r = await searchSessionFiles([file('claude', c1, 3), file('codex', x1, 2), file('gemini', g1, 1)], 'needle')
    expect(r.hits.map((h) => h.session.id)).toEqual(['c1', 'g1'])
    expect(r.hits[0].snippet).toContain('NEEDLE')
    expect(r.hits[0].session).toMatchObject({ cwd: '/w/a', firstPrompt: '로그인 버그 고쳐 줘' })
    expect(r.truncated).toBe(false)
    const ko = await searchSessionFiles([file('claude', c1, 3), file('gemini', g1, 1)], '토큰 갱신')
    expect(ko.hits.map((h) => h.session.id)).toEqual(['c1', 'g1'])
  })

  it('채팅 이름 짓기의 한 번짜리 실행은 결과에 안 넣고, 취소하면 그만둔다', async () => {
    const { CHAT_NAME_OPENING } = await import('@shared/agentOptions')
    writeFileSync(named, J({ type: 'user', sessionId: 'n1', message: { content: `${CHAT_NAME_OPENING} needle` } }))
    expect((await searchSessionFiles([file('claude', named, 9)], 'needle')).hits).toEqual([])
    const cancelled = await searchSessionFiles([file('claude', c1, 3)], 'needle', () => true)
    expect(cancelled).toMatchObject({ hits: [], scanned: 0, truncated: true })
  })
})

describe('삭제(vault:delete)', () => {
  it('claude 는 딸린 폴더·session-env 먼저, 기록 파일 마지막 — 다른 CLI 는 파일만', () => {
    const f = join(home, '.claude', 'projects', '-w-a', 'abc.jsonl')
    expect(deleteTargets('claude', f, home)).toEqual([join(home, '.claude', 'projects', '-w-a', 'abc'), join(home, '.claude', 'session-env', 'abc'), f])
    expect(deleteTargets('codex', '/x/r.jsonl', home)).toHaveLength(1)
  })

  it('목록에 있던 파일만 휴지통으로 — 있는 것만, 지운 뒤엔 상세도 거절', async () => {
    const id = 'del-1'
    const f = put(join('.claude', 'projects', '-w-d', `${id}.jsonl`), J({ type: 'user', sessionId: id, cwd: '/w/d', message: { content: '지울 세션' } }))
    put(join('.claude', 'projects', '-w-d', id, 'subagents', 'agent-1.jsonl'), J({ type: 'user', sessionId: 'sub', message: { content: 's' } }))
    const trashed: string[] = []
    registerVaultFeature({ home, userData: home, trash: async (p) => void trashed.push(p) })
    const call = (c: string, req: unknown): Promise<unknown> => Promise.resolve(handlers.get(c)!({}, req))
    expect(await call('vault:delete', { file: f })).toMatchObject({ ok: false }) // 아직 목록을 안 읽었다
    const list = (await call('vault:list', { cwds: [] })) as VaultSession[]
    expect(list.some((s) => s.id === id && typeof s.createdAt === 'number')).toBe(true)
    expect(await call('vault:delete', { file: f })).toEqual({ ok: true })
    expect(trashed).toEqual([join(home, '.claude', 'projects', '-w-d', id), f]) // session-env 는 없어서 건너뜀
    expect(existsSync(f)).toBe(true) // 가짜 휴지통 — 진짜로는 안 지운다
    expect(await call('vault:detail', { file: f })).toMatchObject({ ok: false })
    expect(await call('vault:search', { query: 'x', cwds: [] })).toEqual({ ok: true, sessions: [], scanned: 0, truncated: false }) // 한 글자는 검색 안 함(워커 안 띄움)
  })
})

describe('범위·필터·정렬·묶기(vaultView)', () => {
  const s = (o: Partial<VaultSession> & { id: string }): VaultSession => ({ agent: 'claude', cwd: null, file: `/f/${o.id}`, at: 0, title: null, firstPrompt: 'p', ...o })
  const list = [
    s({ id: 'a', cwd: 'C:\\w\\app', at: 30, createdAt: 1 }),
    s({ id: 'b', cwd: 'c:/w/app/sub', at: 20, createdAt: 3, agent: 'codex' }),
    s({ id: 'c', cwd: '/w/other', at: 10, createdAt: 2, firstPrompt: null }),
    s({ id: 'd', cwd: null, at: 5, title: '정렬 고침' })
  ]

  it('범위: 같은 폴더·그 안만(드라이브 대소문자·구분자 무시), null = 전체, 폴더 모름은 전체에만', () => {
    expect(inScope('C:\\w\\app', ['c:/w/app'])).toBe(true)
    expect(inScope('c:/w/app/sub', ['C:\\w\\app'])).toBe(true)
    expect(inScope('c:/w/apple', ['C:\\w\\app'])).toBe(false)
    expect(inScope(null, ['/x'])).toBe(false)
    expect(inScope(null, null)).toBe(true)
    expect(viewSessions(list, DEFAULT_VAULT_VIEW, ['C:/w/app'], '').map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('에이전트 끄기·빈 세션 숨기기·만든 시각 정렬·검색 칸 거르기', () => {
    const v = { ...DEFAULT_VAULT_VIEW, agents: DEFAULT_VAULT_VIEW.agents.filter((a) => a !== 'codex') }
    expect(viewSessions(list, v, null, '').map((x) => x.id)).toEqual(['a', 'c', 'd'])
    expect(viewSessions(list, { ...DEFAULT_VAULT_VIEW, hideEmpty: true }, null, '').map((x) => x.id)).toEqual(['a', 'b', 'd'])
    expect(viewSessions(list, { ...DEFAULT_VAULT_VIEW, sort: 'created' }, null, '').map((x) => x.id)).toEqual(['d', 'b', 'c', 'a']) // d 는 만든 시각 모름 → 업데이트 시각(5)
    expect(viewSessions(list, DEFAULT_VAULT_VIEW, null, '정렬').map((x) => x.id)).toEqual(['d'])
    // 전문 검색 결과(조각 있음)는 검색 칸 거르기에 안 걸린다.
    const merged = mergeSearch(list, [s({ id: 'c', cwd: '/w/other', at: 10, snippet: '…본문에만…' })])
    expect(viewSessions(merged, DEFAULT_VAULT_VIEW, null, '본문').map((x) => x.id)).toEqual(['c'])
  })

  it('묶기는 정렬 순서를 지키고, 저장값은 모르는 값을 기본으로', () => {
    const g = groupSessions(list, (x) => ({ key: x.agent, label: x.agent }))
    expect(g.map((x) => [x.key, x.items.map((i) => i.id)])).toEqual([
      ['claude', ['a', 'c', 'd']],
      ['codex', ['b']]
    ])
    expect(vaultViewOf({ scope: 'nope', sort: 'created', agents: ['gemini', 'x'], hideEmpty: true })).toEqual({ ...DEFAULT_VAULT_VIEW, sort: 'created', agents: ['gemini'], hideEmpty: true })
  })
})
