// M14 R2 `ara` CLI — 진짜 CLI 본체(run) ↔ 진짜 파이프의 가짜 아라(startCliServer + 가짜 의존) 왕복, PATH 등록(모의 레지스트리),
// 번들 스킬(임시 홈), ara.cmd·installer.nsh 모양. 실제 사용자 PATH·레지스트리·%APPDATA%\A.R.A 는 건드리지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { buildSync } from 'esbuild'
import { join } from 'node:path'
import { startCliServer, type CliServerHandle } from '../src/main/cli/server'
import { createCliHandlers, type CliDeps } from '../src/main/cli/handlers'
import { cliInstallStatus, installCli, uninstallCli, type CliInstallDeps, type UserPathRead } from '../src/main/cli/install'
import { bundledSkillSource, bundledSkillStatus, installBundledSkill } from '../src/main/cli/bundledSkill'
import { run, type CliIo } from '../src/cli/main'
import { CLI_RUNTIME_FILE, withPathEntry, withoutPathEntry } from '../src/shared/araCli'
import type { Project, Worktree } from '../src/shared/worktrees'
import type { Session } from '../src/shared/types'

vi.mock('electron', () => ({}))

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ara-cli-'))

// ── 가짜 아라 ────────────────────────────────────────────────────────────────

const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj'
const sep = process.platform === 'win32' ? '\\' : '/'
const project: Project = { id: 'r1', path: ROOT, displayName: 'proj', kind: 'git', addedAt: 0 }
const wt = (name: string, extra: Partial<Worktree> = {}): Worktree => ({
  path: name ? `${ROOT}${sep}..${sep}ws${sep}${name}` : ROOT,
  head: 'abc',
  branch: `refs/heads/${name || 'main'}`,
  isBare: false,
  isMainWorktree: !name,
  id: `r1::${name ? `${ROOT}${sep}..${sep}ws${sep}${name}` : ROOT}`,
  repoId: 'r1',
  displayName: name || 'proj',
  ...extra
})

function fakeDeps() {
  const worktrees: Worktree[] = [wt(''), wt('fix-login')]
  const calls = { changed: [] as string[], launched: [] as unknown[], written: [] as [string, string][], meta: [] as unknown[] }
  const sessions: Session[] = [{ id: 's-agent', type: 'local', title: 'claude', serverKey: 'localhost', cwd: worktrees[1].path, space: 'ai' } as Session]
  const deps: CliDeps = {
    appVersion: '9.9.9',
    worktrees: {
      listProjects: () => [project],
      listWorktrees: async () => ({ ok: true, worktrees }),
      createWorktree: async (a) => {
        const w = wt(a.name)
        worktrees.push(w)
        return { ok: true, worktree: w }
      },
      updateMeta: (id, u) => {
        calls.meta.push({ id, u })
        const w = worktrees.find((x) => x.id === id)
        if (!w) return null
        const v = u as { comment?: string; workspaceStatus?: Worktree['workspaceStatus'] | null }
        if ('comment' in v) w.comment = v.comment || undefined
        if ('workspaceStatus' in v) w.workspaceStatus = v.workspaceStatus ?? undefined
        return { comment: w.comment, workspaceStatus: w.workspaceStatus }
      },
      removeWorktree: async (_r, path) => {
        const i = worktrees.findIndex((x) => x.path === path)
        worktrees.splice(i, 1)
        return { ok: true }
      }
    },
    sessions: {
      snapshot: () => sessions,
      has: (id) => sessions.some((s) => s.id === id),
      write: (id, data) => void calls.written.push([id, data]),
      peek: () => new TextEncoder().encode('hello screen'),
      nextTitle: () => '셸 2',
      create: async (spec) => {
        sessions.push({ id: 's-new', type: 'local', title: spec.title, serverKey: 'localhost', cwd: spec.cwd } as Session)
        return 's-new'
      }
    },
    renderScreen: async (b) => new TextDecoder().decode(b),
    launchAgent: async (req) => {
      calls.launched.push(req)
      return { ok: true, sessionId: 's-launched', title: req.agent, line: req.agent }
    },
    worktreesChanged: (repoId) => void calls.changed.push(repoId)
  }
  return { deps, calls, worktrees, sessions }
}

let userData: string
let server: CliServerHandle | null
beforeEach(() => {
  userData = tmp()
  server = null
})
afterEach(async () => {
  await server?.stop()
  rmSync(userData, { recursive: true, force: true })
})

function io(extra: Partial<CliIo> = {}): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return { out: (s) => void stdout.push(s), err: (s) => void stderr.push(s), env: { ARA_USER_DATA_PATH: userData }, cwd: ROOT, version: '9.9.9', timeoutMs: 5000, stdout, stderr, ...extra }
}
const json = (o: { stdout: string[] }): { ok: boolean; result?: any; error?: any } => JSON.parse(o.stdout.join(''))

async function boot() {
  const f = fakeDeps()
  server = await startCliServer({ userData, appVersion: '9.9.9', handlers: createCliHandlers(f.deps) })
  return f
}

describe('ara CLI ↔ 가짜 아라(진짜 파이프 왕복)', () => {
  it('켜면 ara-runtime.json(파이프·토큰)을 쓰고, 끄면 지운다', async () => {
    await boot()
    const m = JSON.parse(readFileSync(join(userData, CLI_RUNTIME_FILE), 'utf8'))
    expect(m.transports[0].endpoint).toMatch(process.platform === 'win32' ? /^\\\\\.\\pipe\\ara-cli-/ : /ara-cli-.*\.sock$/)
    expect(m.authToken.length).toBeGreaterThanOrEqual(43)
    await server!.stop()
    server = null
    expect(existsSync(join(userData, CLI_RUNTIME_FILE))).toBe(false)
  })

  it('status — 켜져 있으면 판·pid, 파일이 없으면 꺼짐(실패 아님), 남은 파일이면 stale', async () => {
    let o = io()
    expect(await run(['status', '--json'], o)).toBe(0)
    expect(json(o).result.app.running).toBe(false)
    expect(json(o).result.runtime.state).toBe('not_running')
    await boot()
    o = io()
    expect(await run(['status', '--json'], o)).toBe(0)
    expect(json(o).result.app).toMatchObject({ running: true, version: '9.9.9' })
    // 아라가 죽어 파일만 남은 자리 — 파이프는 없다.
    const left = readFileSync(join(userData, CLI_RUNTIME_FILE), 'utf8')
    await server!.stop()
    server = null
    writeFileSync(join(userData, CLI_RUNTIME_FILE), left)
    o = io()
    expect(await run(['status', '--json'], o)).toBe(0)
    expect(json(o).result.runtime.state).toBe('stale_bootstrap')
  })

  it('아라가 꺼져 있으면 명령은 runtime_unavailable(종료 1) + "켠 뒤 다시"', async () => {
    const o = io()
    expect(await run(['worktree', 'list', '--json'], o)).toBe(1)
    expect(json(o).error.code).toBe('runtime_unavailable')
    expect(json(o).error.nextSteps.join(' ')).toContain('ara open')
  })

  it('ara open — 꺼져 있으면 launchApp 을 한 번 부르고 켜질 때까지 기다린다', async () => {
    let launched = 0
    const o = io({
      openTimeoutMs: 5000,
      launchApp: () => {
        launched++
        void boot()
      }
    })
    expect(await run(['open', '--json'], o)).toBe(0)
    expect(launched).toBe(1)
    expect(json(o).result.app.running).toBe(true)
  })

  it('토큰이 틀리면 아무것도 하지 않는다', async () => {
    const f = await boot()
    const path = join(userData, CLI_RUNTIME_FILE)
    const m = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...m, authToken: 'x'.repeat(43) }))
    const o = io()
    expect(await run(['worktree', 'set', '--worktree', 'name:fix-login', '--comment', 'hi', '--json'], o)).toBe(1)
    expect(json(o).error.code).toBe('unauthorized')
    expect(f.calls.meta).toEqual([])
  })

  it('worktree list · current(cwd) · show(선택자) · 텍스트 출력', async () => {
    const f = await boot()
    let o = io()
    expect(await run(['worktree', 'list', '--json'], o)).toBe(0)
    expect(json(o).result.worktrees.map((w: Worktree) => w.displayName)).toEqual(['proj', 'fix-login'])
    o = io({ cwd: join(f.worktrees[1].path, 'src') })
    expect(await run(['worktree', 'current', '--json'], o)).toBe(0)
    expect(json(o).result.worktree.id).toBe(f.worktrees[1].id)
    o = io()
    expect(await run(['worktree', 'show', '--worktree', 'branch:fix-login', '--json'], o)).toBe(0)
    expect(json(o).result.worktree.displayName).toBe('fix-login')
    o = io()
    expect(await run(['worktree', 'list'], o)).toBe(0)
    expect(o.stdout.join('')).toContain('fix-login\tfix-login')
  })

  it('worktree set — M10 R2 메모·카드 상태를 쓰고 사이드바에 알린다, null 은 지움, 틀린 상태는 거절', async () => {
    const f = await boot()
    const cwd = f.worktrees[1].path
    let o = io({ cwd })
    expect(await run(['worktree', 'set', '--worktree', 'active', '--comment', '재현함', '--workspace-status', 'in-review', '--json'], o)).toBe(0)
    expect(json(o).result.worktree).toMatchObject({ comment: '재현함', workspaceStatus: 'in-review' })
    expect(f.calls.changed).toEqual(['r1'])
    o = io({ cwd })
    expect(await run(['worktree', 'set', '--workspace-status', 'null', '--comment', '', '--json'], o)).toBe(0)
    expect(f.worktrees[1].workspaceStatus).toBeUndefined()
    expect(f.worktrees[1].comment).toBeUndefined()
    o = io({ cwd })
    expect(await run(['worktree', 'set', '--workspace-status', 'done', '--json'], o)).toBe(1)
    expect(json(o).error.code).toBe('invalid_argument')
  })

  it('worktree create --agent --prompt — 만들고 그 자리에 에이전트 탭(렌더러 길)', async () => {
    const f = await boot()
    const o = io()
    expect(await run(['worktree', 'create', '--name', 'task-a', '--agent', 'codex', '--prompt', '고쳐 줘', '--json'], o)).toBe(0)
    expect(json(o).result.worktree.displayName).toBe('task-a')
    expect(json(o).result.launch.terminal).toBe('s-launched')
    expect(f.calls.launched).toEqual([{ agent: 'codex', worktreeId: json(o).result.worktree.id, cwd: json(o).result.worktree.path, prompt: '고쳐 줘' }])
  })

  it('작업 단위를 못 찾거나 여러 개면 nextSteps 로 고칠 길', async () => {
    const f = await boot()
    f.worktrees.push(wt('dup'), { ...wt('dup2'), displayName: 'dup' })
    let o = io()
    expect(await run(['worktree', 'show', '--worktree', 'name:dup', '--json'], o)).toBe(1)
    expect(json(o).error.code).toBe('selector_ambiguous')
    expect(json(o).error.nextSteps.length).toBe(2)
    o = io({ cwd: tmpdir() })
    expect(await run(['worktree', 'current', '--json'], o)).toBe(1)
    expect(json(o).error.code).toBe('selector_not_found')
  })

  it('worktree rm — --worktree 를 빼면 거절(지금 폴더를 지우지 않는다), 적으면 지우고 사이드바에 알린다', async () => {
    const f = await boot()
    const none = io({ cwd: f.worktrees[1].path })
    expect(await run(['worktree', 'rm', '--json'], none)).toBe(1)
    expect(f.worktrees.length).toBe(2)
    const o = io()
    expect(await run(['worktree', 'rm', '--worktree', `id:${f.worktrees[1].id}`, '--json'], o)).toBe(0)
    expect(f.worktrees.map((w) => w.displayName)).toEqual(['proj'])
    expect(f.calls.changed).toEqual(['r1'])
  })

  it('terminal send/read — --terminal 이 없으면 이 명령을 친 에이전트 탭(ARA_PANE_KEY)', async () => {
    const f = await boot()
    let o = io({ env: { ARA_USER_DATA_PATH: userData, ARA_PANE_KEY: 's-agent' } })
    expect(await run(['terminal', 'send', '--text', '계속', '--enter', '--json'], o)).toBe(0)
    expect(f.calls.written).toEqual([['s-agent', '계속\r']])
    o = io({ env: { ARA_USER_DATA_PATH: userData, ARA_PANE_KEY: 's-agent' } })
    expect(await run(['terminal', 'read', '--json'], o)).toBe(0)
    expect(json(o).result.text).toBe('hello screen')
    o = io()
    expect(await run(['terminal', 'send', '--text', 'x', '--json'], o)).toBe(1)
    expect(json(o).error.code).toBe('invalid_argument')
  })

  it('terminal create — 그 작업 단위 폴더에 로컬 셸, --command 는 Enter 까지', async () => {
    const f = await boot()
    const o = io()
    expect(await run(['terminal', 'create', '--worktree', 'name:fix-login', '--command', 'npm test', '--json'], o)).toBe(0)
    expect(json(o).result.terminal).toMatchObject({ id: 's-new', cwd: f.worktrees[1].path })
    expect(f.calls.written).toEqual([['s-new', 'npm test\r']])
    const l = io()
    expect(await run(['terminal', 'list', '--worktree', 'name:fix-login', '--json'], l)).toBe(0)
    expect(json(l).result.terminals.map((t: { id: string }) => t.id)).toEqual(['s-agent', 's-new'])
  })

  it('agent launch — 틀린 에이전트는 거절, 맞으면 탭 id', async () => {
    const f = await boot()
    let o = io({ cwd: f.worktrees[1].path })
    expect(await run(['agent', 'launch', '--agent', 'gpt', '--json'], o)).toBe(1)
    o = io({ cwd: f.worktrees[1].path })
    expect(await run(['agent', 'launch', '--agent', 'claude', '--json'], o)).toBe(0)
    expect(json(o).result.launch.terminal).toBe('s-launched')
  })
})

describe('진짜 프로세스 — 번들한 araCli.js 를 node 로 띄워 가짜 아라와 왕복', () => {
  it('worktree set → 종료 0·JSON, 꺼진 뒤에는 종료 1', async () => {
    const f = await boot()
    const out = join(userData, 'araCli.cjs')
    buildSync({ entryPoints: [join(__dirname, '../src/cli/araCli.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, alias: { '@shared': join(__dirname, '../src/shared') }, logLevel: 'silent' })
    const env = { ...process.env, ARA_USER_DATA_PATH: userData }
    const exec = (args: string[]) => new Promise<{ code: number | null; stdout: string }>((done) => {
      const c = spawn(process.execPath, [out, ...args], { env, cwd: tmpdir(), windowsHide: true })
      let stdout = ''
      c.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
      c.on('close', (code) => done({ code, stdout }))
    })
    let r = await exec(['worktree', 'set', '--worktree', 'name:fix-login', '--comment', '자식 프로세스', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).result.worktree.comment).toBe('자식 프로세스')
    expect(f.calls.changed).toEqual(['r1'])
    await server!.stop()
    server = null
    r = await exec(['worktree', 'list', '--json'])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stdout).error.code).toBe('runtime_unavailable')
  }, 30_000)
})

describe('명령 제안(Orca command-suggestion)·help — 아라에 묻기 전에 끝난다', () => {
  it('오타 명령 → 종료 2 + Did you mean, 지우기는 가까울 때만', async () => {
    let o = io()
    expect(await run(['worktree', 'lsit', '--json'], o)).toBe(2)
    expect(json(o).error.code).toBe('unknown_command')
    expect(json(o).error.nextSteps[0]).toContain('ara worktree list')
    o = io()
    expect(await run(['worktree', 'move', '--json'], o)).toBe(2)
    expect(json(o).error.nextSteps.join(' ')).not.toContain('worktree rm')
    o = io()
    expect(await run(['worktree', 'remov', '--json'], o)).toBe(2)
    expect(json(o).error.nextSteps[0]).toContain('ara worktree rm')
  })

  it('모르는 플래그 → 가까운 플래그와 받는 플래그 목록', async () => {
    const o = io()
    expect(await run(['worktree', 'set', '--worktre', 'active', '--json'], o)).toBe(2)
    expect(json(o).error.nextSteps[0]).toBe('Did you mean: --worktree')
  })

  it('인자 없이·help·그룹만 → 도움말(종료 0), --version', async () => {
    let o = io()
    expect(await run([], o)).toBe(0)
    expect(o.stdout.join('')).toContain('ara worktree create')
    o = io()
    expect(await run(['worktree'], o)).toBe(0)
    expect(o.stdout.join('')).toContain('ara worktree set')
    o = io()
    expect(await run(['help', 'worktree', 'set'], o)).toBe(0)
    expect(o.stdout.join('')).toContain('--workspace-status')
    o = io()
    expect(await run(['--version'], o)).toBe(0)
    expect(o.stdout.join('')).toBe('9.9.9\n')
  })
})

// ── PATH 등록(모의 레지스트리) ─────────────────────────────────────────────────────

const RES = 'C:\\Program Files\\ARA\\resources'
const BIN = `${RES}\\bin`
function installDeps(start: UserPathRead, over: Partial<CliInstallDeps> = {}) {
  const state = { read: start, writes: [] as { value: string | null; kind: string }[] }
  const d: CliInstallDeps = {
    platform: 'win32',
    isPackaged: true,
    resourcesPath: RES,
    processPath: 'C:\\Windows\\system32;C:\\Windows',
    env: { USERPROFILE: 'C:\\Users\\me' },
    readUserPath: async () => state.read,
    writeUserPath: async (value, kind) => {
      state.writes.push({ value, kind })
      if (state.read.ok) state.read = { ok: true, value, kind }
    },
    exists: (p) => p === `${BIN}\\ara.cmd`,
    ...over
  }
  return { d, state }
}

describe('CLI 등록 — 사용자 PATH(모의)', () => {
  it('설치 = 우리 한 줄을 끝에, 다른 항목·%VAR%·값 종류는 그대로 / 두 번 눌러도 한 줄', async () => {
    const { d, state } = installDeps({ ok: true, value: '%USERPROFILE%\\bin;C:\\tools', kind: 'ExpandString' })
    expect((await cliInstallStatus(d)).state).toBe('not_installed')
    expect((await installCli(d)).state).toBe('installed')
    expect(state.writes).toEqual([{ value: `%USERPROFILE%\\bin;C:\\tools;${BIN}`, kind: 'ExpandString' }])
    await installCli(d)
    expect(state.writes.length).toBe(1)
  })

  it('제거 = 우리 줄만(대소문자·끝 \\ 무시), 없으면 쓰지 않는다, 마지막 한 줄이면 값을 지운다', async () => {
    const { d, state } = installDeps({ ok: true, value: `C:\\tools;${BIN.toLowerCase()}\\;C:\\x`, kind: 'String' })
    expect((await uninstallCli(d)).state).toBe('not_installed')
    expect(state.writes).toEqual([{ value: 'C:\\tools;C:\\x', kind: 'String' }])
    await uninstallCli(d)
    expect(state.writes.length).toBe(1)
    const only = installDeps({ ok: true, value: BIN, kind: 'ExpandString' })
    await uninstallCli(only.d)
    expect(only.state.writes).toEqual([{ value: null, kind: 'ExpandString' }])
  })

  it('PATH 를 못 읽으면 쓰지 않고 던진다(반쯤 읽은 값으로 덮지 않는다)', async () => {
    const { d, state } = installDeps({ ok: false, detail: '못 읽음' })
    expect((await cliInstallStatus(d)).state).toBe('unknown')
    await expect(installCli(d)).rejects.toThrow('PATH 는 바꾸지 않았습니다')
    expect(state.writes).toEqual([])
  })

  it('개발 실행·Windows 밖·bin 없음 = unsupported, 레지스트리를 읽지도 않는다', async () => {
    for (const over of [{ isPackaged: false }, { platform: 'darwin' as const }, { exists: () => false }]) {
      const read = vi.fn(async (): Promise<UserPathRead> => ({ ok: true, value: '', kind: 'None' }))
      const { d } = installDeps({ ok: true, value: '', kind: 'None' }, { ...over, readUserPath: read })
      expect((await installCli(d)).state).toBe('unsupported')
      expect(read).not.toHaveBeenCalled()
    }
  })

  it('PATH 앞쪽에 같은 이름(ara.exe 등)이 있으면 가려짐을 알린다 — 양성 대조: 없으면 null', async () => {
    const clean = installDeps({ ok: true, value: BIN, kind: 'String' })
    expect((await cliInstallStatus(clean.d)).shadowedBy).toBeNull()
    const { d } = installDeps({ ok: true, value: BIN, kind: 'String' }, { processPath: `C:\\other;${BIN}`, exists: (p) => p === `${BIN}\\ara.cmd` || p === 'C:\\other\\ara.exe' })
    expect((await cliInstallStatus(d)).shadowedBy).toBe('C:\\other\\ara.exe')
  })

  it('PATH 순수 규칙: %VAR% 를 풀어 같은 줄로 본다', () => {
    expect(withPathEntry('%LOCALAPPDATA%\\ARA\\bin', 'C:\\L\\ARA\\bin', { LOCALAPPDATA: 'C:\\L' })).toBeNull()
    expect(withoutPathEntry('a;b', 'c')).toBeNull()
    expect(withPathEntry(null, 'c')).toBe('c')
  })
})

// ── 번들 스킬 ─────────────────────────────────────────────────────────────────

describe('번들 스킬 ara-cli', () => {
  it('저장소 resources/skills/ara-cli 가 원본 — 머리말 name: ara-cli', () => {
    const src = bundledSkillSource([join(tmpdir(), 'nope'), join(__dirname, '..', 'resources')])
    expect(src).not.toBeNull()
    expect(readFileSync(join(src!, 'SKILL.md'), 'utf8')).toMatch(/^---\r?\nname: ara-cli\r?\n/) // autocrlf 체크아웃(OFA-perf)은 CRLF
  })

  it('없음 → [설치] → 최신, 손대면 다름 → [업데이트]가 번들 파일만 덮고 사용자 파일은 남긴다', async () => {
    const home = tmp()
    try {
      const src = bundledSkillSource([join(__dirname, '..', 'resources')])
      const roots = [
        { id: 'home-claude', path: join(home, '.claude', 'skills') },
        { id: 'home-agents', path: join(home, '.agents', 'skills') },
        { id: 'home-codex', path: join(home, '.codex', 'skills') }
      ]
      let s = await bundledSkillStatus(src, roots)
      expect(s.targets.map((x) => [x.rootId, x.state])).toEqual([
        ['home-claude', 'missing'],
        ['home-agents', 'missing']
      ])
      expect(await installBundledSkill(src, roots, 'home-codex')).toEqual({ ok: false, error: '잘못된 대상' })
      const r = await installBundledSkill(src, roots, 'home-claude')
      expect(r.ok).toBe(true)
      s = await bundledSkillStatus(src, roots)
      expect(s.targets[0].state).toBe('installed')
      const dest = join(home, '.claude', 'skills', 'ara-cli')
      writeFileSync(join(dest, 'SKILL.md'), 'old')
      writeFileSync(join(dest, 'mine.md'), 'keep')
      expect((await bundledSkillStatus(src, roots)).targets[0].state).toBe('differs')
      await installBundledSkill(src, roots, 'home-claude')
      expect((await bundledSkillStatus(src, roots)).targets[0].state).toBe('installed')
      expect(readFileSync(join(dest, 'mine.md'), 'utf8')).toBe('keep')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ── 배포 모양 ─────────────────────────────────────────────────────────────────

describe('ara.cmd · installer.nsh · electron-builder', () => {
  const repo = join(__dirname, '..')
  it('ara.cmd: ASCII 만(cmd 는 콘솔 코드 페이지로 읽는다), 인자 없으면 아라 열기, 있으면 ELECTRON_RUN_AS_NODE 로 araCli.js', () => {
    const b = readFileSync(join(repo, 'resources/win32/bin/ara.cmd'))
    expect([...b].every((c) => c < 0x80)).toBe(true)
    const s = b.toString('latin1')
    expect(s).toMatch(/if "%~1"=="" \(\r?\n\s+set "ELECTRON_RUN_AS_NODE="\r?\n\s+start "" "%EXE%"/)
    expect(s).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(s).toContain('app.asar.unpacked\\out\\main\\araCli.js')
  })

  it('제거(업데이트 아님)할 때 사용자 PATH 의 resources\\bin 한 줄을 뺀다', () => {
    const s = readFileSync(join(repo, 'resources/installer.nsh'), 'utf8')
    const un = s.slice(s.indexOf('!macro customUnInstall'))
    const notUpdated = un.slice(un.indexOf('${IfNot} ${isUpdated}'))
    expect(notUpdated).toContain('!insertmacro ARA_REMOVE_USER_PATH_ENTRY "$INSTDIR\\resources\\bin"')
    expect(s).toContain('!macro ARA_REMOVE_USER_PATH_ENTRY DIR')
  })

  it('설치본에 bin/ara.cmd·skills/ara-cli 를 싣고 araCli.js 를 asar 밖으로', () => {
    const s = readFileSync(join(repo, 'electron-builder.yml'), 'utf8')
    expect(s).toContain('to: bin/ara.cmd')
    expect(s).toContain('to: skills/ara-cli')
    expect(s).toContain('- out/main/araCli.js')
    expect(readFileSync(join(repo, 'electron.vite.config.ts'), 'utf8')).toContain("araCli: resolve('src/cli/araCli.ts')")
  })

  it('끌 때 다른 실행(runtimeId 다름)이 쓴 ara-runtime.json 은 두고 간다', async () => {
    const f = fakeDeps()
    server = await startCliServer({ userData, appVersion: '1', handlers: createCliHandlers(f.deps) })
    const path = join(userData, CLI_RUNTIME_FILE)
    const other = { ...JSON.parse(readFileSync(path, 'utf8')), runtimeId: 'someone-else' }
    writeFileSync(path, JSON.stringify(other))
    await server.stop()
    server = null
    expect(existsSync(path)).toBe(true)
  })
})
