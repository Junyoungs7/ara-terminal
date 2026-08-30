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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdExeArgs } from '../src/main/ai/engine/ClaudeCliEngine'
import { createMcpServer, hashToken, issueRawToken, MCP_TOKEN_VAULT_KEY, type TokenVault } from '../src/main/mcp/McpServer'
import { McpApprovalManager, type ApprovalEmit } from '../src/main/mcp/approval'
import { createAuditLog } from '../src/main/mcp/auditLog'
import { createAskUser } from '../src/main/mcp/askUser'
import type { ToolCtx } from '../src/main/mcp/tools'
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { ProfileStore } from '../src/main/secrets/ProfileStore'
import { HistoryStore } from '../src/main/history/HistoryStore'
import type { SecretStore } from '../src/main/secrets/SecretStore'
import { createForwardService } from '../src/main/forward/PortForward'
import { SftpService } from '../src/main/sftp/SftpService'

const mem = <T,>() => new Map<string, T>()
function memSecretStore(): SecretStore {
  const m = mem<string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k), has: (k) => m.has(k) }
}
// delete 는 AraChat 이 요구한다(SelfTokenVault) — 대화를 닫을 때 아라 토큰을 무효로 만든다.
function memTokenVault(): TokenVault & { delete(key: string): void } {
  const m = mem<string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), has: (k) => m.has(k), delete: (k) => void m.delete(k) }
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
        browser: { open: () => true, closeOrigin: () => true, current: () => null, close: () => {} },
        remote: { run: async () => ({ ok: false as const, reason: 'noSession' as const }), watch: () => {}, unwatch: () => {}, stopAll: () => {}, activeCount: () => 0 },
        sessionLog: () => null,
        history: new HistoryStore(join(dir, 'history.json')),
        showPanel: () => true,
        sftp: new SftpService(() => null, () => {}),
        approval,
        ask: createAskUser({ ask: () => {}, askDone: () => {} }),
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

      // 인용은 **제품과 같은 인코더**를 쓴다(#156). 여기 값은 전부 리터럴이라 위험은 없었지만,
      // 옛 코드(한 줄로 붙여 셸에 넘기기)는 #152 가 고친 **깨진 인용 패턴의 사본**이었다 —
      // 다음 사람이 이걸 보고 복사하면 그 버그가 돌아온다. 경로도 손대지 않고 그대로 넘긴다
      // (제품이 `--mcp-config` 에 넘기는 값과 같은 모양이다 — 옛 코드의 `/` 치환은 인용이
      // 깨져서 필요했던 우회다). stdin 은 닫는다 — 안 그러면 3초를 기다렸다가 경고를 낸다.
      const prompt = 'ara MCP 서버의 session_list 도구를 호출해서 열려 있는 세션의 id 를 그대로 한 줄로만 답해라.'
      const args = ['-p', prompt, '--mcp-config', cfg, '--allowedTools', 'mcp__ara__session_list', '--output-format', 'json']

      const out = await new Promise<string>((resolve, reject) => {
        // stdio 를 상수로 빼면 `as const` 가 readonly 튜플이 되어 spawn 의 오버로드가 전부 떨어진다
        // (`p.stdout` 이 never 가 된다) — 양쪽에 그대로 적는다.
        const p =
          process.platform === 'win32'
            ? spawn(process.env.ComSpec || 'cmd.exe', cmdExeArgs('claude', args), {
                cwd: dir,
                windowsVerbatimArguments: true,
                stdio: ['ignore', 'pipe', 'pipe']
              })
            : spawn('claude', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
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

/**
 * #123 실증 — **상주 프로세스로 왕복이 되는가.**
 *
 * 단위 테스트는 가짜 프로세스로 파서와 수명을 지킨다(tests/aiEngine.test.ts). 여기서 보는 것은
 * 그 가정이 **진짜 CLI(2.1.220)에서도 맞는가** 하나다: `--input-format stream-json` 이 stdin 한
 * 줄을 받고, `--output-format stream-json` 이 우리가 아는 모양으로 뱉는가.
 *
 * 평소에는 건너뛴다 — 돌릴 때마다 사람의 Claude 한도를 쓴다.
 * 돌리려면: `ARA_EXP_CLAUDE=1 npx vitest run tests/claudeMcpBridge.exp.test.ts`
 */
describe('실증 — 상주 Claude Code 와 stream-json 왕복(#123)', () => {
  it.skipIf(!process.env.ARA_EXP_CLAUDE)(
    '한 프로세스로 질문을 보내고 ready·text·turn 을 받는다',
    async () => {
      const { createClaudeEngine } = await import('../src/main/ai/engine/ClaudeCliEngine')
      const dir = mkdtempSync(join(tmpdir(), 'ara-engine-'))
      const seen: string[] = []
      const texts: string[] = []
      const engine = createClaudeEngine({ cwd: dir })
      const done = new Promise<void>((resolve) => {
        engine.onEvent((e) => {
          seen.push(e.t)
          if (e.t === 'text') texts.push(e.text)
          if (e.t === 'error') console.log('--- 오류 ---', e.message)
          if (e.t === 'turn' || e.t === 'exit') resolve()
        })
      })
      engine.send('1+1은? 숫자만 답해 줘.')
      await done
      engine.dispose()
      console.log('--- 받은 사건 ---', seen.join(' → '))
      console.log('--- 답 ---', texts.join('').slice(0, 200))
      // init 이 오고(세션 id·모델), 글이 오고, 턴이 끝났다.
      expect(seen).toContain('ready')
      expect(seen).toContain('turn')
      expect(texts.join('')).toContain('2')
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* EBUSY */
      }
    },
    180_000
  )
})

/**
 * #124 실증 — **우리가 만든 설정으로** 도구가 물리는가, 그리고 **권한 요청이 오는가.**
 *
 * 앞의 실증(#123)은 손으로 쓴 설정 + `-p` 한 방이었다. 여기서는 제품이 실제로 쓰는 길을 그대로 탄다:
 * `prepareAraMcp()` 가 만든 임시 설정 + 상주 엔진 + `AraChat`.
 *
 * 권한 쪽은 **관찰이 목적**이다: 2.1.220 에는 `--permission-prompt-tool` 이 없고, 스트리밍 입력의
 * control 채널로 물어보는 것이 SDK 가 하는 방식인데 **핸드셰이크를 선언해야 열리는지**가 문서로
 * 확실치 않다. 로그로 남기고, 안 오면 그 사실을 설계에 적는다(없는 기능을 있는 척하지 않는다).
 */
describe('실증 — 아라 MCP 물리기 + 권한 관찰(#124)', () => {
  it.skipIf(!process.env.ARA_EXP_CLAUDE)(
    '우리 설정으로 session_list 를 부르고, 권한 요청이 오는지 관찰한다',
    async () => {
      const { createAraChat } = await import('../src/main/ai/AraChat')
      const dir = mkdtempSync(join(tmpdir(), 'ara-124-'))
      const sessions = new MainSessionManager({ data() {}, exit() {}, cwd() {} })
      const ws = new WorkspaceStore(join(dir, 'workspace.json'), '0.1.0')
      const audit = createAuditLog(join(dir, 'logs'))
      const called: string[] = []
      let ref: McpApprovalManager
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
        browser: { open: () => true, closeOrigin: () => true, current: () => null, close: () => {} },
        remote: { run: async () => ({ ok: false as const, reason: 'noSession' as const }), watch: () => {}, unwatch: () => {}, stopAll: () => {}, activeCount: () => 0 },
        sessionLog: () => null,
        history: new HistoryStore(join(dir, 'history.json')),
        showPanel: () => true,
        sftp: new SftpService(() => null, () => {}),
        approval,
        ask: createAskUser({ ask: () => {}, askDone: () => {} }),
        downloadsDir: join(dir, 'dl'),
        uploadsDir: join(dir, 'up')
      }
      const sid = await sessions.create({ type: 'local', cwd: dir, title: '실증124', serverKey: 'local' })
      const vault = memTokenVault()
      const server = createMcpServer(ctx, vault, 0)

      const events: string[] = []
      const texts: string[] = []
      const perms: string[] = []
      const chat = createAraChat({
        server,
        vault,
        activeSession: () => ({ type: 'local', cwd: dir }),
        lastLocalCwd: () => dir,
        araCwd: () => dir,
        emit: (e) => {
          events.push(e.t)
          if (e.t === 'text') texts.push(e.text)
          if (e.t === 'tool') events.push(`  ↳ ${e.name} ${e.brief}`)
          if (e.t === 'permission') {
            perms.push(`${e.tool} ${e.brief}`)
            chat.respond(e.requestId, true) // 사람이 승인한 셈 — 왕복이 되는지가 관심사다
          }
        }
      })

      const opened = await chat.open()
      expect(opened.ok).toBe(true)

      // ① 우리 도구 왕복 ② 로컬 파일 쓰기(권한이 필요한 기본 도구)
      const done = new Promise<void>((resolve) => {
        const off = setInterval(() => {
          if (events.includes('turn') || events.includes('closed')) {
            clearInterval(off)
            resolve()
          }
        }, 500)
      })
      chat.send(
        'ara MCP 의 session_list 로 열려 있는 세션 id 를 확인하고, 그 id 를 이 폴더의 out.txt 파일에 써라. 그리고 한 줄로 결과만 보고해라.'
      )
      await done

      console.log('--- 사건 ---\n' + events.join('\n'))
      console.log('--- 아라 MCP 도구 호출 ---', called.join(', ') || '(없음)')
      console.log('--- 권한 요청 ---', perms.join(' | ') || '(없음)')
      console.log('--- 답 ---', texts.join('').slice(0, 300))
      console.log('--- out.txt ---', existsSync(join(dir, 'out.txt')) ? readFileSync(join(dir, 'out.txt'), 'utf8').slice(0, 200) : '(없음)')
      console.log('--- 세션 id ---', sid)

      // 이 실증이 반드시 지켜야 하는 것: **우리 설정으로 우리 도구가 불렸다.**
      expect(called.some((c) => c.includes('session_list'))).toBe(true)

      chat.close()
      await server.stop()
      sessions.destroyAll()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* EBUSY */
      }
    },
    240_000
  )
})

/**
 * #124 실증 (b) — **`--permission-mode manual` 이면 권한을 물어 오나.**
 *
 * (a) 에서 확인된 것: 기본 상태의 헤드리스 스트리밍 모드는 `Write` 를 **묻지 않고 실행**했다.
 * 사용자의 `~/.claude` 설정을 그대로 따른 결과다(설계 §3.4 의 전제와 같다). 그런데 §3.4 는
 * "권한 요청을 아라 화면에 띄운다"고도 적었다 — 그 길이 존재하는지 여기서 가른다.
 * 결과에 따라 #125 의 승인 UI 가 있을 수도, 없을 수도 있다. **없는 기능을 있는 척하지 않으려고** 본다.
 */
describe('실증 — permission-mode manual 관찰(#124b)', () => {
  it.skipIf(!process.env.ARA_EXP_CLAUDE)(
    'manual 모드에서 파일 쓰기를 시키면 무엇이 오는가',
    async () => {
      const { createClaudeEngine } = await import('../src/main/ai/engine/ClaudeCliEngine')
      const dir = mkdtempSync(join(tmpdir(), 'ara-124b-'))
      const log: string[] = []
      const engine = createClaudeEngine({ cwd: dir, permissionMode: 'manual' })
      const done = new Promise<void>((resolve) => {
        engine.onEvent((e) => {
          log.push(e.t === 'tool' ? `tool ${e.name} ${e.brief}` : e.t === 'permission' ? `permission ${e.tool}` : e.t === 'text' ? `text ${e.text.slice(0, 80)}` : e.t === 'error' ? `error ${e.message.slice(0, 200)}` : e.t)
          if (e.t === 'permission') engine.respondPermission(e.requestId, true)
          if (e.t === 'turn' || e.t === 'exit') resolve()
        })
      })
      engine.send('이 폴더에 x.txt 파일을 만들고 안에 hello 라고 써라.')
      await done
      engine.dispose()
      console.log('--- manual 모드 사건 ---\n' + log.join('\n'))
      console.log('--- x.txt ---', existsSync(join(dir, 'x.txt')) ? '만들어짐' : '없음')
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* EBUSY */
      }
    },
    180_000
  )
})

/**
 * #124c 실증 — **"1번/2번" 되묻기가 헤드리스에 오는가.**
 *
 * 준영님 질문: 대화형 Claude Code 는 계획 승인·선택지를 번호로 물어 온다. 그게 아라에서는
 * 아예 안 오는 것인가, 오는데 우리가 못 받는 것인가?
 *
 * 두 갈래를 함께 본다:
 *  ① `init` 이 알려 주는 **도구 목록** — 사람에게 되묻는 도구(AskUserQuestion·ExitPlanMode)가
 *     헤드리스 판에 아예 없는지, 있는지.
 *  ② `--permission-mode plan` 으로 계획을 만들게 하고, 승인 단계에서 **무엇이 오는지**.
 */
describe('실증 — 되묻기·선택지 관찰(#124c)', () => {
  it.skipIf(!process.env.ARA_EXP_CLAUDE)(
    'plan 모드에서 계획 승인 단계에 무엇이 오는가 + 도구 목록',
    async () => {
      const { createClaudeEngine } = await import('../src/main/ai/engine/ClaudeCliEngine')
      const dir = mkdtempSync(join(tmpdir(), 'ara-124c-'))
      writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8')
      const log: string[] = []
      let tools: string[] = []
      const engine = createClaudeEngine({ cwd: dir, permissionMode: 'plan' })
      const done = new Promise<void>((resolve) => {
        engine.onEvent((e) => {
          if (e.t === 'ready') tools = e.tools
          log.push(
            e.t === 'tool'
              ? `tool ${e.name} ${e.brief}`
              : e.t === 'permission'
                ? `permission ${e.tool} ${e.brief}`
                : e.t === 'text'
                  ? `text ${e.text.slice(0, 160)}`
                  : e.t === 'error'
                    ? `error ${e.message.slice(0, 200)}`
                    : e.t
          )
          if (e.t === 'permission') engine.respondPermission(e.requestId, true)
          if (e.t === 'turn' || e.t === 'exit') resolve()
        })
      })
      engine.send('a.txt 의 hello 를 world 로 바꿔라.')
      await done
      engine.dispose()
      console.log('--- plan 모드 사건 ---\n' + log.join('\n'))
      console.log('--- 되묻는 도구가 목록에 있나 ---', tools.filter((t) => /Ask|Plan|Question/i.test(t)).join(', ') || '(없음)')
      console.log('--- 전체 도구 ---', tools.join(', '))
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* EBUSY */
      }
    },
    180_000
  )
})
