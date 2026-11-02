// M9 R2 Oriel 연동 — 감지(version JSON)·후보 자리·에이전트별 실행 인자/env(사용자 설정 파일 안 씀)·링크 열기(Oriel → 실패면 OS 브라우저).
// 진짜 Oriel 을 띄우지 않는다: run 을 바꿔 끼우고, 가짜 Oriel 폴더는 임시 폴더.
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORIEL_INSTRUCTIONS, orielCandidates, orielLaunch, orielMcpServers, parseOrielVersion, pickOriel, type OrielRunner } from '../src/shared/oriel'
import { araElectronForOriel, araOrielRunner, createOriel, FOREGROUND_SCRIPT, ORIEL_ELECTRON_ENV, orielAppDir, orielKindOf, standaloneOrielExe } from '../src/main/oriel/oriel'
import { ARA_HOST_APP_ENV, ARA_HOST_ARG, isBundledOrielDir, orielHostDir } from '../src/main/oriel/host'
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
  it('후보 — 설정값이 있으면 그것만, 없으면 설치본 동봉 자리 → 개발 PC 체크아웃', () => {
    expect(orielCandidates(' E:/tools/oriel ', 'C:\\ARA\\resources')).toEqual(['E:/tools/oriel'])
    expect(orielCandidates('', 'C:\\ARA\\resources')).toEqual(['C:/ARA/resources/oriel', 'D:/AI/ai-browser'])
    expect(orielCandidates('', null)).toEqual(['D:/AI/ai-browser'])
    // OR-3 단독 설치본이 동봉판보다 앞
    expect(orielCandidates('', 'C:\\ARA\\resources', 'C:\\Users\\u\\AppData\\Local')).toEqual(['C:/Users/u/AppData/Local/Programs/oriel/resources/app', 'C:/ARA/resources/oriel', 'D:/AI/ai-browser'])
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

describe('OR-1 — ORIEL_ELECTRON(아라 Electron 공유)·링크 포커스·file:/UNC', () => {
  it('araElectronForOriel — 절대 경로·실재·옆에 default_app.asar 가 있는 첫 후보만(설치본 A.R.A.exe 는 null)', () => {
    const dev = tmp()
    mkdirSync(join(dev, 'resources'))
    writeFileSync(join(dev, 'electron.exe'), '')
    writeFileSync(join(dev, 'resources', 'default_app.asar'), '')
    const packaged = tmp()
    writeFileSync(join(packaged, 'A.R.A.exe'), '')
    expect(araElectronForOriel([join(packaged, 'A.R.A.exe'), join(dev, 'electron.exe')])).toBe(join(dev, 'electron.exe'))
    expect(araElectronForOriel([join(packaged, 'A.R.A.exe')])).toBeNull()
    expect(araElectronForOriel(['electron.exe', ''], () => true)).toBeNull() // 상대 경로는 Oriel 이 종료 코드 3
  })
  it('version·open 은 runner(실행 파일·env) 그대로 — 에이전트 MCP 설정(Claude·Codex·Gemini)도 같은 runner', async () => {
    const { dir, versionJson } = fakeOriel()
    const runner: OrielRunner = { command: 'C:/ARA/electron.exe', env: { ELECTRON_RUN_AS_NODE: '1', [ORIEL_ELECTRON_ENV]: 'C:/ARA/electron.exe' } }
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
      expect.arrayContaining(["mcp_servers.oriel.command='C:/ARA/electron.exe'", "mcp_servers.oriel.env={ELECTRON_RUN_AS_NODE='1',ORIEL_ELECTRON='C:/ARA/electron.exe'}"])
    )
    expect(orielLaunch('codex', 'D:/o/bin/oriel.mjs', write, { command: "C:/it's/ARA.exe", env: {} }).args).toEqual([])
    expect(orielLaunch('codex', 'D:/o/bin/oriel.mjs', write, { command: 'C:/ARA.exe', env: { ORIEL_ELECTRON: "C:/it's/ARA.exe" } }).args).toEqual([])
    orielLaunch('gemini', 'D:/o/bin/oriel.mjs', write, runner)
    expect(JSON.parse(files['oriel-gemini']).mcpServers.oriel).toEqual({ command: 'C:/ARA/electron.exe', args: ['D:/o/bin/oriel.mjs', 'mcp', '--launch'], env: runner.env })
  })
  it('★ 전경 허락 PowerShell 은 사용자 동작({gesture})일 때만, open 직전에 끝까지 기다린 뒤 — MCP·에이전트 경로(인자 없음)는 절대 안 부른다', async () => {
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
    expect(calls).toEqual(['ps:start', 'ps:end:true', 'open'])
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

describe('OR-2 — 설치본 Oriel 호스트 모드(안 A)·node 없는 PC(아라 Electron + ELECTRON_RUN_AS_NODE)', () => {
  const res = process.platform === 'win32' ? 'C:\\Program Files\\ARA\\resources' : '/opt/ARA/resources'
  const bundled = join(res, 'oriel')
  const base = { argv: ['ARA.exe', bundled], env: { [ARA_HOST_APP_ENV]: 'oriel' }, resourcesPath: res, packaged: true }
  it('★ 호스트 모드 = 설치본 + env ARA_HOST_APP=oriel + argv[1] 이 정확히 <resources>/oriel 일 때만', () => {
    expect(orielHostDir(base)).toBe(bundled)
    if (process.platform === 'win32') {
      expect(orielHostDir({ ...base, argv: ['ARA.exe', bundled.toUpperCase()] })).toBe(bundled) // 대소문자
      expect(orielHostDir({ ...base, argv: ['ARA.exe', bundled.replace(/\\/g, '/') + '/'] })).toBe(bundled)
    }
  })
  it('★ 기본 브라우저 등록 명령줄(env 없음) — 앱 폴더 바로 뒤 --ara-host=oriel 표식만 인정', () => {
    const reg = { ...base, env: {}, argv: ['ARA.exe', bundled, ARA_HOST_ARG, '--', 'https://example.com'] }
    expect(orielHostDir(reg)).toBe(bundled)
    expect(orielHostDir({ ...reg, packaged: false })).toBeNull()
    expect(orielHostDir({ ...reg, argv: ['ARA.exe', bundled, '--', ARA_HOST_ARG] })).toBeNull() // 자리 다름
    expect(orielHostDir({ ...reg, argv: ['ARA.exe', ARA_HOST_ARG, bundled] })).toBeNull()
    expect(orielHostDir({ ...reg, argv: ['ARA.exe', join(res, 'oriel2'), ARA_HOST_ARG] })).toBeNull()
  })
  it('★ 아닌 경우는 전부 아라로 — 개발판·env 없음/다름·인자 위조', () => {
    expect(orielHostDir({ ...base, packaged: false })).toBeNull() // 개발판은 default_app 이 Oriel 폴더를 띄운다
    expect(orielHostDir({ ...base, env: {} })).toBeNull()
    expect(orielHostDir({ ...base, env: { [ARA_HOST_APP_ENV]: 'Oriel ' } })).toBeNull()
    expect(orielHostDir({ ...base, env: { [ARA_HOST_APP_ENV]: '1' } })).toBeNull()
    expect(orielHostDir({ ...base, resourcesPath: undefined })).toBeNull()
    const forged = ['', 'oriel', 'resources/oriel', join(res, 'oriel2'), join(res, 'oriel', 'src'), join(res, 'app.asar'), join(res, '..', 'oriel'), 'D:/AI/ai-browser', '--inspect']
    for (const arg of forged) expect(orielHostDir({ ...base, argv: ['ARA.exe', arg] })).toBeNull()
    expect(orielHostDir({ ...base, argv: ['ARA.exe'] })).toBeNull()
    expect(orielHostDir({ ...base, argv: ['ARA.exe', '--foo', bundled] })).toBeNull() // 앱 폴더는 argv[1] 자리만
    expect(isBundledOrielDir(join(res, 'x', '..', 'oriel'), res)).toBe(true) // 정규화 후 같은 곳
  })
  it('araOrielRunner — 늘 아라 Electron + ELECTRON_RUN_AS_NODE, 개발판은 ORIEL_ELECTRON, 설치본 동봉 자리만 ARA_HOST_APP', () => {
    const exe = join(res, '..', 'ARA.exe')
    expect(araOrielRunner(bundled, { execPath: exe, devElectron: null, resourcesPath: res })).toEqual({
      command: exe,
      env: { ELECTRON_RUN_AS_NODE: '1', [ORIEL_ELECTRON_ENV]: exe, [ARA_HOST_APP_ENV]: 'oriel' }
    })
    // 설치본에 설정한 체크아웃 — A.R.A.exe 로는 그 폴더를 못 띄운다 → Oriel 이 자기 node_modules electron 으로
    expect(araOrielRunner('D:/AI/ai-browser', { execPath: exe, devElectron: null, resourcesPath: res })).toEqual({ command: exe, env: { ELECTRON_RUN_AS_NODE: '1' } })
    // 개발판 — default_app 있는 electron 으로 어느 폴더든, 호스트 표시 없음
    expect(araOrielRunner('D:/AI/ai-browser', { execPath: 'D:/x/electron.exe', devElectron: 'D:/x/electron.exe', resourcesPath: null })).toEqual({
      command: 'D:/x/electron.exe',
      env: { ELECTRON_RUN_AS_NODE: '1', [ORIEL_ELECTRON_ENV]: 'D:/x/electron.exe' }
    })
  })
  it('boot.ts — 호스트 판별이 아라 모듈보다 먼저(index 는 정적 import 안 함), package.json main·빌드 입력이 boot', () => {
    const boot = readFileSync(join(__dirname, '../src/main/boot.ts'), 'utf8')
    expect(boot).not.toMatch(/^import[^\n]*['"]\.\/index['"]/m)
    expect(boot).toMatch(/import\('\.\/index'\)/)
    expect(boot).toContain("'src', 'main', 'main.mjs'")
    expect(JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')).main).toBe('./out/main/boot.js')
    expect(readFileSync(join(__dirname, '../electron.vite.config.ts'), 'utf8')).toContain("boot: resolve('src/main/boot.ts')")
  })
  const electron = join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  const cli = 'D:/AI/ai-browser/bin/oriel.mjs'
  it.runIf(process.platform === 'win32' && existsSync(electron) && existsSync(cli))('★ 실제: 아라 Electron + ELECTRON_RUN_AS_NODE 로 `oriel.mjs version`(창 없음·읽기 전용) — electronPath = ORIEL_ELECTRON', async () => {
    const { runProcess } = await import('../src/main/util/runProcess')
    const runner = araOrielRunner('D:/AI/ai-browser', { execPath: electron, devElectron: electron, resourcesPath: null })
    const r = await runProcess(runner.command, [cli, 'version'], { timeoutMs: 20_000, env: runner.env })
    expect(r.error).toBeNull()
    const info = parseOrielVersion(r.stdout)
    expect(info?.electronPath).toBe(electron)
    expect(info?.cliPath.replace(/\\/g, '/')).toBe(cli)
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

describe('OR-3 — Oriel 단독 설치본 감지·우선순위(실행 중 > 단독 > 동봉 > dev)', () => {
  it('단독 설치본 판별·설치 폴더 → resources/app·종류', () => {
    const sa = fakeStandalone()
    expect(standaloneOrielExe(sa.app)).toBe(sa.exe)
    expect(standaloneOrielExe(sa.root)).toBeNull()
    expect(orielAppDir(sa.root)).toBe(sa.app) // 설정 칸에 설치 폴더를 적어도
    expect(orielAppDir(sa.app)).toBe(sa.app)
    const { dir } = fakeOriel()
    expect(orielAppDir(dir)).toBe(dir)
    expect(orielKindOf(sa.app, null)).toBe('standalone')
    expect(orielKindOf('C:/ARA/resources/oriel', 'C:/ARA/resources', () => false)).toBe('bundled')
    expect(orielKindOf(dir, 'C:/ARA/resources')).toBe('dev')
  })
  it('★ 단독판 runner = 자기 Oriel.exe + ELECTRON_RUN_AS_NODE 만(아라 Electron·ORIEL_ELECTRON·ARA_HOST_APP 없음) → MCP 설정 세 에이전트도', () => {
    const sa = fakeStandalone()
    const runner = araOrielRunner(sa.app, { execPath: 'C:/ARA/A.R.A.exe', devElectron: 'C:/x/electron.exe', resourcesPath: 'C:/ARA/resources' })
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
  it('★ createOriel — 세 종류가 다 있으면 단독판, 떠 있는 게 dev 면 dev(그 pid 의 실행 파일로 가림), 하나뿐이면 프로세스를 묻지 않는다', async () => {
    const sa = fakeStandalone()
    const bundled = fakeOriel()
    const dev = fakeOriel()
    const devExe = join(dev.dir, 'electron.exe')
    const kinds: Record<string, 'standalone' | 'bundled' | 'dev'> = { [sa.app]: 'standalone', [bundled.dir]: 'bundled', [dev.dir]: 'dev' }
    let running: number | null = null
    const asked: number[] = []
    const make = (cands: string[]) =>
      createOriel({
        candidates: () => cands,
        openExternal: async () => {},
        kindOf: (d) => kinds[d] ?? 'dev',
        runner: (d) => araOrielRunner(d, { execPath: 'C:/ARA/electron.exe', devElectron: null, resourcesPath: null }),
        processPath: async (pid) => (asked.push(pid), pid === 77 ? devExe : null),
        run: async (_f, args) => {
          const cli = args[0]
          const r = running !== null
          if (cli.startsWith(sa.app)) return ok(sa.versionJson(r, running ?? undefined))
          const d = cli.startsWith(bundled.dir) ? bundled : dev
          return ok(JSON.stringify({ ...JSON.parse(d.versionJson), running: r, ...(running ? { pid: running } : {}) }))
        }
      })
    // 꺼져 있음: 후보 순서(단독 > 동봉 > dev)
    let s = await make([sa.root, bundled.dir, dev.dir]).status()
    expect(s.installed && [s.kind, s.info.appPath, s.runner.command]).toEqual(['standalone', sa.app, sa.exe])
    expect(asked).toEqual([])
    // dev 가 떠 있음(pid 77 → dev 의 electron.exe): 실행 중인 것이 먼저
    running = 77
    s = await make([sa.app, bundled.dir, dev.dir]).status()
    expect(s.installed && [s.kind, s.info.appPath]).toEqual(['dev', dev.dir])
    expect(asked).toEqual([77])
    // 떠 있는데 어느 판인지 모름 → 후보 순서
    running = 5
    s = await make([sa.app, bundled.dir, dev.dir]).status()
    expect(s.installed && s.kind).toBe('standalone')
    // 경로 고정(후보 하나) — 묻지 않는다
    asked.length = 0
    s = await make([bundled.dir]).status()
    expect(s.installed && s.kind).toBe('bundled')
    expect(asked).toEqual([])
  })
})
