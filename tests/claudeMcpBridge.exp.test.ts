/**
 * 실증 — **로컬 Claude Code(구독 로그인)가 아라의 MCP 도구를 실제로 부르는가.**
 * 준영님 안: "각자의 클로드 코드 계정을 헤드리스로."
 *
 * 2026-08-24 이 PC 에서 통과했다: `claude -p --mcp-config` 가 아라의 `session_list` 를 호출하고
 * 살아 있는 세션 id 를 그대로 돌려줬다(num_turns 3 = 도구 왕복 한 번).
 *
 * **평소에는 건너뛴다** — 실행할 때마다 사람의 Claude 한도를 쓴다. 게이트에 둘 물건이 아니다.
 * 돌리려면: `ARA_EXP_CLAUDE=1 npx vitest run tests/zz-claude-mcp-exp.test.ts`
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpServer, hashToken, issueRawToken, MCP_TOKEN_VAULT_KEY, type TokenVault } from '../src/main/mcp/McpServer'
import { McpApprovalManager, type ApprovalEmit } from '../src/main/mcp/approval'
import { createAuditLog } from '../src/main/mcp/auditLog'
import type { ToolCtx } from '../src/main/mcp/tools'
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { ProfileStore } from '../src/main/secrets/ProfileStore'
import type { SecretStore } from '../src/main/secrets/SecretStore'
import { createForwardService } from '../src/main/forward/PortForward'
import { SftpService } from '../src/main/sftp/SftpService'

const mem = <T,>() => new Map<string, T>()
function memSecretStore(): SecretStore {
  const m = mem<string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k), has: (k) => m.has(k) }
}
function memTokenVault(): TokenVault {
  const m = mem<string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), has: (k) => m.has(k) }
}

describe('실증 — 로컬 Claude Code(구독 로그인)가 아라 MCP 도구를 호출한다', () => {
  it.skipIf(!process.env.ARA_EXP_CLAUDE)(
    'claude -p --mcp-config 로 session_list 를 부른다',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ara-claude-mcp-'))
      const sessions = new MainSessionManager({ data() {}, exit() {}, cwd() {} })
      const ws = new WorkspaceStore(join(dir, 'workspace.json'), '0.1.0')
      const audit = createAuditLog(join(dir, 'logs'))
      let ref: McpApprovalManager
      const called: string[] = []
      const emit: ApprovalEmit = {
        approvalRequest: (r) => {
          called.push(r.tool)
          ref.respond({ requestId: r.requestId, decision: 'approve' })
        },
        activity: (a) => called.push('activity:' + a.tool),
        stateChanged: () => {}
      }
      const approval = new McpApprovalManager(emit, audit)
      ref = approval
      const ctx: ToolCtx = {
        sessions,
        profiles: new ProfileStore(ws, memSecretStore()),
        ws,
        forwards: createForwardService(() => null),
        sftp: new SftpService(() => null, () => {}),
        approval,
        downloadsDir: join(dir, 'dl'),
        uploadsDir: join(dir, 'up')
      }
      // 진짜 로컬 셸 하나를 띄워 둔다 — 도구가 "무엇을" 봤는지로 호출 여부를 판정하기 위해서다.
      const sid = await sessions.create({ type: 'local', cwd: dir, title: '실증', serverKey: 'local' })
      const vault = memTokenVault()
      const token = issueRawToken()
      vault.set(MCP_TOKEN_VAULT_KEY, hashToken(token))
      const server = createMcpServer(ctx, vault, 0)
      const started = await server.setEnabled(true)
      expect(started.port).toBeTruthy()

      const cfg = join(dir, 'mcp.json')
      writeFileSync(
        cfg,
        JSON.stringify({
          mcpServers: {
            ara: { type: 'http', url: `http://127.0.0.1:${started.port}/mcp`, headers: { Authorization: `Bearer ${token}` } }
          }
        }),
        'utf8'
      )

      // Windows 에서 `claude` 는 .cmd 셸 스크립트라 shell:true 가 필요하고, 그러면 인자 배열이
      // 아니라 **한 줄 명령**으로 넘겨야 한글·공백이 안 잘린다(첫 시도에서 프롬프트가 "지금" 한
      // 글자로 잘렸다). stdin 은 닫는다 — 안 그러면 3초를 기다렸다가 경고를 낸다.
      const prompt = 'ara MCP 서버의 session_list 도구를 호출해서 열려 있는 세션의 id 를 그대로 한 줄로만 답해라.'
      const cmd = [
        'claude',
        '-p',
        `"${prompt}"`,
        '--mcp-config',
        `"${cfg.replaceAll('\\', '/')}"`,
        '--allowedTools',
        'mcp__ara__session_list',
        '--output-format',
        'json'
      ].join(' ')

      const out = await new Promise<string>((resolve, reject) => {
        const p = spawn(cmd, { cwd: dir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let buf = ''
        p.stdout.on('data', (d) => (buf += d))
        p.stderr.on('data', (d) => (buf += d))
        p.on('error', reject)
        p.on('close', () => resolve(buf))
      })

      console.log('--- claude 응답 ---\n' + out.slice(0, 1500))
      console.log('--- 불린 도구 ---', called.join(', ') || '(없음)')
      // 읽기 전용 도구는 승인을 묻지 않고 활동 로그만 남긴다 — 어느 쪽이든 '불렸다'는 증거다.
      expect(called.some((c) => c.endsWith('session_list'))).toBe(true)
      expect(out).toContain(sid) // 그 결과(세션 id)가 답에 실려 왔다

      await server.stop()
      sessions.destroyAll()
      // pty 가 아직 폴더를 붙잡고 있으면 지우지 못한다 — 임시 폴더라 남아도 무해하다.
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* EBUSY — OS 가 나중에 정리한다 */
      }
    },
    180_000
  )
})
