// P0 체크리스트(agent_talk/P0-checklist-triage.md)의 B 행 중 단위로 닫히는 것 — 이름 앞이 체크리스트 번호다.
// 사용자 실제 ~/.claude·%APPDATA%\A.R.A 는 안 건드린다 — 전부 임시 홈·임시 폴더, 시계는 모킹.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// approval.ts 는 tools.ts 를 안 부르지만 mcp-approval.test.ts 와 같은 껍데기로 세운다(electron 을 import 하는 길이 생겨도 깨지지 않게).
vi.mock('electron', () => ({ shell: { openPath: () => {} }, app: { getPath: () => tmpdir() } }))
import { mergeHooks } from '../src/shared/agentHooks'
import { cleanupLegacyHooks, cleanupOurGlobalHooks, cleanupOurStatusLine } from '../src/main/agents/hooks'
import { McpApprovalManager, type ApprovalEmit } from '../src/main/mcp/approval'
import { AUDIT_NAME_RE, createAuditLog, type AuditRecord } from '../src/main/mcp/auditLog'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { SNAPSHOT_EVERY_MS, SNAPSHOT_KEEP } from '../src/main/workspace/restoreSnapshots'
import { MCP_APPROVAL_TIMEOUT_MS, type McpApprovalRequest } from '../src/shared/types'

const temps: string[] = []
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  temps.push(d)
  return d
}
afterEach(() => {
  vi.useRealTimers()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('v22-13·46·41 부팅 정리 3종을 index.ts 순서대로 — 우리 줄만 지우고 남의 줄은 그대로', () => {
  const legacy = {
    type: 'command',
    command: 'ARA_P="$ARA_HOOK_PORT"; [ -n "$ARA_P" ] && curl -sS -m 2 -X POST "http://127.0.0.1:$ARA_P/hook/claude/Stop" >/dev/null 2>&1; exit 0 # ara-agent-hook',
    timeout: 5
  }
  const mkMine = (): { Stop: { hooks: { type: string; command: string }[] }[] } => ({ Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] })
  const mine = mkMine()
  const bootCleanup = (h: string): void => {
    cleanupLegacyHooks(h)
    cleanupOurStatusLine(h)
    cleanupOurGlobalHooks(h)
  }

  it('옛 훅 줄 + 새 전역 훅 줄 + 우리 statusLine 이 한 파일에 섞여 있어도 끝엔 남의 훅·키만 남는다(gemini 도)', () => {
    const h = tmp('ara-p0-home-')
    mkdirSync(join(h, '.claude'))
    mkdirSync(join(h, '.gemini'))
    mkdirSync(join(h, '.ara', 'agent-hooks'), { recursive: true })
    writeFileSync(join(h, '.ara', 'agent-hooks', 'claude-statusline.installed'), '')
    const base = h.replace(/\\/g, '/')
    const ours = mergeHooks({ model: 'opus', hooks: mkMine() }, 'claude', `${base}/.ara/agent-hooks/claude-hook.cmd`) as { hooks: Record<string, { hooks: unknown[] }[]> }
    ours.hooks.Stop[0].hooks.push(legacy) // 남의 묶음 안에 옛 줄이 같이 들어 있는 최악의 모양
    const claudeCfg = join(h, '.claude', 'settings.json')
    writeFileSync(claudeCfg, JSON.stringify({ ...ours, statusLine: { type: 'command', command: `${base}/.ara/agent-hooks/claude-statusline.cmd` } }))
    const gemMine = { AfterAgent: [{ hooks: [{ type: 'command', command: 'mine-after' }] }] }
    const gemCfg = join(h, '.gemini', 'settings.json')
    writeFileSync(gemCfg, JSON.stringify(mergeHooks({ hooks: gemMine }, 'gemini', `${base}/.ara/agent-hooks/gemini-hook.sh`)))

    bootCleanup(h)

    const c = JSON.parse(readFileSync(claudeCfg, 'utf8'))
    expect(c).toEqual({ model: 'opus', hooks: mine }) // statusLine·옛 줄·새 줄 전부 빠지고 남의 훅·model 은 그대로
    expect(JSON.parse(readFileSync(gemCfg, 'utf8'))).toEqual({ hooks: gemMine })
    expect(existsSync(join(h, '.ara', 'agent-hooks', 'claude-statusline.installed'))).toBe(false)
    expect(existsSync(join(h, '.codex'))).toBe(false) // 정리가 다른 CLI 폴더를 만들지 않는다
    // 부팅마다 부르는 것이라 두 번째는 파일을 안 고친다.
    const again = readFileSync(claudeCfg, 'utf8')
    bootCleanup(h)
    expect(readFileSync(claudeCfg, 'utf8')).toBe(again)
  })

  it('v22-41 남의 statusLine 은 정리 뒤에도 그대로다(우리 훅 줄만 있던 파일에서 statusLine 은 손대지 않음)', () => {
    const h = tmp('ara-p0-home-')
    mkdirSync(join(h, '.claude'))
    const cfg = join(h, '.claude', 'settings.json')
    const base = h.replace(/\\/g, '/')
    const user = { type: 'command', command: 'node omc-hud.mjs', padding: 0 }
    writeFileSync(cfg, JSON.stringify({ ...(mergeHooks({ hooks: mkMine() }, 'claude', `${base}/.ara/agent-hooks/claude-hook.cmd`) as object), statusLine: user }))
    bootCleanup(h)
    expect(JSON.parse(readFileSync(cfg, 'utf8'))).toEqual({ hooks: mine, statusLine: user })
  })
})

describe('v22-124 복원 스냅샷 — 15분에 한 장·최대 48장·두 파일 손상 복구(시계 모킹)', () => {
  const profile = { id: 'p1', type: 'ssh' as const, name: 'dev', host: '10.0.0.5', port: 22, username: 'u', auth: { type: 'password' as const, secretRef: { store: 'vault' as const, key: 'p1' } } }

  it('flush 를 실제 시계로 15분 간격 흉내 — 장수·상한·깨진 원본 보존·스냅샷으로 부팅', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.UTC(2026, 10, 3, 9, 0, 0)
    vi.setSystemTime(t0)
    const dir = tmp('ara-p0-ws-')
    const p = join(dir, 'workspace.json')
    const snaps = (): string[] => readdirSync(join(dir, 'workspace-snapshots'))

    const store = new WorkspaceStore(p, '0.1.0')
    store.upsertProfile(profile)
    store.flush()
    expect(snaps()).toHaveLength(1)
    vi.setSystemTime(t0 + SNAPSHOT_EVERY_MS - 1)
    store.flush()
    expect(snaps()).toHaveLength(1) // 15분 안 — 안 쌓인다
    vi.setSystemTime(t0 + SNAPSHOT_EVERY_MS)
    store.flush()
    expect(snaps()).toHaveLength(2)
    for (let i = 2; i < SNAPSHOT_KEEP + 12; i++) {
      vi.setSystemTime(t0 + i * SNAPSHOT_EVERY_MS)
      store.flush()
    }
    expect(snaps()).toHaveLength(SNAPSHOT_KEEP) // 최대 48(약 12시간)

    // 앱을 끈 채 본 파일·.bak 을 일부러 망가뜨린다 → 켜면 서버 목록이 스냅샷으로 살아난다.
    writeFileSync(p, '{ 깨짐')
    writeFileSync(p + '.bak', '{ 깨짐')
    const revived = new WorkspaceStore(p, '0.1.0')
    expect(revived.getProfiles().map((x) => x.id)).toEqual(['p1'])
    const kept = readdirSync(join(dir, 'workspace-backups'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dir, 'workspace-backups', kept[0]), 'utf8')).toBe('{ 깨짐') // 깨진 원본이 남는다
  })

  it('스냅샷도 전부 깨졌으면 빈 기본값으로 안전 부팅한다(던지지 않는다)', () => {
    const dir = tmp('ara-p0-ws-')
    const p = join(dir, 'workspace.json')
    mkdirSync(join(dir, 'workspace-snapshots'))
    writeFileSync(join(dir, 'workspace-snapshots', '2026-11-03T09-00-00-000Z.json'), '{ 깨짐')
    writeFileSync(p, '{ 깨짐')
    expect(new WorkspaceStore(p, '0.1.0').getProfiles()).toEqual([])
  })
})

describe('MCP-18 승인 대기 2분 만료(운영 기본값, 가짜 타이머)', () => {
  const collector = (): { emit: ApprovalEmit; requests: McpApprovalRequest[] } => {
    const requests: McpApprovalRequest[] = []
    return { requests, emit: { approvalRequest: (r) => requests.push(r), activity: () => {}, stateChanged: () => {} } }
  }

  it('기본 상수는 2분이고, 119.999초엔 아직 기다리고 120초에 거부(timeout)로 끝나며 실행·늦은 응답은 없다', async () => {
    expect(MCP_APPROVAL_TIMEOUT_MS).toBe(120_000)
    vi.useFakeTimers()
    const dir = tmp('ara-p0-mcp-')
    const c = collector()
    const mgr = new McpApprovalManager(c.emit, createAuditLog(dir)) // 시험용 타임아웃 인자를 안 준다 = 운영과 같다
    let executed = false
    let settled = false
    const run = mgr.runTool('s1', 'session_input', 'sessionInput', '{}', async () => {
      executed = true
      return 'x'
    })
    void run.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(c.requests).toHaveLength(1)
    expect(c.requests[0].expiresAt - Date.now()).toBe(MCP_APPROVAL_TIMEOUT_MS) // 화면의 "남은 시간"이 읽는 값

    await vi.advanceTimersByTimeAsync(MCP_APPROVAL_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const r = await run
    expect(r.ok).toBe(false)
    expect(executed).toBe(false)

    // 만료된 요청에 뒤늦게 [승인]을 눌러도 조용히 무시된다(실행되지 않는다).
    mgr.respond({ requestId: c.requests[0].requestId, decision: 'approve' })
    await vi.advanceTimersByTimeAsync(10)
    expect(executed).toBe(false)

    const lines = readdirSync(dir)
      .filter((f) => AUDIT_NAME_RE.test(f))
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AuditRecord))
    expect(lines.at(-1)?.outcome).toBe('timeout')
  })
})

describe('MCP-24 감사 로그 파일 이름·자리', () => {
  it('createAuditLog(dir) 는 그 폴더에 mcp-actions_YYYYMMDD.jsonl 을 쓴다(세션 로그 정리 규칙 AUDIT_NAME_RE 와 같은 이름)', () => {
    const dir = tmp('ara-p0-audit-')
    createAuditLog(dir).write({ at: Date.UTC(2026, 10, 3, 3), sessionId: 's', tool: 'session_list', args: '{}', mode: 'readOnly', outcome: 'auto', resultSummary: 'ok' })
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(AUDIT_NAME_RE)
  })

  it('폴더를 함수로 받으면 설정에서 바꾼 새 폴더에 쓴다(세션 기록 폴더를 따라감)', () => {
    const a = tmp('ara-p0-audit-a-')
    const b = tmp('ara-p0-audit-b-')
    let cur = a
    const log = createAuditLog(() => cur)
    const rec = { at: Date.UTC(2026, 10, 3, 3), sessionId: 's', tool: 'session_list', args: '{}', mode: 'readOnly', outcome: 'auto', resultSummary: 'ok' } as const
    log.write(rec)
    cur = b
    log.write(rec)
    expect(readdirSync(a)).toHaveLength(1)
    expect(readdirSync(b)).toHaveLength(1)
    expect(log.dir).toBe(b)
  })
})

// v22-126 설치 폴더에 resources\oriel 이 없다 — UB-1 에서 동봉을 뺐다. 빌드 산출물 대신 빌드 설정(정적)을 본다.
describe('v22-126 electron-builder.yml 에 oriel 동봉이 없다', () => {
  const root = join(__dirname, '..')
  // 주석(# …)은 뺀다 — 동봉을 뺀 이유를 설명하는 주석에 oriel 이 나와도 된다.
  const body = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n')

  it('files·extraResources·asarUnpack 어디에도 oriel 이 없고, resources/ 아래에 oriel 폴더도 없다', () => {
    expect(body).not.toMatch(/oriel/i)
    expect(existsSync(join(root, 'resources', 'oriel'))).toBe(false)
  })

  it('extraResources 가 싣는 것은 NOTICE·ara.cmd·번들 스킬뿐이다(양성 대조 — 줄을 제대로 읽었다)', () => {
    const tos = [...body.matchAll(/^\s+to:\s*(\S+)/gm)].map((m) => m[1])
    expect(tos).toEqual(['NOTICE', 'bin/ara.cmd', 'skills/ara-cli'])
  })

  it('package.json 의 빌드·후처리 스크립트도 oriel 을 resources 로 복사하지 않는다', () => {
    const scripts = JSON.stringify((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: object }).scripts)
    expect(scripts).not.toMatch(/resources[\/]+oriel/i)
  })
})
