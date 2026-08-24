/**
 * 아라 MCP 물리기(#124) — **Claude Code 에게 우리 도구를 건네는 자리.**
 *
 * 설계 §3.2: `--mcp-config` 로 임시 JSON 하나를 준다. 그 안에는 우리 HTTP MCP 서버 주소와
 * **그 순간 발급한 토큰**이 들어간다. 이걸로 Claude Code 는 평소 하는 일 전부에 더해
 * 아라의 세션·SSH·SFTP·포워딩 도구를 쓸 수 있게 된다.
 *
 * 지키는 것 셋:
 *  ① **토큰은 아라 전용 키로 발급한다** — 사용자가 외부 클라이언트(Claude Desktop 등)에 넣어 둔
 *     토큰을 무효로 만들지 않는다(McpServer 의 MCP_SELF_TOKEN_VAULT_KEY 주석 참고).
 *  ② **설정 파일은 임시 폴더에, 우리만 읽을 자리에** 쓰고 대화를 닫을 때 지운다. 토큰이 든 파일이다.
 *  ③ 서버가 꺼져 있으면 **켜 준다** — 사용자가 MCP 를 켜 두지 않았다고 아라가 도구를 잃을 이유는 없다.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashToken, issueRawToken, MCP_SELF_TOKEN_VAULT_KEY, type McpServerHandle, type TokenVault } from '../../mcp/McpServer'
import { BIND_HOST } from '../../mcp/McpServer'

/** Claude Code 가 읽는 MCP 설정(순수 — 모양이 바뀌면 여기만 고친다). */
export function mcpConfigJson(port: number, token: string): string {
  return JSON.stringify({
    mcpServers: {
      // 이름이 그대로 도구 접두어가 된다: `mcp__ara__session_list`.
      // buildClaudeArgs 의 `--allowedTools mcp__ara__*` 와 **같은 이름이어야 한다.**
      ara: {
        type: 'http',
        url: `http://${BIND_HOST}:${port}/mcp`,
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  })
}

export type AraMcpHandoff = {
  /** `--mcp-config` 에 넘길 파일 경로. */
  configPath: string
  /** 대화를 닫을 때 부른다 — 토큰이 든 파일을 지운다. */
  cleanup: () => void
}

/**
 * 서버를 켜고(필요하면), 아라 전용 토큰을 발급하고, 설정 파일을 써서 경로를 돌려준다.
 * 서버를 못 켜면 null — 그때는 **MCP 없이** 대화를 시작한다(Claude Code 기본 기능은 그대로 산다).
 */
export async function prepareAraMcp(server: McpServerHandle, vault: TokenVault): Promise<AraMcpHandoff | null> {
  if (!server.isEnabled()) {
    const r = await server.setEnabled(true).catch(() => null)
    if (!r) return null
  }
  const port = server.port()
  if (!port) return null

  const token = issueRawToken()
  vault.set(MCP_SELF_TOKEN_VAULT_KEY, hashToken(token))

  const dir = mkdtempSync(join(tmpdir(), 'ara-mcp-'))
  const configPath = join(dir, 'mcp.json')
  writeFileSync(configPath, mcpConfigJson(port, token), 'utf8')
  return {
    configPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 프로세스가 아직 붙잡고 있을 수 있다 — OS 가 임시 폴더를 정리한다 */
      }
    }
  }
}

// ── 작업 폴더 고르기(설계 §3.3) ───────────────────────────────────────────────

export type CwdPick =
  /** 이 폴더에서 돈다. */
  | { kind: 'use'; cwd: string }
  /** 물어봐야 한다 — 원격 경로는 이 PC 에 없다. */
  | { kind: 'ask' }

/**
 * 아라가 어느 폴더에서 돌 것인가.
 *
 * | 활성 세션 | 결과 |
 * |---|---|
 * | 로컬 셸 | 그 셸의 cwd 그대로 — 그 폴더의 CLAUDE.md·훅·스킬을 읽는 것이 이득이다 |
 * | SSH | 원격 경로는 이 PC 에 없다 → 마지막으로 쓴 로컬 폴더, 없으면 **묻는다** |
 * | 없음 | 마지막으로 쓴 폴더, 없으면 묻는다 |
 *
 * 임시 폴더로 격리하지 않는다: 그러면 로컬 파일 작업이 통째로 죽는다(§3.2).
 */
export function pickEngineCwd(o: {
  sessionType: 'local' | 'ssh' | 'rdp' | null
  sessionCwd: string | null
  lastLocal: string | null
}): CwdPick {
  if (o.sessionType === 'local' && o.sessionCwd && isLocalPath(o.sessionCwd)) return { kind: 'use', cwd: o.sessionCwd }
  if (o.lastLocal && isLocalPath(o.lastLocal)) return { kind: 'use', cwd: o.lastLocal }
  return { kind: 'ask' }
}

/**
 * 이 PC 의 경로처럼 생겼는가. 원격 세션의 cwd(`/home/jun/...`)를 로컬 폴더로 잘못 쓰면
 * claude 가 "폴더 없음"으로 죽거나 **엉뚱한 폴더**(윈도우의 `\home\jun`)에서 돈다.
 */
export function isLocalPath(p: string): boolean {
  if (process.platform !== 'win32') return p.startsWith('/')
  // 윈도우: 드라이브 문자 또는 UNC 만 로컬로 본다.
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}
