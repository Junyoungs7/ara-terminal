// M14 R1 AU-03 MCP 등록 — Orca McpConfigSection 을 따른다: 프로젝트의 MCP 설정 파일(.mcp.json·.cursor/mcp.json·.claude.json·.claude/mcp.json)을
// 살피고, 하나도 없으면 [빈 설정 만들기](.mcp.json, 덮어쓰지 않음), [열기]로 편집. 아라는 여기에 서버 추가·지우기를 더했다 — **프로젝트 .mcp.json 만**, 사람이 누를 때만.
// 에이전트별 사용자 설정(~/.claude.json·~/.codex/config.toml·~/.gemini/settings.json)은 **읽기만**(전역 설정 파일에 쓰지 않는다 — phase2 공통 원칙).
// Oriel MCP 는 아라가 실행 인자로 붙인다(M9 R2) — 파일에 없고 "아라가 붙임"으로 표시만.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { shell } from 'electron'
import { MCP_CONFIG_CANDIDATES, MCP_STARTER_CONFIG, inspectMcpConfigContent, type McpConfigCandidate } from '@shared/mcp/mcp-config'
import { summarizeMcpServer } from '@shared/mcp/mcp-server-inspection'
import { codexTomlMcpServers, mcpDraftError, type McpServerDraft, type McpSource, type McpView } from '@shared/mcp/agentMcp'
import { SKILL_AGENTS } from '@shared/skills'
import { handle } from '../ipc/handle'

const read = (p: string): Promise<string | null> => readFile(p, 'utf8').catch(() => null)
const json = (p: string, agents: McpSource['agents'], label: string, scope: McpSource['scope'], content: string | null, candidate?: McpConfigCandidate): McpSource => {
  const c: McpConfigCandidate = candidate ?? { format: 'claude', label, relativePath: p, serversPath: ['mcpServers'] }
  const r = inspectMcpConfigContent(c, content)
  return { id: `${scope}:${p}`, label, path: p, scope, agents, exists: r.exists, status: r.status, servers: r.servers, ...(r.error ? { error: r.error } : {}) }
}

export async function listMcp(o: { home: string; env: Record<string, string | undefined>; project: string | null; orielOn: boolean }): Promise<McpView> {
  const claudeJson = o.env['CLAUDE_CONFIG_DIR'] ? join(o.env['CLAUDE_CONFIG_DIR'], '.claude.json') : join(o.home, '.claude.json')
  const codexToml = join(o.env['CODEX_HOME'] || join(o.home, '.codex'), 'config.toml')
  const geminiJson = join(o.home, '.gemini', 'settings.json')
  const sources: McpSource[] = [json(claudeJson, ['claude'], 'Claude (사용자)', 'user', await read(claudeJson)), json(geminiJson, ['gemini'], 'Gemini (사용자)', 'user', await read(geminiJson))]
  const toml = await read(codexToml)
  const servers = toml === null ? [] : Object.entries(codexTomlMcpServers(toml)).map(([n, e]) => summarizeMcpServer(n, e))
  sources.splice(1, 0, { id: `user:${codexToml}`, label: 'Codex (사용자)', path: codexToml, scope: 'user', agents: ['codex'], exists: toml !== null, status: toml === null ? 'missing' : 'valid', servers })
  if (o.project) {
    for (const c of MCP_CONFIG_CANDIDATES) {
      const p = join(o.project, c.relativePath)
      // Orca: .mcp.json 은 Claude Code 가 읽는 프로젝트 설정. 아라 실행 기준으로 읽는 에이전트를 적는다.
      sources.push(json(p, c.format === 'cursor' ? [] : ['claude'], c.relativePath, 'project', await read(p), c))
    }
  }
  return { attached: SKILL_AGENTS.map((agent) => ({ agent, name: 'oriel', on: o.orielOn })), sources }
}

/** 프로젝트 .mcp.json 을 읽어 고치고 쓴다. 없으면 빈 설정에서 시작. 깨진 JSON 은 건드리지 않는다. */
async function editProjectMcp(project: string, fn: (servers: Record<string, unknown>) => string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const p = join(project, '.mcp.json')
  const cur = await read(p)
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(cur ?? MCP_STARTER_CONFIG) as Record<string, unknown>
  } catch {
    return { ok: false, error: '.mcp.json 이 올바른 JSON 이 아닙니다 — [열기]로 고치세요.' }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: '.mcp.json 모양이 다릅니다.' }
  const servers = (doc['mcpServers'] && typeof doc['mcpServers'] === 'object' ? doc['mcpServers'] : (doc['mcpServers'] = {})) as Record<string, unknown>
  const err = fn(servers)
  if (err) return { ok: false, error: err }
  await writeFile(p, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  return { ok: true }
}

export function addMcpServer(project: string, d: McpServerDraft): Promise<{ ok: true } | { ok: false; error: string }> {
  const err = mcpDraftError(d)
  if (err) return Promise.resolve({ ok: false, error: err })
  return editProjectMcp(project, (s) => {
    if (Object.hasOwn(s, d.name)) return `같은 이름의 서버가 있습니다: ${d.name}`
    s[d.name] = d.url?.trim() ? { type: 'http', url: d.url.trim() } : { command: d.command!.trim(), args: (d.args ?? []).filter((a) => typeof a === 'string') }
    return null
  })
}

export function removeMcpServer(project: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return editProjectMcp(project, (s) => {
    if (!Object.hasOwn(s, name)) return `없는 서버입니다: ${name}`
    delete s[name]
    return null
  })
}

export function registerMcpServersFeature(deps: {
  home: string
  env: Record<string, string | undefined>
  /** 아라에 등록된 로컬 프로젝트 폴더 — 렌더러가 보낸 경로는 이 안의 것만 받는다. */
  projects: () => string[]
  orielOn: () => Promise<boolean>
}): void {
  const known = new Set<string>()
  const project = (p: unknown): string | null => (typeof p === 'string' && deps.projects().some((x) => resolve(x) === resolve(p)) ? p : null)
  handle('mcpServers:list', async ({ project: p }) => {
    const v = await listMcp({ home: deps.home, env: deps.env, project: project(p), orielOn: await deps.orielOn() })
    for (const s of v.sources) known.add(resolve(s.path))
    return v
  })
  handle('mcpServers:createStarter', async ({ project: p }) => {
    const root = project(p)
    if (!root) return { ok: false, error: '모르는 프로젝트' }
    try {
      // Orca: 덮어쓰지 않는다(목록 뒤에 생긴 파일 포함) — wx.
      await writeFile(join(root, '.mcp.json'), MCP_STARTER_CONFIG, { encoding: 'utf8', flag: 'wx' })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle('mcpServers:add', async ({ project: p, server }) => {
    const root = project(p)
    return root ? addMcpServer(root, server) : { ok: false, error: '모르는 프로젝트' }
  })
  handle('mcpServers:remove', async ({ project: p, name }) => {
    const root = project(p)
    return root && typeof name === 'string' ? removeMcpServer(root, name) : { ok: false, error: '모르는 프로젝트' }
  })
  // 목록에 나왔던 파일만 OS 기본 편집기로 연다.
  handle('mcpServers:open', async ({ path }) => (typeof path === 'string' && known.has(resolve(path)) ? (await shell.openPath(path)) === '' : false))
}
