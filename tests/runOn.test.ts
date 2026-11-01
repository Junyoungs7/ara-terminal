// M8 R3 DM-04·05 — 실행 위치 판정(Run on), 원격 워크트리 경로·명령 구성(가짜 원격으로). 실제 원격 git 은 managedOrcad.test.ts(WSL 하네스).
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { agentSettingsOf } from '../src/shared/agents'
import type { ManagedRecord } from '../src/shared/managedServers'
import { RUN_ON_LOCAL, projectsOn, remoteAgentSettings, remoteCandidateScript, remoteGitScript, remotePathArg, remoteWorktreePath, runOnHosts, runOnStep, shArg } from '../src/shared/runOn'
import { remoteAddWorktree, remoteRemoveWorktree, type RemoteRun } from '../src/main/managed/remoteWorktrees'

const rec = (hostKey: string, state: ManagedRecord['state'] = 'installed'): ManagedRecord => ({ hostKey, consentedAt: '2026-11-01T00:00:00Z', version: '2.11.0', checkedAt: '2026-11-01T00:00:00Z', state })
const prof = (name: string, host: string, username = 'dev', port = 22) => ({ name, host, username, port })

describe('실행 위치 목록·판정', () => {
  it('프로필 + 동의 기록 → 서버 한 줄씩(같은 hostKey 는 하나), 프로필이 지워진 동의도 남긴다', () => {
    const hosts = runOnHosts([prof('개발1', '10.0.0.5'), prof('개발1-복사', '10.0.0.5'), prof('개발2', '10.0.0.6')], [rec('dev@10.0.0.6:22', 'deferred'), rec('old@10.0.0.9:22')])
    expect(hosts.map((h) => [h.hostKey, h.label, h.consented, h.state])).toEqual([
      ['dev@10.0.0.5:22', '개발1', false, null],
      ['dev@10.0.0.6:22', '개발2', true, 'deferred'],
      ['old@10.0.0.9:22', 'old@10.0.0.9:22', true, 'installed']
    ])
  })

  it('로컬 · 동의 없음 → 동의 화면 · 동의 있음 → 원격 · 모르는 서버', () => {
    const hosts = runOnHosts([prof('a', 'h1'), prof('b', 'h2')], [rec('dev@h2:22')])
    expect(runOnStep(RUN_ON_LOCAL, hosts)).toBe('local')
    expect(runOnStep('dev@h1:22', hosts)).toBe('consent')
    expect(runOnStep('dev@h2:22', hosts)).toBe('remote')
    expect(runOnStep('dev@nowhere:22', hosts)).toBe('unknown')
  })

  it('그 위치의 프로젝트만 — 로컬은 host 없는 것', () => {
    const repos = [{ id: 'l' }, { id: 'r1', host: 'dev@h1:22' }, { id: 'r2', host: 'dev@h2:22' }]
    expect(projectsOn(repos, RUN_ON_LOCAL).map((r) => r.id)).toEqual(['l'])
    expect(projectsOn(repos, 'dev@h2:22').map((r) => r.id)).toEqual(['r2'])
  })

  it('원격 에이전트 설정 — Windows 경로 명령만 비우고 POSIX 명령은 둔다', () => {
    const base = agentSettingsOf(null)
    const win = { ...base, agents: { ...base.agents, claude: { ...base.agents.claude, command: 'C:\\tools\\claude.cmd' } } }
    expect(remoteAgentSettings(win, 'claude').agents.claude.command).toBe('')
    const posix = { ...base, agents: { ...base.agents, claude: { ...base.agents.claude, command: 'npx claude' } } }
    expect(remoteAgentSettings(posix, 'claude')).toBe(posix)
  })
})

describe('원격 워크트리 경로·명령', () => {
  it('Orca 형제 자리 — <부모>/<저장소>-<이름>, .git 꼬리·끝 슬래시 무시', () => {
    expect(remoteWorktreePath('/home/dev/src/shop', 'fix-1')).toBe('/home/dev/src/shop-fix-1')
    expect(remoteWorktreePath('/home/dev/src/shop.git/', 'x')).toBe('/home/dev/src/shop-x')
    expect(remoteWorktreePath('/shop', 'x')).toBe('/shop-x')
  })

  it('사용자 값은 작은따옴표로 — ~ 만 홈으로 편다', () => {
    expect(shArg("it's")).toBe(`'it'\\''s'`)
    expect(remotePathArg('~')).toBe('"$HOME"')
    expect(remotePathArg('~/src/a b')).toBe(`"$HOME"/'src/a b'`)
    expect(remotePathArg('/x/~y')).toBe(`'/x/~y'`)
    expect(remoteGitScript('/r', ['worktree', 'add', '-b', 'a;rm -rf /'])).toBe(`cd -- '/r' && exec git 'worktree' 'add' '-b' 'a;rm -rf /'`)
  })

  // 셸이 있으면 진짜로 펴 본다(Git Bash·Linux) — 따옴표 규칙이 글자 그대로 넘기는지.
  const sh = spawnSync('sh', ['-c', 'echo ok'], { windowsHide: true })
  it.skipIf(sh.status !== 0)('셸이 따옴표를 글자 그대로 받는다', () => {
    const nasty = `a'b"c$(echo x)\`d\`;e`
    const r = spawnSync('sh', ['-c', `printf %s ${shArg(nasty)}`], { windowsHide: true })
    expect(r.stdout.toString()).toBe(nasty)
    const home = spawnSync('sh', ['-c', `printf %s ${remotePathArg('~/q r')}`], { windowsHide: true, env: { ...process.env, HOME: '/h' } })
    expect(home.stdout.toString()).toBe('/h/q r')
  })

  // 가짜 원격: 스크립트 글을 보고 답한다.
  const fake = (answers: (script: string) => { code?: number; out?: string; err?: string }): { run: RemoteRun; scripts: string[] } => {
    const scripts: string[] = []
    return {
      scripts,
      run: async (script) => {
        scripts.push(script)
        const a = answers(script)
        return { code: a.code ?? 0, out: a.out ?? '', err: a.err ?? '' }
      }
    }
  }
  const listing = (extra = ''): string => `worktree /r\nHEAD aaa\nbranch refs/heads/main\n\n${extra}`

  it('이름 고르기 — 브랜치·폴더가 비어 있는 첫 후보(-2)로 --no-track -b 생성 후 목록에서 찾는다', async () => {
    const f = fake((s) => {
      if (s.includes('for-each-ref') && s.includes("'refs/heads/fix'")) return { out: 'branch=1\n' }
      if (s.includes("'worktree' 'list'")) return { out: listing('worktree /r-fix-2\nHEAD bbb\nbranch refs/heads/fix-2\n\n') }
      return {}
    })
    const r = await remoteAddWorktree(f.run, '/r', 'fix')
    expect(r).toMatchObject({ ok: true, branch: 'fix-2', worktree: { path: '/r-fix-2' } })
    expect(f.scripts.find((s) => s.includes("'worktree' 'add'"))).toBe(`cd -- '/r' && exec git 'worktree' 'add' '--no-track' '-b' 'fix-2' '/r-fix-2'`)
  })

  it('분기 지점은 ref 로 확정해 붙이고, add 가 실패하면 반쯤 만든 것을 치운다', async () => {
    const f = fake((s) => {
      if (s.includes("'rev-parse'")) return { code: s.includes('refs/heads/dev^{commit}') ? 0 : 1 }
      if (s.includes("'worktree' 'add'")) return { code: 128, err: 'fatal: boom' }
      return {}
    })
    const r = await remoteAddWorktree(f.run, '/r', 'x', 'dev')
    expect(r).toEqual({ ok: false, reason: 'git', message: 'fatal: boom' })
    expect(f.scripts.find((s) => s.includes("'worktree' 'add'"))).toContain(`'/r-x' 'refs/heads/dev'`)
    const cleanup = f.scripts[f.scripts.length - 1]
    expect(cleanup).toContain(`rm -rf -- '/r-x'`)
    expect(cleanup).toContain(`git branch -D 'x'`)
  })

  it('지우기 — 목록에 있는 연결 워크트리만(본 폴더·모르는 경로 거절)', async () => {
    const f = fake((s) => (s.includes("'worktree' 'list'") ? { out: listing('worktree /r-a\nHEAD c\nbranch refs/heads/a\n\n') } : {}))
    expect(await remoteRemoveWorktree(f.run, '/r', '/r', false)).toEqual({ ok: false, message: '/r' })
    expect(await remoteRemoveWorktree(f.run, '/r', '/etc', true)).toEqual({ ok: false, message: '/etc' })
    expect(await remoteRemoveWorktree(f.run, '/r', '/r-a/', true)).toEqual({ ok: true })
    expect(f.scripts[f.scripts.length - 1]).toBe(`cd -- '/r' && exec git 'worktree' 'remove' '--force' '--' '/r-a'`)
  })

  it('후보 검사 글 — 브랜치(로컬·원격)와 폴더를 한 번에', () => {
    expect(remoteCandidateScript('/r', '/r-a', 'a')).toBe(
      `cd -- '/r' || exit 1; [ -n "$(git 'for-each-ref' '--count=1' '--format=x' 'refs/heads/a' 'refs/remotes/*/a')" ] && echo branch=1; [ -e '/r-a' ] && echo path=1; true`
    )
  })
})
