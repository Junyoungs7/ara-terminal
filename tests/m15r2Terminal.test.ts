// M15 R2 터미널 개선·herdr 2차 — Reset Terminal(TM-03)·macOS 로컬 네트워크(TM-04)·SSH agent 포워딩(TM-05)·
// 복원 파일 백업·스냅샷 회전(TM-06)·여러 서버 묶어 보기(WS-22). 화면·네트워크 없이 도는 것만.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { buildProcessBoundaryGround } from '@shared/terminalModeReset'
import { KEYMAP } from '@shared/keymap'
import { terminalMenu } from '../src/renderer/interactions/actions'
import { normalizeTargetHost, testLocalNetwork } from '../src/main/localNetwork/feature'
import type { RunResult } from '../src/main/util/runProcess'
import { preserveIfCorrupt, readNewestSnapshot, rotateSnapshot, SNAPSHOT_KEEP, SNAPSHOT_EVERY_MS } from '../src/main/workspace/restoreSnapshots'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { localAgentSocket } from '../src/main/sessions/ssh/SshBackend'
import { hostSections, LOCAL_HOST } from '../src/renderer/store/hostSections'
import { buildSidebarRows } from '../src/renderer/features/aiws/sidebarRows'
import { ORCAD_PY } from '../src/main/managed/orcadScript'
import type { ConnectionProfile } from '@shared/types'
import type { Project, Worktree } from '@shared/worktrees'

describe('TM-03 Reset Terminal', () => {
  it('마우스·붙여넣기·대체 화면·커서를 끄고, ConPTY 면 포커스 보고는 남긴다(Orca 와 같은 글)', () => {
    const g = buildProcessBoundaryGround({ keepFocusReporting: false })
    for (const seq of ['\x1b[?1000l', '\x1b[?1006l', '\x1b[?2004l', '\x1b[?1049l', '\x1b[?25h', '\x1b[?1004l', '\x1b[0m']) expect(g).toContain(seq)
    expect(buildProcessBoundaryGround({ keepFocusReporting: true })).not.toContain('\x1b[?1004l')
  })
  it('단축키 Ctrl+Shift+R 은 다른 앱 키와 안 겹치고, 우클릭 메뉴에 힌트와 함께 뜬다', () => {
    const k = KEYMAP.find((b) => b.action === 'terminal.reset')
    expect(k?.win).toBe('Ctrl+Shift+R')
    expect(KEYMAP.filter((b) => b.win === 'Ctrl+Shift+R')).toHaveLength(1)
    const item = terminalMenu().find((m) => m.id === 'terminal.reset')
    expect(item?.hint).toBeTruthy()
  })
})

describe('TM-04 macOS 로컬 네트워크', () => {
  const run = (r: Partial<RunResult>) => async () => ({ code: 0, stdout: '', stderr: '', error: null, ...r })
  it('사설 IP·호스트 이름만 받고 인자 주입·URL·공인 IP·localhost 는 막는다', () => {
    expect(normalizeTargetHost('192.168.0.10')).toBe('192.168.0.10')
    expect(normalizeTargetHost('nas.local')).toBe('nas.local')
    for (const bad of ['-oProxyCommand=x', 'http://a', '8.8.8.8', 'localhost', 'a b', '']) expect(normalizeTargetHost(bad)).toBeNull()
  })
  it('맥이 아니면 시험하지 않는다(Windows 무영향)', async () => {
    expect(await testLocalNetwork({ host: '192.168.0.10', port: 22 }, { platform: 'win32', run: run({}) })).toEqual({ ok: false, failure: 'unsupported' })
  })
  it('맥: 자식 결과를 실패 사유로 읽는다', async () => {
    const mac = { platform: 'darwin' as const }
    expect(await testLocalNetwork({ host: '10.0.0.2', port: 22 }, { ...mac, run: run({}) })).toEqual({ ok: true })
    expect(await testLocalNetwork({ host: '10.0.0.2', port: 22 }, { ...mac, run: run({ code: 1, stderr: 'ECONNREFUSED', error: new Error('x') }) })).toEqual({ ok: false, failure: 'refused' })
    const killed = Object.assign(new Error('t'), { killed: true })
    expect(await testLocalNetwork({ host: '10.0.0.2', port: 22 }, { ...mac, run: run({ code: 1, error: killed }) })).toEqual({ ok: false, failure: 'timeout' })
    expect(await testLocalNetwork({ host: '10.0.0.2', port: 0 }, { ...mac, run: run({}) })).toEqual({ ok: false, failure: 'invalid-target' })
  })
})

describe('TM-05 SSH agent 포워딩', () => {
  it('빌려줄 에이전트: SSH_AUTH_SOCK, 없으면 Windows OpenSSH 파이프, 그 밖엔 없음', () => {
    expect(localAgentSocket({ SSH_AUTH_SOCK: '/tmp/a.sock' }, 'linux')).toBe('/tmp/a.sock')
    expect(localAgentSocket({}, 'win32')).toBe('\\\\.\\pipe\\openssh-ssh-agent')
    expect(localAgentSocket({}, 'darwin')).toBeUndefined()
  })
  it('orcad: 세션은 고정 경로(agent.sock)를, 다리는 연결마다 그 링크를 다시 건다', () => {
    expect(ORCAD_PY).toContain("env['SSH_AUTH_SOCK'] = AGENT")
    expect(ORCAD_PY).toMatch(/def bridge\(\):[\s\S]*?publish_agent\(\)/)
  })
  it('orcad 파이썬 문법(python3 가 있을 때만)', (ctx) => {
    let py = ''
    for (const c of ['python3', 'python']) {
      try {
        execFileSync(c, ['--version'], { stdio: 'ignore', windowsHide: true })
        py = c
        break
      } catch {
        /* 다음 */
      }
    }
    if (!py) return ctx.skip()
    const dir = mkdtempSync(join(tmpdir(), 'orcad-'))
    try {
      const f = join(dir, 'orcad.py')
      writeFileSync(f, ORCAD_PY)
      execFileSync(py, ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', f], { windowsHide: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('TM-06 복원 파일 백업·스냅샷 회전', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))
  const ws = () => {
    dir = mkdtempSync(join(tmpdir(), 'snap-'))
    return join(dir, 'workspace.json')
  }

  it('깨진 본 파일은 backups 에 남기고(최근 3개), 멀쩡하면 안 건드린다', () => {
    const p = ws()
    writeFileSync(p, '{"ok":1}')
    expect(preserveIfCorrupt(p)).toBe(false)
    for (let i = 0; i < 5; i++) {
      writeFileSync(p, '{broken' + i)
      expect(preserveIfCorrupt(p, 1_000_000 + i)).toBe(true)
    }
    const kept = readdirSync(join(dir, 'workspace-backups'))
    expect(kept).toHaveLength(3)
    expect(readFileSync(join(dir, 'workspace-backups', kept.sort().at(-1)!), 'utf8')).toBe('{broken4')
  })

  it('스냅샷은 15분에 한 장, 최대 48장, 가장 최근의 읽히는 것으로 돌아온다', () => {
    const p = ws()
    const t0 = Date.UTC(2026, 10, 2)
    writeFileSync(p, '{"n":0}')
    rotateSnapshot(p, t0)
    writeFileSync(p, '{"n":1}')
    rotateSnapshot(p, t0 + 60_000) // 15분 안 — 건너뜀
    expect(readdirSync(join(dir, 'workspace-snapshots'))).toHaveLength(1)
    for (let i = 1; i <= SNAPSHOT_KEEP + 2; i++) {
      writeFileSync(p, `{"n":${i}}`)
      rotateSnapshot(p, t0 + i * SNAPSHOT_EVERY_MS)
    }
    const names = readdirSync(join(dir, 'workspace-snapshots')).sort()
    expect(names).toHaveLength(SNAPSHOT_KEEP)
    writeFileSync(join(dir, 'workspace-snapshots', names.at(-1)!), '{broken')
    expect(readNewestSnapshot<{ n: number }>(p)).toEqual({ n: SNAPSHOT_KEEP + 1 })
  })

  it('WorkspaceStore: 본 파일·.bak 이 다 깨지면 스냅샷으로 뜨고(서버 목록이 산다), 저장하면 스냅샷이 생긴다', () => {
    const p = ws()
    const a = new WorkspaceStore(p, '0.1.0')
    a.upsertProfile({ id: 'p1', type: 'ssh', name: 'dev', host: '10.0.0.5', port: 22, username: 'u', auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } } })
    expect(readdirSync(join(dir, 'workspace-snapshots')).length).toBeGreaterThan(0)
    writeFileSync(p, '{broken')
    writeFileSync(p + '.bak', '{broken')
    const b = new WorkspaceStore(p, '0.1.0')
    expect(b.getProfiles().map((x) => x.id)).toEqual(['p1'])
    expect(readdirSync(join(dir, 'workspace-backups'))).toHaveLength(1)
  })
})

describe('WS-22 여러 서버 묶어 보기', () => {
  const ssh = (id: string, name: string, host: string, group?: string): ConnectionProfile => ({
    id,
    type: 'ssh',
    name,
    host,
    port: 22,
    username: 'u',
    auth: { type: 'password', secretRef: { store: 'vault', key: id } },
    ...(group ? { group } : {})
  })
  const profiles = [ssh('a', 'web-1', 'w1', '운영'), ssh('b', 'gpu', 'g1', '개발'), ssh('c', 'etc', 'e1')]

  it('로컬이 먼저, 서버는 터미널 사이드바 그룹 순서(끌어 놓은 순서) → 기타, 지운 서버는 끝에', () => {
    const keys = ['u@e1:22', 'u@w1:22', LOCAL_HOST, 'u@g1:22', 'x@gone:22']
    expect(hostSections(keys, profiles, [], { order: ['운영', '개발'] }).map((h) => h.label)).toEqual(['', 'web-1', 'gpu', 'etc', 'x@gone:22'])
    expect(hostSections(keys, profiles).map((h) => h.label)).toEqual(['', 'gpu', 'web-1', 'etc', 'x@gone:22'])
    expect(hostSections(['u@w1:22'], profiles)[0]).toEqual({ key: 'u@w1:22', label: 'web-1', group: '운영' })
  })

  const local: Project = { id: 'api', path: 'C:/api', displayName: 'api', kind: 'git', addedAt: 0 }
  const remote: Project = { id: 'srv', path: '/home/u/srv', displayName: 'srv', kind: 'git', addedAt: 1, host: 'u@w1:22' }
  const wt = (repo: Project): Worktree => ({ id: `${repo.id}::${repo.path}`, repoId: repo.id, path: repo.path, head: 'h', branch: 'refs/heads/main', isBare: false, isMainWorktree: true, displayName: 'main' })
  const base = { repos: [local, remote], worktreesByRepo: { api: [wt(local)], srv: [wt(remote)] }, pending: [], pinnedIds: [], query: '', groupBy: 'repo' as const }

  it('호스트가 둘 이상이면 호스트 머리줄 아래 그 호스트의 프로젝트, 접으면 머리줄만', () => {
    const hosts = hostSections([LOCAL_HOST, 'u@w1:22'], profiles)
    const rows = buildSidebarRows({ ...base, hosts })
    expect(rows.map((r) => r.key)).toEqual(['host:local', 'local|repo:api', 'local|repo:api|api::C:/api', 'host:u@w1:22', 'u@w1:22|repo:srv', 'u@w1:22|repo:srv|srv::/home/u/srv'])
    const folded = buildSidebarRows({ ...base, hosts, collapsedHosts: ['u@w1:22'] })
    expect(folded.map((r) => r.key).slice(-1)).toEqual(['host:u@w1:22'])
  })

  it('호스트가 하나뿐이면 예전 줄 그대로(머리줄 없음)', () => {
    const rows = buildSidebarRows({ ...base, repos: [local], hosts: hostSections([LOCAL_HOST], profiles) })
    expect(rows[0].key).toBe('repo:api')
  })
})
