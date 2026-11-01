// M9 R2 — Oriel(별도 창 브라우저, D:/AI/ai-browser) 연동의 순수 규칙. 결정(orca-bundle-decisions 2026-11-01): 브라우저는 무조건 Oriel —
// 아라 안 브라우저 칸 없음, 링크 열기·에이전트 웹 작업(MCP) 모두 Oriel. 연동 기준: agent_talk/oriel-integration.md(Oriel HEAD 1dfc0a0).
//  · 감지 = `<runner> <appPath>/bin/oriel.mjs version` 의 JSON(OR-2: runner = 아라 Electron + ELECTRON_RUN_AS_NODE — node 없는 PC)(설치: package name oriel + electronPath·cliPath 존재 — 존재 확인은 main)
//  · 에이전트 MCP = 서버 이름 `oriel`, `mcp --launch`(꺼져 있으면 Oriel 이 스스로 뜬다 — 포커스 안 뺏음)
// 사용자 설정 파일(~/.claude.json·~/.codex/config.toml·~/.gemini/settings.json)은 쓰지 않는다 — 실행 인자·env 로만.
import type { AgentId } from './agents'

export type OrielInfo = { version: string; appPath: string; electronPath: string; cliPath: string; running: boolean }
/**
 * OR-2 — Oriel CLI(version·open·mcp)를 띄우는 법. 시스템 node 가 없는 PC 도 되게 아라 Electron + `ELECTRON_RUN_AS_NODE=1`
 * (M4 데몬과 같은 길), 그 위에 Oriel 앱을 띄울 Electron(`ORIEL_ELECTRON`)·설치본 호스트 표시(`ARA_HOST_APP`)를 env 로 — main/oriel/oriel.ts araOrielRunner.
 */
export type OrielRunner = { command: string; env: Record<string, string> }
/** 시스템 node 로(시험·예전 모양). */
export const NODE_RUNNER: OrielRunner = { command: 'node', env: {} }

/** 설정·알림이 보는 상태. installed=false 면 where 에 찾아본 자리들. runner = 감지에 쓴 실행법(open·에이전트 MCP 설정도 같은 것). */
export type OrielStatus = { installed: true; info: OrielInfo; runner: OrielRunner } | { installed: false; tried: string[] }

/** `oriel version` stdout → 정보. 필요한 칸이 없거나 JSON 이 아니면 null. */
export function parseOrielVersion(stdout: string): OrielInfo | null {
  let v: unknown
  try {
    v = JSON.parse(stdout)
  } catch {
    return null
  }
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const str = (k: string): string | null => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : null)
  const version = str('version')
  const appPath = str('appPath')
  const electronPath = str('electronPath')
  const cliPath = str('cliPath')
  if (!version || !appPath || !electronPath || !cliPath) return null
  return { version, appPath, electronPath, cliPath, running: o['running'] === true }
}

/**
 * 찾아볼 자리(앞이 먼저). 설정값이 있으면 그것만. 없으면 설치본 동봉 자리(다음 라운드 — electron-builder extraResources `oriel`) → 개발 PC 체크아웃.
 * 하드코딩 경로는 후보일 뿐 — 없으면 '미설치'.
 */
export function orielCandidates(setting: string, resourcesPath: string | null): string[] {
  if (setting.trim()) return [setting.trim()]
  return [...(resourcesPath ? [`${resourcesPath.replace(/\\/g, '/')}/oriel`] : []), 'D:/AI/ai-browser']
}

/** 에이전트에게 주는 한 줄 지시(Claude 는 --append-system-prompt-file, Codex 는 developer_instructions). 따옴표·줄바꿈 없음 — 셸 한 줄에 그대로 담긴다. */
export const ORIEL_INSTRUCTIONS =
  'For any web check or browser test use the Oriel browser through its MCP tools oriel_* and browser_* - not another browser tool, not a local browser. Call finish() when the web task is done.'

type OrielServer = { command: string; args: string[]; env?: Record<string, string> }

/**
 * MCP 서버 정의(Claude --mcp-config·Gemini settings 같은 모양). command·env = 감지 때와 같은 runner — OR-2: 아라 Electron 을 node 로,
 * env ORIEL_ELECTRON(`mcp --launch` 가 Oriel 을 그 Electron 으로 띄운다, Oriel 89eb2b3), 설치본이면 ARA_HOST_APP 도.
 */
export function orielMcpServers(cliPath: string, runner: OrielRunner = NODE_RUNNER): { mcpServers: { oriel: OrielServer & { type: 'stdio' } } } {
  const env = Object.keys(runner.env).length ? { env: { ...runner.env } } : {}
  return { mcpServers: { oriel: { type: 'stdio', command: runner.command, args: [cliPath.replace(/\\/g, '/'), 'mcp', '--launch'], ...env } } }
}

/**
 * 에이전트별 실행 인자·env. 파일 내용은 `files` 로 돌려주고 main 이 써서 경로를 넣는다(write).
 *  · Claude: `--mcp-config <json>` — **`--strict-mcp-config` 는 안 붙인다**: strict 는 사용자의 다른 MCP 서버를 전부 끈다
 *    (Orca claude-background-run-isolation-real-cli.test: strict 면 user 서버 0개, --mcp-config 것만). Oriel 은 **더하기만**.
 *    + `--append-system-prompt-file <지시>`(시스템 프롬프트를 바꾸지 않고 덧붙임).
 *  · Codex: `-c mcp_servers.oriel.*`·`-c developer_instructions=...`(config.toml 안 씀 — 그 실행에만). TOML 리터럴 문자열('…')이라
 *    PowerShell 5.1 의 큰따옴표 문제를 비켜 간다. 경로에 `'` 가 있으면 담을 수 없어 Oriel 없이.
 *  · Gemini: env `GEMINI_CLI_SYSTEM_DEFAULTS_PATH=<json>` — 시스템 기본값 자리(가장 낮은 층, mcpServers 는 shallow_merge 라 사용자 서버와 합쳐진다,
 *    gemini-cli 0.46 settingsSchema). 지시는 붙일 자리가 없다(GEMINI_SYSTEM_MD 는 시스템 프롬프트를 통째로 바꾼다) — 도구 설명(oriel_guide)에 맡긴다.
 *    M9 R3: 실행에서는 main 이 상태 훅과 한 파일로 합쳐 쓴다(orielGeminiDefaults — agents/feature.ts). 이 갈래는 Oriel 만 줄 때의 모양.
 */
export function orielLaunch(
  agent: AgentId,
  cliPath: string,
  write: (name: string, ext: string, body: string) => string,
  runner: OrielRunner = NODE_RUNNER
): { args: string[]; env: Record<string, string> } {
  const cli = cliPath.replace(/\\/g, '/')
  if (agent === 'claude') {
    return {
      args: ['--mcp-config', write('oriel-mcp', 'json', JSON.stringify(orielMcpServers(cli, runner), null, 2)), '--append-system-prompt-file', write('oriel-instructions', 'md', ORIEL_INSTRUCTIONS + '\n')],
      env: {}
    }
  }
  if (agent === 'codex') {
    const env = Object.entries(runner.env)
    if ([cli, runner.command, ...env.flat()].some((v) => v.includes("'"))) return { args: [], env: {} }
    return {
      args: [
        '-c',
        `mcp_servers.oriel.command='${runner.command}'`,
        '-c',
        `mcp_servers.oriel.args=['${cli}','mcp','--launch']`,
        ...(env.length ? ['-c', `mcp_servers.oriel.env={${env.map(([k, v]) => `${k}='${v}'`).join(',')}}`] : []),
        '-c',
        'mcp_servers.oriel.tool_timeout_sec=120',
        '-c',
        `developer_instructions='${ORIEL_INSTRUCTIONS}'`
      ],
      env: {}
    }
  }
  return { args: [], env: { [GEMINI_DEFAULTS_ENV]: write('oriel-gemini', 'json', JSON.stringify(orielGeminiDefaults(cli, runner), null, 2)) } }
}

/** Gemini 시스템 기본값 파일 env — 실행 하나에 파일 하나라 상태 훅(M9 R3)과 Oriel MCP 를 한 파일에 담는다(main agents/feature.ts). */
export const GEMINI_DEFAULTS_ENV = 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH'

/** Gemini 시스템 기본값 파일에 담을 Oriel MCP(type 칸 없는 Gemini 모양). */
export function orielGeminiDefaults(cliPath: string, runner: OrielRunner = NODE_RUNNER): { mcpServers: { oriel: OrielServer } } {
  const { command, args, env } = orielMcpServers(cliPath, runner).mcpServers.oriel
  return { mcpServers: { oriel: { command, args, ...(env ? { env } : {}) } } }
}
