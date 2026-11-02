// M14 R1 AU-03 MCP 등록 — Orca McpConfigSection(프로젝트 MCP 설정 파일 살피기·빈 설정 만들기·열기) + 에이전트별 사용자 설정 읽기.
import type { SkillAgent } from '../skills'
import type { McpServerSummary } from './mcp-config'

export type McpSource = {
  id: string
  label: string
  path: string
  scope: 'user' | 'project'
  /** 이 파일을 읽는 에이전트. */
  agents: SkillAgent[]
  exists: boolean
  status: 'missing' | 'valid' | 'invalid'
  servers: McpServerSummary[]
  error?: string
}

export type McpView = {
  /** 아라가 실행 인자로 붙이는 MCP(M9 R2 Oriel) — 설정 파일에 없다. 표시만. */
  attached: { agent: SkillAgent; name: string; on: boolean }[]
  sources: McpSource[]
}

/** 프로젝트 .mcp.json 에 더할 서버 하나 — stdio(command·args) 또는 http(url). */
export type McpServerDraft = { name: string; command?: string; args?: string[]; url?: string }

const NAME = /^[A-Za-z0-9_.-]{1,64}$/
export function mcpDraftError(d: McpServerDraft | null | undefined): string | null {
  if (!d || typeof d.name !== 'string' || !NAME.test(d.name)) return '이름은 영문·숫자·_.- 64자 이내입니다.'
  const cmd = typeof d.command === 'string' ? d.command.trim() : ''
  const url = typeof d.url === 'string' ? d.url.trim() : ''
  if (!cmd === !url) return '명령 또는 URL 중 하나만 적으세요.'
  if (url && !/^https?:\/\//i.test(url)) return 'URL 은 http(s):// 로 시작해야 합니다.'
  return null
}

/** Codex config.toml 의 [mcp_servers.<이름>] 표 — 이름·command·url·enabled 만 줄 단위로 읽는다(쓰지 않는다). */
export function codexTomlMcpServers(toml: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  let cur: Record<string, unknown> | null = null
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    const h = /^\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]$/.exec(line)
    if (h) {
      cur = out[h[1] ?? h[2]] = {}
      continue
    }
    if (line.startsWith('[')) {
      cur = null
      continue
    }
    const kv = /^(command|url|enabled)\s*=\s*(.+)$/.exec(line)
    if (cur && kv) {
      const v = kv[2].trim()
      cur[kv[1]] = v === 'true' ? true : v === 'false' ? false : v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    }
  }
  return out
}
