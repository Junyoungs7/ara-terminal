// M9 R2 Oriel 연동 — 감지(version JSON)·후보 자리·에이전트별 실행 인자/env(사용자 설정 파일 안 씀)·링크 열기(Oriel → 실패면 OS 브라우저).
// 진짜 Oriel 을 띄우지 않는다: run 을 바꿔 끼우고, 가짜 Oriel 폴더는 임시 폴더.
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORIEL_INSTRUCTIONS, orielCandidates, orielGeminiDefaults, orielLaunch, orielMcpServers, parseOrielVersion, pickOriel, type OrielRunner } from '../src/shared/oriel'
import { createServer, type Server } from 'node:net'
import { araOrielRunner, createOriel, FOREGROUND_SCRIPT, orielAppDir, orielControlFile, orielKindOf, orielPipeRequest, standaloneOrielExe } from '../src/main/oriel/oriel'
import { defaultAgentSettings, planAgentLaunch } from '../src/shared/agents'
import type { RunResult } from '../src/main/util/runProcess'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ara-oriel-'))
  dirs.push(d)
  return d
}

/** 가짜 Oriel 설치(bin/oriel.mjs·electron 자리만 — 실행하지 않는다). */
function fakeOriel(): { dir: string; versionJson: string } {
  const dir = tmp()
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'oriel.mjs'), '')
  writeFileSync(join(dir, 'electron.exe'), '')
  const versionJson = JSON.stringify({ version: '0.1.0', appPath: dir, electronPath: join(dir, 'electron.exe'), cliPath: join(dir, 'bin', 'oriel.mjs'), pipe: '\\\\.\\pipe\\oriel-x', dataDir: dir, running: false })
  return { dir, versionJson }
}
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', error: null })
const failed = (code = 2): RunResult => ({ code, stdout: '', stderr: 'usage', error: new Error(`exit ${code}`) })

describe('감지 규칙', () => {
  it('version JSON 파싱 — 필요한 칸이 없거나 JSON 이 아니면 null', () => {
    expect(parseOrielVersion(JSON.stringify({ version: '0.1.0', appPath: 'D:/a', electronPath: 'D:/a/e.exe', cliPath: 'D:/a/bin/oriel.mjs', running: true, pid: 3 }))).toEqual({
      version: '0.1.0',
      appPath: 'D:/a',
      electronPath: 'D:/a/e.exe',
      cliPath: 'D:/a/bin/oriel.mjs',
      running: true,
      pid: 3 // OR-3 — 여러 Oriel 중 떠 있는 것을 가릴 때
    })
    expect(parseOrielVersion('{"version":"0.1.0","appPath":"D:/a"}')).toBeNull()
    expect(parseOrielVersion('Usage: oriel ...')).toBeNull()
  })
  it('후보 — 설정값이 있으면 그것만, 없으면 단독 설치본(Programs/Oriel) → 개발 PC 체크아웃(UB-1: 아라 동봉 자리 없음)', () => {
    expect(orielCandidates(' E:/tools/oriel ', 'C:\\Users\\u\\AppData\\Local')).toEqual(['E:/tools/oriel'])
    expect(orielCandidates('', null)).toEqual(['D:/AI/ai-browser'])
    expect(orielCandidates('', 'C:\\Users\\u\\AppData\\Local')).toEqual(['C:/Users/u/AppData/Local/Programs/Oriel/resources/app', 'D:/AI/ai-browser'])
  })
})

describe('에이전트별 Oriel 전용 MCP(실행 인자·env 만 — 사용자 설정 파일 안 씀)', () => {
  const files: Record<string, string> = {}
  const write = (name: string, ext: string, body: string): string => {
    const p = `C:/h/.ara/agent-launch/${name}.${ext}`
    files[p] = body
    return p
  }
  it('Claude — --mcp-config(더하기, strict 아님) + --append-system-prompt-file', () => {
    const o = orielLaunch('claude', 'D:\\AI\\ai-browser\\bin\\oriel.mjs', write)
    expect(o.args).toEqual(['--mcp-config', 'C:/h/.ara/agent-launch/oriel-mcp.json', '--append-system-prompt-file', 'C:/h/.ara/agent-launch/oriel-instructions.md'])
    expect(o.args).not.toContain('--strict-mcp-config')
    expect(JSON.parse(files['C:/h/.ara/agent-launch/oriel-mcp.json'])).toEqual({ mcpServers: { oriel: { type: 'stdio', command: 'node', args: ['D:/AI/ai-browser/bin/oriel.mjs', 'mcp', '--launch'] } } })
    expect(files['C:/h/.ara/agent-launch/oriel-instructions.md']).toContain('finish()')
  })
  it('실행 env(ORIEL_AGENT_LABEL — 브라우저에 보일 세션 이름)가 세 CLI 의 MCP 서버 env 로 그대로 간다', () => {
    const runner = { command: 'C:/A/ARA.exe', env: { ELECTRON_RUN_AS_NODE: '1', ORIEL_AGENT_LABEL: '아라 · Claude Code · OFA' } }
    orielLaunch('claude', 'D:/o/bin/oriel.mjs', write, runner)
    expect(JSON.parse(files['C:/h/.ara/agent-launch/oriel-mcp.json']).mcpServers.oriel.env).toEqual(runner.env)
    expect(orielLaunch('codex', 'D:/o/bin/oriel.mjs', write, runner).args).toContain("mcp_servers.oriel.env={ELECTRON_RUN_AS_NODE='1',ORIEL_AGENT_LABEL='아라 · Claude Code · OFA'}")
    expect(orielGeminiDefaults('D:/o/bin/oriel.mjs', runner).mcpServers.oriel.env).toEqual(runner.env)
  })
  it('Codex — -c 덮어쓰기(TOML 리터럴 문자열), 경로에 작은따옴표가 있으면 붙이지 않음', () => {
    const o = orielLaunch('codex', 'D:/AI/ai-browser/bin/oriel.mjs', write)
    expect(o.args).toEqual([
      '-c',
      "mcp_servers.oriel.command='node'",
      '-c',
      "mcp_servers.oriel.args=['D:/AI/ai-browser/bin/oriel.mjs','mcp','--launch']",
      '-c',
      'mcp_servers.oriel.tool_timeout_sec=120',
      '-c',
      `developer_instructions='${ORIEL_INSTRUCTIONS}'`
    ])
    expect(ORIEL_INSTRUCTIONS).not.toMatch(/['"\r\n]/)
    expect(orielLaunch('codex', "D:/it's/bin/oriel.mjs", write).args).toEqual([])
  })
  it('Gemini — env GEMINI_CLI_SYSTEM_DEFAULTS_PATH(가장 낮은 층, mcpServers shallow_merge)', () => {
    const o = orielLaunch('gemini', 'D:/AI/ai-browser/bin/oriel.mjs', write)
    expect(o.args).toEqual([])
    expect(JSON.parse(files[o.env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']])).toEqual({ mcpServers: { oriel: { command: 'node', args: orielMcpServers('D:/AI/ai-browser/bin/oriel.mjs').mcpServers.oriel.args } } })
  })
  it('실행 한 줄 — 접두 인자 바로 뒤에 붙고, 재개에도 붙는다(PowerShell·posix 인용)', () => {
    const s = defaultAgentSettings()
    const claude = orielLaunch('claude', 'D:/o/bin/oriel.mjs', write)
    const p = planAgentLaunch({ agent: 'claude', settings: s, shell: 'powershell', extraArgs: claude.args })
    expect(p.ok && p.line).toBe('& claude --mcp-config C:/h/.ara/agent-launch/oriel-mcp.json --append-system-prompt-file C:/h/.ara/agent-launch/oriel-instructions.md --dangerously-skip-permissions')
    const r = planAgentLaunch({ agent: 'claude', settings: s, shell: 'powershell', extraArgs: claude.args, resume: 'abc' })
    expect(r.ok && r.line).toBe('& claude --mcp-config C:/h/.ara/agent-launch/oriel-mcp.json --append-system-prompt-file C:/h/.ara/agent-launch/oriel-instructions.md --resume abc')
    const codex = planAgentLaunch({ agent: 'codex', settings: s, shell: 'posix', extraArgs: orielLaunch('codex', 'D:/o/bin/oriel.mjs', write).args, resume: 'id1' })
    expect(codex.ok && codex.line).toContain(`-c 'mcp_servers.oriel.args=['\\''D:/o/bin/oriel.mjs'\\'','\\''mcp'\\'','\\''--launch'\\'']' -c`)
    expect(codex.ok && codex.line.endsWith(' resume id1')).toBe(true)
    const gem = planAgentLaunch({ agent: 'gemini', settings: s, shell: 'powershell', extraEnv: orielLaunch('gemini', 'D:/o/bin/oriel.mjs', write).env })
    expect(gem.ok && gem.env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']).toBe('C:/h/.ara/agent-launch/oriel-gemini.json')
  })
})

describe('createOriel — 감지·링크 열기', () => {
  it('설치됨: version 으로 찾고(기억), open 은 `oriel open <url>` — 성공이면 Oriel, 실패면 OS 브라우저', async () => {
    const { dir, versionJson } = fakeOriel()
    const calls: string[][] = []
    let openResult: RunResult = ok('')
    const external: string[] = []
    const o = createOriel({
      candidates: () => [join(tmp(), 'none'), dir],
      openExternal: async (u) => void external.push(u),
      run: async (file, args) => {
        calls.push([file, ...args])
        return args[1] === 'version' ? ok(versionJson) : openResult
      }
    })
    const s = await o.status()
    expect(s.installed && s.info.version).toBe('0.1.0')
    await o.status()
    expect(calls.filter((c) => c[2] === 'version')).toHaveLength(1) // 기억한다
    expect(await o.open('http://localhost:8000')).toBe('oriel')
    expect(calls.at(-1)).toEqual(['node', join(dir, 'bin', 'oriel.mjs'), 'open', 'http://localhost:8000'])
    openResult = failed()
    expect(await o.open('https://example.com/a')).toBe('external')
    expect(external).toEqual(['https://example.com/a'])
    expect(await o.open('file:///C:/Windows/win.ini')).toBe(false)
    expect(external).toHaveLength(1)
    await o.status(true)
    expect(calls.filter((c) => c[2] === 'version')).toHaveLength(2) // [다시 찾기]
  })

  it('Oriel 이 open-theme 을 지원하면 아라 테마(다크)를 --theme 으로 넘긴다 — 옛 Oriel 엔 안 붙인다(위 시험)', async () => {
    const { dir, versionJson } = fakeOriel()
    const withCaps = JSON.stringify({ ...JSON.parse(versionJson), capabilities: ['open-theme', 'theme'] })
    const calls: string[][] = []
    const o = createOriel({
      candidates: () => [dir],
      openExternal: async () => {},
      run: async (file, args) => {
        calls.push([file, ...args])
        return args[1] === 'version' ? ok(withCaps) : ok('')
      }
    })
    expect(await o.open('http://localhost:8000')).toBe('oriel')
    expect(calls.at(-1)).toEqual(['node', join(dir, 'bin', 'oriel.mjs'), 'open', 'http://localhost:8000', '--theme', 'dark'])
  })
  it('미설치(자리 없음·version 실패·electron 없음) → installed:false, 링크는 OS 브라우저, Oriel 을 부르지 않는다', async () => {
    const { dir } = fakeOriel()
    const noElectron = fakeOriel()
    rmSync(join(noElectron.dir, 'electron.exe'))
    const calls: string[][] = []
    const external: string[] = []
    const o = createOriel({
      candidates: () => [join(tmp(), 'none'), dir, noElectron.dir],
      openExternal: async (u) => void external.push(u),
      run: async (file, args) => {
        calls.push([file, ...args])
        return args[0].startsWith(dir) ? failed(1) : ok(noElectron.versionJson)
      }
    })
    const s = await o.status()
    expect(s.installed).toBe(false)
    expect(!s.installed && s.tried).toHaveLength(3)
    expect(await o.open('http://localhost:3000')).toBe('external')
    expect(external).toEqual(['http://localhost:3000'])
    expect(calls.some((c) => c.includes('open'))).toBe(false)
  })
})

describe('OR-1 — runner·링크 포커스·file:/UNC', () => {
  it('version·open 은 runner(실행 파일·env) 그대로 — 에이전트 MCP 설정(Claude·Codex·Gemini)도 같은 runner', async () => {
    const { dir, versionJson } = fakeOriel()
    const runner: OrielRunner = { command: 'C:/ARA/electron.exe', env: { ELECTRON_RUN_AS_NODE: '1' } }
    const seen: [string, Record<string, string> | undefined][] = []
    const o = createOriel({
      candidates: () => [dir],
      openExternal: async () => {},
      runner: (d) => (d === dir ? runner : { command: 'x', env: {} }),
      platform: 'linux',
      run: async (f, args, opts) => {
        seen.push([f, opts?.env])
        return args[1] === 'version' ? ok(versionJson) : ok('')
      }
    })
    await o.open('http://localhost:1')
    expect(seen).toEqual([
      [runner.command, runner.env],
      [runner.command, runner.env]
    ])
    const s = await o.status()
    expect(s.installed && s.runner).toEqual(runner)
    const files: Record<string, string> = {}
    const write = (name: string, ext: string, body: string): string => ((files[name] = body), `C:/h/${name}.${ext}`)
    orielLaunch('claude', 'D:/o/bin/oriel.mjs', write, runner)
    expect(JSON.parse(files['oriel-mcp']).mcpServers.oriel).toEqual({ type: 'stdio', command: 'C:/ARA/electron.exe', args: ['D:/o/bin/oriel.mjs', 'mcp', '--launch'], env: runner.env })
    expect(orielLaunch('codex', 'D:/o/bin/oriel.mjs', write, runner).args).toEqual(
      expect.arrayContaining(["mcp_servers.oriel.command='C:/ARA/electron.exe'", "mcp_servers.oriel.env={ELECTRON_RUN_AS_NODE='1'}"])
    )
    expect(orielLaunch('codex', 'D:/o/bin/oriel.mjs', write, { command: "C:/it's/ARA.exe", env: {} }).args).toEqual([])
    expect(orielLaunch('codex', 'D:/o/bin/oriel.mjs', write, { command: 'C:/ARA.exe', env: { X: "C:/it's/ARA.exe" } }).args).toEqual([])
    orielLaunch('gemini', 'D:/o/bin/oriel.mjs', write, runner)
    expect(JSON.parse(files['oriel-gemini']).mcpServers.oriel).toEqual({ command: 'C:/ARA/electron.exe', args: ['D:/o/bin/oriel.mjs', 'mcp', '--launch'], env: runner.env })
  })
  it('★ 전경 허락 PowerShell 은 사용자 동작({gesture})일 때만, open 과 동시에(기다리지 않음) — MCP·에이전트 경로(인자 없음)는 절대 안 부른다', async () => {
    const { dir, versionJson } = fakeOriel()
    const calls: string[] = []
    const o = createOriel({
      candidates: () => [dir],
      openExternal: async () => {},
      platform: 'win32',
      run: async (file, args) => {
        if (file.endsWith('powershell.exe')) {
          calls.push('ps:start')
          await new Promise((r) => setTimeout(r, 20))
          calls.push(`ps:end:${args.at(-1) === FOREGROUND_SCRIPT}`)
          return ok('')
        }
        calls.push(args[1])
        return args[1] === 'version' ? ok(versionJson) : ok('')
      }
    })
    await o.open('http://localhost:1') // MCP oriel_open 과 같은 부름
    expect(calls.some((c) => c.startsWith('ps:'))).toBe(false)
    calls.length = 0
    await o.open('http://localhost:2', { gesture: true })
    expect(calls).toEqual(['ps:start', 'open']) // open 이 PowerShell 끝을 기다리지 않는다
    await new Promise((r) => setTimeout(r, 40))
    expect(calls).toEqual(['ps:start', 'open', 'ps:end:true'])
    expect(FOREGROUND_SCRIPT).toContain('AllowSetForegroundWindow(-1)')
  })
  it('MCP oriel_open 은 사용자 동작 표시 없이 부른다(tools.ts) — IPC oriel:open 만 gesture', () => {
    const tools = readFileSync(join(__dirname, '../src/main/mcp/tools.ts'), 'utf8')
    expect(tools).toMatch(/ctx\.oriel\.open\(url\)/)
    expect(tools).not.toMatch(/gesture/)
    expect(readFileSync(join(__dirname, '../src/main/oriel/feature.ts'), 'utf8')).toMatch(/oriel\.open\([^)]*\{ gesture: true \}\)/)
  })
  it('file:·호스트 있는 file:·UNC 는 Oriel 에도 OS 에도 안 넘긴다(NTLM 유출)', async () => {
    const { dir, versionJson } = fakeOriel()
    const calls: string[][] = []
    const external: string[] = []
    const o = createOriel({ candidates: () => [dir], openExternal: async (u) => void external.push(u), run: async (f, a) => (calls.push([f, ...a]), ok(versionJson)) })
    for (const u of ['file://server/share/a.txt', '\\\\server\\share\\a.txt', 'file:///C:/a.txt', 'file://localhost/C:/a.txt']) expect(await o.open(u, { gesture: true })).toBe(false)
    expect(calls).toEqual([])
    expect(external).toEqual([])
  })
})

describe('UB-1 — Oriel 동봉 없음: CLI 는 아라 Electron + ELECTRON_RUN_AS_NODE, 앱은 Oriel 이 정한 Electron', () => {
  it('araOrielRunner — 단독판이 아니면 아라 Electron + ELECTRON_RUN_AS_NODE 만(다른 env 안 넣음)', () => {
    expect(araOrielRunner('D:/AI/ai-browser', 'C:/ARA/A.R.A.exe', () => false)).toEqual({ command: 'C:/ARA/A.R.A.exe', env: { ELECTRON_RUN_AS_NODE: '1' } })
  })
  it('진입점은 index(호스트 모드 boot 없음)', () => {
    expect(JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')).main).toBe('./out/main/index.js')
    expect(existsSync(join(__dirname, '../src/main/boot.ts'))).toBe(false)
  })
  const electron = join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  const cli = 'D:/AI/ai-browser/bin/oriel.mjs'
  it.runIf(process.platform === 'win32' && existsSync(electron) && existsSync(cli))('★ 실제: 아라 Electron + ELECTRON_RUN_AS_NODE 로 `oriel.mjs version`(창 없음·읽기 전용)', async () => {
    const { runProcess } = await import('../src/main/util/runProcess')
    const runner = araOrielRunner('D:/AI/ai-browser', electron)
    const r = await runProcess(runner.command, [cli, 'version'], { timeoutMs: 20_000, env: runner.env })
    expect(r.error).toBeNull()
    expect(parseOrielVersion(r.stdout)?.cliPath.replace(/\\/g, '/')).toBe(cli)
  }, 30_000)
})

// r1-fix: AG-1·VAULT-1 이 깨졌을 때 첫 의심이 "--settings 경로가 PowerShell `&` 호출에서 깨진다"였다(실제 원인은 줄 접힘 — 시험 쪽).
// 사용자 홈에 공백·한글이 있어도 그 줄이 진짜 PowerShell 5.1 → npm 식 .cmd 셔임(%*) 을 지나 CLI 에 인자 그대로 닿는지 고정한다.
describe.runIf(process.platform === 'win32')('실행 한 줄을 진짜 PowerShell 로 — --settings 경로(공백·한글)', () => {
  it('★ .cmd 셔임 뒤 CLI 가 받는 argv 가 계획과 같다(새 실행·재개)', async () => {
    const { runProcess } = await import('../src/main/util/runProcess')
    const dir = tmp()
    const js = join(dir, 'argv.cjs')
    writeFileSync(js, "process.stdout.write(JSON.stringify(process.argv.slice(2)))")
    const cmd = join(dir, 'claude.cmd')
    writeFileSync(cmd, ['@echo off', `node "${js}" %*`, ''].join('\r\n'))
    mkdirSync(join(dir, '홍 길동'))
    const settingsFile = join(dir, '홍 길동', 'claude-settings-abc.json')
    const s = defaultAgentSettings()
    s.agents.claude = { ...s.agents.claude, command: cmd }
    for (const resume of [undefined, 'abc-123']) {
      const p = planAgentLaunch({ agent: 'claude', settings: s, shell: 'powershell', extraArgs: ['--settings', settingsFile], ...(resume ? { resume } : {}) })
      if (!p.ok) throw new Error('plan failed')
      const r = await runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', p.line], { timeoutMs: 20_000 })
      expect(JSON.parse(r.stdout.trim())).toEqual(['--settings', settingsFile, ...(resume ? ['--resume', resume] : ['--dangerously-skip-permissions'])])
    }
  }, 60_000)
})

/** OR-3 가짜 단독 설치본 `<root>/Oriel.exe` + `<root>/resources/app/bin/oriel.mjs`(실행하지 않는다). */
function fakeStandalone(): { root: string; app: string; exe: string; versionJson: (running?: boolean, pid?: number) => string } {
  const root = tmp()
  const app = join(root, 'resources', 'app')
  mkdirSync(join(app, 'bin'), { recursive: true })
  writeFileSync(join(app, 'bin', 'oriel.mjs'), '')
  const exe = join(root, 'Oriel.exe')
  writeFileSync(exe, '')
  const versionJson = (running = false, pid?: number): string =>
    JSON.stringify({ version: '0.1.0', appPath: app, electronPath: exe, cliPath: join(app, 'bin', 'oriel.mjs'), running, ...(pid ? { pid } : {}) })
  return { root, app, exe, versionJson }
}

describe('OR-3 — Oriel 단독 설치본 감지·우선순위(실행 중 > 단독 > dev)', () => {
  it('단독 설치본 판별·설치 폴더 → resources/app·종류', () => {
    const sa = fakeStandalone()
    expect(standaloneOrielExe(sa.app)).toBe(sa.exe)
    expect(standaloneOrielExe(sa.root)).toBeNull()
    expect(orielAppDir(sa.root)).toBe(sa.app) // 설정 칸에 설치 폴더를 적어도
    expect(orielAppDir(sa.app)).toBe(sa.app)
    const { dir } = fakeOriel()
    expect(orielAppDir(dir)).toBe(dir)
    expect(orielKindOf(sa.app)).toBe('standalone')
    expect(orielKindOf(dir)).toBe('dev')
  })
  it('★ 단독판 runner = 자기 Oriel.exe + ELECTRON_RUN_AS_NODE 만(아라 Electron 아님) → MCP 설정 세 에이전트도', () => {
    const sa = fakeStandalone()
    const runner = araOrielRunner(sa.app, 'C:/ARA/A.R.A.exe')
    expect(runner).toEqual({ command: sa.exe, env: { ELECTRON_RUN_AS_NODE: '1' } })
    const cli = join(sa.app, 'bin', 'oriel.mjs').replace(/\\/g, '/')
    const files: Record<string, string> = {}
    const write = (name: string, ext: string, body: string): string => ((files[name] = body), `C:/h/${name}.${ext}`)
    orielLaunch('claude', cli, write, runner)
    expect(JSON.parse(files['oriel-mcp']).mcpServers.oriel).toEqual({ type: 'stdio', command: sa.exe, args: [cli, 'mcp', '--launch'], env: { ELECTRON_RUN_AS_NODE: '1' } })
    expect(orielLaunch('codex', cli, write, runner).args).toEqual(
      expect.arrayContaining([`mcp_servers.oriel.command='${sa.exe}'`, `mcp_servers.oriel.args=['${cli}','mcp','--launch']`, "mcp_servers.oriel.env={ELECTRON_RUN_AS_NODE='1'}"])
    )
    orielLaunch('gemini', cli, write, runner)
    expect(JSON.parse(files['oriel-gemini']).mcpServers.oriel).toEqual({ command: sa.exe, args: [cli, 'mcp', '--launch'], env: { ELECTRON_RUN_AS_NODE: '1' } })
  })
  it('pickOriel — 실행 중 실행 파일과 electronPath 가 같은 것(대소문자·구분자 무시) > 후보 순서', () => {
    const a = { info: parseOrielVersion(JSON.stringify({ version: '1', appPath: 'a', electronPath: 'C:\\S\\Oriel.exe', cliPath: 'c' }))! }
    const b = { info: parseOrielVersion(JSON.stringify({ version: '1', appPath: 'b', electronPath: 'D:/dev/electron.exe', cliPath: 'c' }))! }
    expect(pickOriel([a, b], null)).toBe(a)
    expect(pickOriel([a, b], 'd:\\DEV\\electron.exe')).toBe(b)
    expect(pickOriel([a, b], 'C:/other.exe')).toBe(a)
    expect(pickOriel([], null)).toBeNull()
  })
  it('★ createOriel — 단독판·dev 둘이 다 있으면 단독판, 떠 있는 게 dev 면 dev(그 pid 의 실행 파일로 가림), 하나뿐이면 프로세스를 묻지 않는다', async () => {
    const sa = fakeStandalone()
    const other = fakeOriel()
    const dev = fakeOriel()
    const devExe = join(dev.dir, 'electron.exe')
    const kinds: Record<string, 'standalone' | 'dev'> = { [sa.app]: 'standalone', [other.dir]: 'dev', [dev.dir]: 'dev' }
    let running: number | null = null
    const asked: number[] = []
    const make = (cands: string[]) =>
      createOriel({
        candidates: () => cands,
        openExternal: async () => {},
        kindOf: (d) => kinds[d] ?? 'dev',
        runner: (d) => araOrielRunner(d, 'C:/ARA/electron.exe'),
        processPath: async (pid) => (asked.push(pid), pid === 77 ? devExe : null),
        run: async (_f, args) => {
          const cli = args[0]
          const r = running !== null
          if (cli.startsWith(sa.app)) return ok(sa.versionJson(r, running ?? undefined))
          const d = cli.startsWith(other.dir) ? other : dev
          return ok(JSON.stringify({ ...JSON.parse(d.versionJson), running: r, ...(running ? { pid: running } : {}) }))
        }
      })
    // 꺼져 있음: 후보 순서(단독 > dev)
    let s = await make([sa.root, other.dir, dev.dir]).status()
    expect(s.installed && [s.kind, s.info.appPath, s.runner.command]).toEqual(['standalone', sa.app, sa.exe])
    expect(asked).toEqual([])
    // dev 가 떠 있음(pid 77 → dev 의 electron.exe): 실행 중인 것이 먼저
    running = 77
    s = await make([sa.app, other.dir, dev.dir]).status()
    expect(s.installed && [s.kind, s.info.appPath]).toEqual(['dev', dev.dir])
    expect(asked).toEqual([77])
    // 떠 있는데 어느 판인지 모름 → 후보 순서
    running = 5
    s = await make([sa.app, other.dir, dev.dir]).status()
    expect(s.installed && s.kind).toBe('standalone')
    // 경로 고정(후보 하나) — 묻지 않는다
    asked.length = 0
    s = await make([other.dir]).status()
    expect(s.installed && s.info.appPath).toBe(other.dir)
    expect(asked).toEqual([])
  })
})

// Oriel 0.1.4+ 직접 경로 — 가짜 named pipe 서버(진짜 Oriel 아님). 줄 단위 JSON, 연결 하나에 요청 하나.
describe('Oriel 직접 경로(파이프) — CLI 프로세스 없이 즉시', () => {
  const TOKEN = 'deadbeefcafe0123456789'
  const servers: Server[] = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.close()
  })
  const pipeName = (): string =>
    process.platform === 'win32' ? `\\\\.\\pipe\\ara-oriel-test-${process.pid}-${Math.random().toString(36).slice(2)}` : join(tmp(), 'p.sock')
  /** reply(요청) → 답(객체) | 'hang'(답 안 함) | 'close'(답 없이 닫음). 받은 요청을 기록한다. */
  async function fakePipe(reply: (req: Record<string, unknown>) => Record<string, unknown> | 'hang' | 'close'): Promise<{ pipe: string; got: Record<string, unknown>[] }> {
    const pipe = pipeName()
    const got: Record<string, unknown>[] = []
    const srv = createServer((sock) => {
      let buf = ''
      sock.setEncoding('utf8')
      sock.on('data', (d: string) => {
        buf += d
        if (!buf.includes('\n')) return
        const req = JSON.parse(buf.slice(0, buf.indexOf('\n')))
        got.push(req)
        const r = reply(req)
        if (r === 'close') sock.destroy()
        else if (r !== 'hang') sock.end(JSON.stringify(r) + '\n')
      })
      sock.on('error', () => {})
    })
    servers.push(srv)
    await new Promise<void>((res) => srv.listen(pipe, res))
    return { pipe, got }
  }
  const control = (pipe: string, token = TOKEN): string => {
    const f = join(tmp(), 'control.json')
    writeFileSync(f, JSON.stringify({ pipe, token }))
    return f
  }
  const answer = (req: Record<string, unknown>): Record<string, unknown> =>
    req['token'] !== TOKEN ? { t: 'error', error: 'unauthorized' } : req['op'] === 'theme' ? { t: 'themed', ok: true } : { t: 'opened', ok: true }
  /** CLI·OS 브라우저 호출을 기록하는 Oriel(설치됨, open-theme 지원). */
  function make(controlFile: string | null) {
    const { dir, versionJson } = fakeOriel()
    const withCaps = JSON.stringify({ ...JSON.parse(versionJson), capabilities: ['open-theme'] })
    const cli: string[][] = []
    const external: string[] = []
    const o = createOriel({
      candidates: () => [dir],
      openExternal: async (u) => void external.push(u),
      platform: 'linux',
      controlFile,
      run: async (_f, args) => (cli.push(args.slice(1)), args[1] === 'version' ? ok(withCaps) : ok(''))
    })
    return { o, cli, external }
  }

  it('토큰 파일 자리 = %APPDATA%\\oriel\\control.json(아라 userData 아님), APPDATA 없으면 null', () => {
    expect(orielControlFile('C:\\Users\\u\\AppData\\Roaming')).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'oriel', 'control.json'))
    expect(orielControlFile('')).toBeNull()
  })
  it('★ 열림 — 파이프로 theme(처음 한 번만)·open, CLI 는 안 뜬다(version 감지도 안 함)', async () => {
    const { pipe, got } = await fakePipe(answer)
    const { o, cli, external } = make(control(pipe))
    expect(await o.open('https://example.com/a')).toBe('oriel')
    expect(await o.open('https://example.com/b')).toBe('oriel')
    expect(got).toEqual([
      { token: TOKEN, op: 'theme', theme: 'dark' },
      { token: TOKEN, op: 'open', url: 'https://example.com/a' },
      { token: TOKEN, op: 'open', url: 'https://example.com/b' }
    ])
    expect(cli).toEqual([])
    expect(external).toEqual([])
  })
  it('ok:false → OS 브라우저(CLI 종료 코드 1·2 와 같은 결과), CLI 로 다시 안 연다', async () => {
    const { pipe } = await fakePipe((req) => (req['op'] === 'theme' ? { t: 'themed', ok: true } : { t: 'opened', ok: false, error: 'blocked' }))
    const { o, cli, external } = make(control(pipe))
    expect(await o.open('https://example.com/x')).toBe('external')
    expect(external).toEqual(['https://example.com/x'])
    expect(cli).toEqual([])
  })
  it('Oriel 꺼짐(ENOENT) → 바로 CLI `open --theme`(CLI 가 켜고 연다) / 토큰 파일 없음 → 지금 동작 그대로', async () => {
    const a = make(control(pipeName()))
    expect(await a.o.open('https://example.com/c')).toBe('oriel')
    expect(a.cli.at(-1)).toEqual(['open', 'https://example.com/c', '--theme', 'dark'])
    const b = make(join(tmp(), 'none', 'control.json'))
    expect(await b.o.open('https://example.com/d')).toBe('oriel')
    expect(b.cli.map((c) => c[0])).toEqual(['version', 'open'])
    const c = make(null)
    expect(await c.o.open('https://example.com/e')).toBe('oriel')
    expect(c.cli.at(-1)?.[0]).toBe('open')
  })
  it('★ 인증 실패 → 토큰 파일을 다시 읽고 한 번 더(Oriel 이 다시 켜져 새 토큰), 두 번째도 실패면 CLI', async () => {
    let file = ''
    const { pipe, got } = await fakePipe((req) => {
      if (req['token'] !== TOKEN) writeFileSync(file, JSON.stringify({ pipe, token: TOKEN })) // 그 사이 Oriel 이 새 토큰을 씀
      return answer(req)
    })
    file = control(pipe, 'stale')
    const { o, cli } = make(file)
    expect(await o.open('https://example.com/f')).toBe('oriel')
    expect(got.map((g) => g['token'] === TOKEN)).toEqual([false, true, true])
    expect(cli).toEqual([])
    const bad = await fakePipe(() => ({ t: 'error', error: 'unauthorized' }))
    const m = make(control(bad.pipe, 'stale'))
    expect(await m.o.open('https://example.com/g')).toBe('oriel')
    expect(bad.got).toHaveLength(2) // 한 번 더까지만
    expect(m.cli.at(-1)?.[0]).toBe('open')
  })
  it('시간 초과(답 없음) → 상한(1.5초)에서 끊고 CLI', async () => {
    const { pipe } = await fakePipe(() => 'hang')
    const { o, cli } = make(control(pipe))
    const t0 = Date.now()
    expect(await o.open('https://example.com/h')).toBe('oriel')
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(cli.at(-1)).toEqual(['open', 'https://example.com/h', '--theme', 'dark'])
  }, 10_000)
  it('테마가 실패하면 다음에 다시 보낸다(성공해야 기억)', async () => {
    let themeOk = false
    const { pipe, got } = await fakePipe((req) => (req['op'] === 'theme' ? { t: 'themed', ok: themeOk } : { t: 'opened', ok: true }))
    const { o } = make(control(pipe))
    await o.open('https://example.com/1')
    themeOk = true
    await o.open('https://example.com/2')
    await o.open('https://example.com/3')
    expect(got.map((g) => g['op'])).toEqual(['theme', 'open', 'theme', 'open', 'open'])
  })
  it('★ 토큰은 오류에 안 섞인다(시간 초과·닫힘·꺼짐)', async () => {
    const hang = await fakePipe(() => 'hang')
    const close = await fakePipe(() => 'close')
    const errs: unknown[] = []
    for (const pipe of [hang.pipe, close.pipe, pipeName()]) await orielPipeRequest({ pipe, token: TOKEN }, { op: 'pid' }, 200).catch((e) => errs.push(e))
    expect(errs.map((e) => (e as { code: string }).code)).toEqual(['ETIMEDOUT', 'ECLOSED', 'ENOENT'])
    for (const e of errs) expect(`${String(e)} ${(e as Error).stack} ${JSON.stringify(e)}`).not.toContain(TOKEN)
  })
})
