// M13 R2 — 추가 계정 폴더에 사용자 기본 폴더의 agents·commands·skills·plugins 를 링크로 공유(Orca claude-profile-provisioning·codex-home-paths 목록),
// 계정 지우기는 링크부터 끊는다(removeAccountTree). 🔴 실제 ~/.claude·~/.codex 는 안 쓴다 — 임시 폴더를 '기본 폴더'로 준다.
// 🔴 정리도 removeAccountTree 로만(이 파일의 임시 폴더 안에 원본으로 가는 junction 이 있다 — 재귀 삭제 금지).
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountsFeature, isClaudeShared, removeAccountTree } from '../src/main/usage/accounts'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ara-m13r2-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0).reverse()) removeAccountTree(d)
})

const put = (p: string, body: string): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

/** 임시 '홈': 가짜 ~/.claude(스킬·에이전트·명령·플러그인 + 계정별 항목)와 ~/.codex. */
function setup() {
  const ud = tmp()
  const sys = { claude: tmp(), codex: tmp() }
  put(join(sys.claude, 'skills', 'x', 'SKILL.md'), '# x skill')
  put(join(sys.claude, 'agents', 'a.md'), 'agent')
  put(join(sys.claude, 'commands', 'c.md'), 'cmd')
  put(join(sys.claude, 'plugins', 'installed_plugins.json'), '{}')
  put(join(sys.claude, 'settings.json'), '{"model":"opus"}')
  put(join(sys.claude, 'CLAUDE.md'), '# 내 지시')
  put(join(sys.claude, '.credentials.json'), '{"secret":1}')
  put(join(sys.claude, 'history.jsonl'), '{}')
  put(join(sys.claude, 'projects', 'p', 's.jsonl'), '{}')
  put(join(sys.claude, 'sessions', 's.json'), '{}')
  put(join(sys.claude, 'agent-memory-x', 'm.md'), 'm')
  put(join(sys.codex, 'skills', 'y', 'SKILL.md'), '# y skill')
  put(join(sys.codex, 'prompts', 'p.md'), 'p')
  put(join(sys.codex, '.tmp', 'bundled-marketplaces', 'openai-bundled', 'm.json'), '{}')
  put(join(sys.codex, 'AGENTS.md'), '# codex 지시')
  put(join(sys.codex, 'config.toml'), 'model = "gpt-5.6"')
  put(join(sys.codex, 'auth.json'), '{"secret":1}')
  put(join(sys.codex, 'sessions', 'r.jsonl'), '{}')
  const acc = createAccountsFeature({ userData: ud, defaultDir: (p) => sys[p] })
  return { ud, sys, acc }
}

const isLink = (p: string): boolean => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true

/** 일부러 잘못된 삭제 — 링크를 따라 들어가는 재귀 삭제(statSync 는 링크를 따른다). 2026-09-29 사고를 흉내 낸다. */
function followingDelete(p: string): void {
  const st = statSync(p, { throwIfNoEntry: false })
  if (!st) return
  if (!st.isDirectory()) return unlinkSync(p)
  for (const n of readdirSync(p)) followingDelete(join(p, n))
  try {
    rmdirSync(p)
  } catch {
    unlinkSync(p) // 비워진 링크 자리
  }
}

describe('공유 목록(Orca isSharedEntry)', () => {
  it('확장 폴더·설정은 공유, 자격·세션·히스토리·숨은 항목은 계정별', () => {
    for (const n of ['skills', 'agents', 'commands', 'plugins', 'CLAUDE.md', 'output-styles', 'hooks']) expect(isClaudeShared(n)).toBe(true)
    for (const n of ['.credentials.json', '.claude.json', 'projects', 'sessions', 'history.jsonl', 'todos', 'file-history', 'statsig', 'daemon-x', 'agent-memory', 'settings.json']) {
      expect(isClaudeShared(n)).toBe(false)
    }
  })
})

describe('계정 폴더 — 링크 공유', () => {
  it('Claude: 폴더는 링크(원본 그대로 보임), 파일은 복사, 계정별 항목은 없음', () => {
    const { acc } = setup()
    const dir = acc.dir('claude', acc.add('claude', '회사'))!
    for (const n of ['skills', 'agents', 'commands', 'plugins']) expect(isLink(join(dir, n))).toBe(true)
    expect(readFileSync(join(dir, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('# x skill')
    expect(isLink(join(dir, 'CLAUDE.md'))).toBe(false)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# 내 지시')
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"model":"opus"}')
    for (const n of ['.credentials.json', 'history.jsonl', 'sessions', 'agent-memory-x']) expect(existsSync(join(dir, n))).toBe(false)
    // R0: 대화 기록(projects 등)은 공용 링크가 아니라 기본 폴더로 합치는 전용 링크(accountsHistory.test.ts).
    expect(isLink(join(dir, 'projects'))).toBe(true)
  })
  it('Codex: Orca 자원 목록만(skills·prompts·.tmp/bundled-marketplaces 링크, AGENTS.md·config.toml 복사), auth.json·sessions 없음', () => {
    const { acc } = setup()
    const dir = acc.dir('codex', acc.add('codex', 'b'))!
    for (const n of ['skills', 'prompts', join('.tmp', 'bundled-marketplaces')]) expect(isLink(join(dir, n))).toBe(true)
    expect(readFileSync(join(dir, 'skills', 'y', 'SKILL.md'), 'utf8')).toBe('# y skill')
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# codex 지시')
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe('model = "gpt-5.6"')
    for (const n of ['auth.json', 'sessions']) expect(existsSync(join(dir, n))).toBe(false)
  })
  it('띄울 때마다 다시 건다: 나중에 깐 폴더도 링크, 바뀐 설정은 다시 복사, 내용 있는 폴더(사용자·CLI 것)는 그대로', () => {
    const { sys, acc } = setup()
    const id = acc.add('claude', 'a')
    const dir = acc.dir('claude', id)!
    put(join(dir, 'output-styles', 'mine.md'), 'mine') // 계정에서 먼저 생긴 내용 있는 폴더
    put(join(sys.claude, 'output-styles', 'o.md'), 'o')
    put(join(sys.claude, 'rules', 'r.md'), 'r')
    writeFileSync(join(sys.claude, 'settings.json'), '{"model":"sonnet"}')
    acc.select('claude', id)
    acc.launchEnv('claude')
    expect(isLink(join(dir, 'rules'))).toBe(true)
    expect(isLink(join(dir, 'output-styles'))).toBe(false)
    expect(readdirSync(join(dir, 'output-styles'))).toEqual(['mine.md'])
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"model":"sonnet"}')
  })
})

describe('지우기 — 링크부터 끊는다(양성 대조)', () => {
  it('계정을 지워도 원본 ~/.claude·~/.codex 파일은 그대로, 계정 폴더는 사라진다', () => {
    const { ud, sys, acc } = setup()
    const c = acc.add('claude', 'a')
    const x = acc.add('codex', 'b')
    const cdir = acc.dir('claude', c)!
    const xdir = acc.dir('codex', x)!
    expect(isLink(join(cdir, 'skills'))).toBe(true) // 대조 전제: 링크가 정말 있다
    acc.remove('claude', c)
    acc.remove('codex', x)
    expect(existsSync(cdir)).toBe(false)
    expect(existsSync(xdir)).toBe(false)
    expect(readFileSync(join(sys.claude, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('# x skill')
    expect(readFileSync(join(sys.claude, 'agents', 'a.md'), 'utf8')).toBe('agent')
    expect(existsSync(join(sys.claude, 'plugins', 'installed_plugins.json'))).toBe(true)
    expect(readFileSync(join(sys.codex, 'skills', 'y', 'SKILL.md'), 'utf8')).toBe('# y skill')
    expect(existsSync(join(sys.codex, '.tmp', 'bundled-marketplaces', 'openai-bundled', 'm.json'))).toBe(true)
    expect(readdirSync(join(ud, 'accounts', 'claude'))).toEqual([])
  })
  it('음성 대조: 링크를 따라 들어가는 재귀 삭제를 쓰면 원본이 지워진다 — 위 시험의 원본 확인이 그 사고를 잡는다', () => {
    const { sys, acc } = setup()
    const dir = acc.dir('claude', acc.add('claude', 'a'))!
    followingDelete(dir)
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(sys.claude, 'skills', 'x', 'SKILL.md'))).toBe(false) // 원본이 사라졌다 = 양성 대조의 expect 가 실패했을 자리
  })
  it('removeAccountTree: 링크 자체가 경로면 링크만 빠진다', () => {
    const { sys, acc } = setup()
    const dir = acc.dir('claude', acc.add('claude', 'a'))!
    removeAccountTree(join(dir, 'skills'))
    expect(existsSync(join(dir, 'skills'))).toBe(false)
    expect(existsSync(join(sys.claude, 'skills', 'x', 'SKILL.md'))).toBe(true)
  })
})
