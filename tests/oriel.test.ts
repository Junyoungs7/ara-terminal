// M9 R2 Oriel 연동 — 감지(version JSON)·후보 자리·에이전트별 실행 인자/env(사용자 설정 파일 안 씀)·링크 열기(Oriel → 실패면 OS 브라우저).
// 진짜 Oriel 을 띄우지 않는다: run 을 바꿔 끼우고, 가짜 Oriel 폴더는 임시 폴더.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORIEL_INSTRUCTIONS, orielCandidates, orielLaunch, orielMcpServers, parseOrielVersion } from '../src/shared/oriel'
import { createOriel } from '../src/main/oriel/oriel'
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
      running: true
    })
    expect(parseOrielVersion('{"version":"0.1.0","appPath":"D:/a"}')).toBeNull()
    expect(parseOrielVersion('Usage: oriel ...')).toBeNull()
  })
  it('후보 — 설정값이 있으면 그것만, 없으면 설치본 동봉 자리 → 개발 PC 체크아웃', () => {
    expect(orielCandidates(' E:/tools/oriel ', 'C:\\ARA\\resources')).toEqual(['E:/tools/oriel'])
    expect(orielCandidates('', 'C:\\ARA\\resources')).toEqual(['C:/ARA/resources/oriel', 'D:/AI/ai-browser'])
    expect(orielCandidates('', null)).toEqual(['D:/AI/ai-browser'])
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
