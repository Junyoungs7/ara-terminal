// 원격 3차 R0 — 계정 간 대화 기록 공유(Orca claude-profile-history.ts) + 다른 계정으로 이어서(--resume <id> + 새 계정 env).
// 🔴 실제 ~/.claude·~/.codex 는 안 쓴다 — 임시 폴더를 '기본 폴더'로 준다. 정리도 removeAccountTree 로만(안에 junction 이 있다 — 재귀 삭제 금지).
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_HISTORY, createAccountsFeature, removeAccountTree, shareHistoryDir } from '../src/main/usage/accounts'
import { agentSettingsOf, planAgentLaunch } from '../src/shared/agents'

const win = process.platform === 'win32'
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ara-r0-'))
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
const isLink = (p: string): boolean => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true

function setup() {
  const ud = tmp()
  const sys = { claude: tmp(), codex: tmp() }
  put(join(sys.claude, 'projects', 'old', 'base.jsonl'), 'base')
  const acc = createAccountsFeature({ userData: ud, defaultDir: (p) => sys[p] })
  return { ud, sys, acc }
}

/**
 * 가짜 claude 의 --resume 찾기 — Claude Code 처럼 $CLAUDE_CONFIG_DIR/projects/<아무 폴더>/<id>.jsonl 을 찾는다.
 * 진짜 CLI 는 안 띄운다(규칙). 자식 node 로 돌려 링크를 OS 가 푸는 그대로 따라간다.
 */
const FAKE_RESUME = `const fs=require('fs'),p=require('path');const r=p.join(process.env.CLAUDE_CONFIG_DIR,'projects');const id=process.argv[process.argv.indexOf('--resume')+1];
for(const d of (fs.existsSync(r)?fs.readdirSync(r):[])){const f=p.join(r,d,id+'.jsonl');if(fs.existsSync(f)){process.stdout.write('FOUND '+fs.readFileSync(f,'utf8'));process.exit(0)}}process.stdout.write('NOT FOUND');`
const fakeResume = (configDir: string, id: string): string =>
  execFileSync(process.execPath, ['-e', FAKE_RESUME, '--', '--resume', id], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, encoding: 'utf8' })

describe('R0 Claude 대화 기록 공유', () => {
  it('계정 A 에서 쓴 jsonl 이 계정 B 에서 보인다(둘 다 기본 폴더로 링크) — 기본 폴더 기록도 보인다', () => {
    const { sys, acc } = setup()
    const a = acc.dir('claude', acc.add('claude', 'A'))!
    const b = acc.dir('claude', acc.add('claude', 'B'))!
    for (const n of CLAUDE_HISTORY) {
      expect(isLink(join(a, n))).toBe(true)
      expect(isLink(join(b, n))).toBe(true)
    }
    put(join(a, 'projects', 'D--repo', 'sid-1.jsonl'), '{"from":"A"}') // Claude 가 A 의 CLAUDE_CONFIG_DIR 로 쓴 자리
    expect(readFileSync(join(b, 'projects', 'D--repo', 'sid-1.jsonl'), 'utf8')).toBe('{"from":"A"}')
    expect(readFileSync(join(sys.claude, 'projects', 'D--repo', 'sid-1.jsonl'), 'utf8')).toBe('{"from":"A"}')
    expect(readFileSync(join(b, 'projects', 'old', 'base.jsonl'), 'utf8')).toBe('base')
    // 자격·프롬프트 기록·프로세스 대장은 여전히 계정별(링크 아님).
    put(join(a, '.credentials.json'), '{"a":1}')
    expect(existsSync(join(b, '.credentials.json'))).toBe(false)
    expect(existsSync(join(sys.claude, '.credentials.json'))).toBe(false)
  })

  it('기존 계정 폴더 이전: 쌓인 projects 를 기본 쪽으로 합치고, 충돌은 덮지 않고 .ara-merge 에 남긴다', () => {
    const { ud, sys, acc } = setup()
    const id = acc.add('claude', 'A')
    const dir = acc.dir('claude', id)!
    // R0 이전처럼: 계정 폴더에 진짜 projects 가 있다(링크를 걷어 내고 옛 모양을 만든다).
    removeAccountTree(join(dir, 'projects'))
    put(join(dir, 'projects', 'p', 'only-a.jsonl'), 'A only')
    put(join(dir, 'projects', 'old', 'base.jsonl'), 'A 의 다른 base') // 기본 쪽과 같은 이름 = 충돌
    put(join(dir, 'todos', 't.json'), 'todo')
    acc.select('claude', id)
    acc.launchEnv('claude') // 띄울 때 합친다
    expect(isLink(join(dir, 'projects'))).toBe(true)
    expect(readFileSync(join(sys.claude, 'projects', 'p', 'only-a.jsonl'), 'utf8')).toBe('A only')
    expect(readFileSync(join(sys.claude, 'projects', 'old', 'base.jsonl'), 'utf8')).toBe('base') // 기본 쪽은 그대로
    expect(readFileSync(join(dir, 'projects.ara-merge', 'old', 'base.jsonl'), 'utf8')).toBe('A 의 다른 base') // 충돌은 보존
    expect(readFileSync(join(sys.claude, 'todos', 't.json'), 'utf8')).toBe('todo')
    expect(existsSync(join(dir, 'todos.ara-merge'))).toBe(false) // 충돌 없는 폴더는 다 옮기고 비운다
    expect(ud).toBeTruthy()
  })

  it('링크를 못 걸면 계정 폴더를 그대로 돌려놓는다(기록이 사라지지 않고 계정은 예전처럼 돈다)', () => {
    const profile = tmp()
    const home = tmp()
    put(join(profile, 'projects', 'p', 'x.jsonl'), 'x')
    const failing = (() => {
      throw new Error('EPERM')
    }) as unknown as typeof import('node:fs').symlinkSync
    expect(shareHistoryDir(profile, home, 'projects', win, failing)).toBe(false)
    expect(isLink(join(profile, 'projects'))).toBe(false)
    expect(readFileSync(join(profile, 'projects', 'p', 'x.jsonl'), 'utf8')).toBe('x')
    expect(existsSync(join(profile, 'projects.ara-merge'))).toBe(false)
    expect(existsSync(join(home, 'projects', 'p'))).toBe(false) // 기본 쪽으로 반쯤 옮기지도 않았다
    // 양성 대조: 같은 자리에서 진짜 링크면 합쳐진다.
    expect(shareHistoryDir(profile, home, 'projects', win)).toBe(true)
    expect(readFileSync(join(home, 'projects', 'p', 'x.jsonl'), 'utf8')).toBe('x')
  })

  it('계정을 지워도 기본 폴더 기록은 무사하다 — 링크부터 끊는다(양성 대조)', () => {
    const { sys, acc } = setup()
    const id = acc.add('claude', 'A')
    const dir = acc.dir('claude', id)!
    put(join(dir, 'projects', 'D--repo', 'sid-1.jsonl'), 'keep me')
    expect(isLink(join(dir, 'projects'))).toBe(true) // 전제: 정말 링크다
    acc.remove('claude', id)
    expect(existsSync(dir)).toBe(false)
    expect(readFileSync(join(sys.claude, 'projects', 'D--repo', 'sid-1.jsonl'), 'utf8')).toBe('keep me')
    expect(readFileSync(join(sys.claude, 'projects', 'old', 'base.jsonl'), 'utf8')).toBe('base')
  })

  it('음성 대조: 링크를 따라 들어가는 재귀 삭제면 기본 폴더 기록이 지워진다 — 위 시험이 그 사고를 잡는다', () => {
    const { sys, acc } = setup()
    const dir = acc.dir('claude', acc.add('claude', 'A'))!
    const followingDelete = (p: string): void => {
      const st = statSync(p, { throwIfNoEntry: false })
      if (!st) return
      if (!st.isDirectory()) return unlinkSync(p)
      for (const n of readdirSync(p)) followingDelete(join(p, n))
      try {
        rmdirSync(p)
      } catch {
        unlinkSync(p)
      }
    }
    followingDelete(dir)
    expect(existsSync(join(sys.claude, 'projects', 'old', 'base.jsonl'))).toBe(false)
  })
})

describe('R0 다른 계정으로 이어서 — 재시작 계획', () => {
  it('--resume <id> + 새 계정 env, 가짜 claude 가 B 계정 env 로 A 의 대화를 찾는다', () => {
    const { acc } = setup()
    const a = acc.add('claude', 'A')
    const b = acc.add('claude', 'B')
    acc.select('claude', a)
    put(join(acc.dir('claude', a)!, 'projects', 'D--repo', 'sid-7.jsonl'), 'A 의 대화')
    // feature.ts 와 같은 조합: launchEnv(그 계정) → planAgentLaunch(extraEnv, resume).
    const env = acc.launchEnv('claude', b)
    const plan = planAgentLaunch({ agent: 'claude', settings: agentSettingsOf(null), shell: 'posix', resume: 'sid-7', extraEnv: env })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.line).toContain('--resume sid-7')
    expect(plan.env['CLAUDE_CONFIG_DIR']).toBe(acc.dir('claude', b))
    expect(fakeResume(plan.env['CLAUDE_CONFIG_DIR']!, 'sid-7')).toBe('FOUND A 의 대화')
    // 양성 대조: 같은 계정(A)으로도 찾는다. 음성 대조: 공유 없는 빈 폴더는 못 찾는다(R0 전 모습).
    expect(fakeResume(acc.dir('claude', a)!, 'sid-7')).toBe('FOUND A 의 대화')
    expect(fakeResume(tmp(), 'sid-7')).toBe('NOT FOUND')
  })

  it('account: undefined = 고른 계정, null = 시스템 기본(env 없음)', () => {
    const { acc } = setup()
    const a = acc.add('claude', 'A')
    acc.select('claude', a)
    expect(acc.launchEnv('claude')).toEqual({ CLAUDE_CONFIG_DIR: acc.dir('claude', a) })
    expect(acc.launchEnv('claude', null)).toEqual({})
  })

  it('Codex: 재개하면 rollout 을 새 계정 CODEX_HOME 으로 복사(원본은 그대로, 이미 있으면 안 덮는다)', () => {
    const { sys, acc } = setup()
    const tid = '0199aaaa-bbbb-cccc-dddd-eeeeffff0001'
    const rel = join('2026', '11', '04', `rollout-2026-11-04T10-00-00-${tid}.jsonl`)
    put(join(sys.codex, 'sessions', rel), 'rollout')
    const b = acc.add('codex', 'B')
    const env = acc.launchEnv('codex', b, tid)
    expect(env).toEqual({ CODEX_HOME: acc.dir('codex', b) })
    expect(readFileSync(join(acc.dir('codex', b)!, 'sessions', rel), 'utf8')).toBe('rollout')
    expect(readFileSync(join(sys.codex, 'sessions', rel), 'utf8')).toBe('rollout')
    writeFileSync(join(acc.dir('codex', b)!, 'sessions', rel), 'B 가 이어 쓴 것')
    acc.launchEnv('codex', b, tid)
    expect(readFileSync(join(acc.dir('codex', b)!, 'sessions', rel), 'utf8')).toBe('B 가 이어 쓴 것')
    // B → 시스템 기본으로 되돌아갈 때도(기본 쪽에 없으면) 복사.
    const tid2 = '0199aaaa-bbbb-cccc-dddd-eeeeffff0002'
    const rel2 = join('2026', '11', '04', `rollout-2026-11-04T11-00-00-${tid2}.jsonl`)
    put(join(acc.dir('codex', b)!, 'sessions', rel2), 'b only')
    expect(acc.launchEnv('codex', null, tid2)).toEqual({})
    expect(readFileSync(join(sys.codex, 'sessions', rel2), 'utf8')).toBe('b only')
  })
})
