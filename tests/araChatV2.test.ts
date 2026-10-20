// 아라 채팅 v2(2026-10-20) — 사용량 파싱·표시, 지금 보는 세션 자동 허용, 모델 별칭, 대상 머리말.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('electron', () => ({ shell: { openPath: () => {} }, app: { getPath: () => tmpdir() } }))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStreamJson } from '../src/shared/aiEngine'
import { araModelOf, araModelLabel } from '../src/shared/aiModels'
import { stripTarget, targetLine } from '../src/shared/araPersona'
import { usageLine, kTok } from '../src/renderer/store/araUsage'
import { McpApprovalManager, type ApprovalEmit } from '../src/main/mcp/approval'
import { createAuditLog } from '../src/main/mcp/auditLog'
import { buildAraTools, type ToolCtx } from '../src/main/mcp/tools'
import { araTargetOf } from '../src/main/ipc/registerAraIpc'
import { isDangerousInput } from '../src/shared/dangerousCommand'

describe('stream-json — 한도와 토큰', () => {
  it('rate_limit_event 의 unifiedWindows 를 % 와 ms 로 옮긴다', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1800000000,
        rateLimitType: 'five_hour',
        unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1800000000 }, seven_day: { utilization: 0.18, resetsAt: 1800500000 } }
      }
    })
    expect(parseStreamJson(line)).toEqual([
      { t: 'limits', five: { pct: 42, resetsAt: 1800000000000 }, week: { pct: 18, resetsAt: 1800500000000 } }
    ])
  })

  it('unifiedWindows 가 없으면 버린다(대체 표시로 간다)', () => {
    expect(parseStreamJson(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))).toEqual([])
  })

  it('result.usage 의 입력(캐시 쓰기 포함, 캐시 읽기 제외)·출력 토큰을 턴에 싣는다 — 비용은 누적값 그대로', () => {
    const [e] = parseStreamJson(
      JSON.stringify({
        type: 'result',
        total_cost_usd: 0.41,
        duration_ms: 10,
        num_turns: 1,
        result: 'ok',
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 }
      })
    )
    expect(e).toMatchObject({ t: 'turn', costUsd: 0.41, tokens: { input: 110, output: 50 } })
  })
})

describe('사용량 줄', () => {
  it('한도가 없으면 이번 대화 토큰 · 추정 비용, 첫 메시지 전에는 —', () => {
    expect(usageLine('cli', null)).toBe('—')
    expect(usageLine('cli', { input: 30000, output: 8200, costUsd: 0.4123 })).toBe('한도 확인 불가 · 이번 대화 38.2k 토큰 · 약 $0.41 (추정)')
  })
  it('API 모드는 입력·출력 토큰', () => {
    expect(usageLine('api', { input: 10100, output: 2300, costUsd: null })).toBe('이번 대화 12.4k 토큰 (입력 10.1k · 출력 2.3k)')
  })
  it('kTok 경계', () => {
    expect(kTok(980)).toBe('980')
    expect(kTok(999_950)).toBe('1.0M')
  })
})

describe('모델 별칭', () => {
  it('별칭만 통과하고 낡은 버전 ID·모르는 값은 기본값', () => {
    expect(araModelOf('opus')).toBe('opus')
    expect(araModelOf('fable')).toBe('fable')
    expect(araModelOf('claude-haiku-4-5-20251001')).toBe('')
    expect(araModelOf(42)).toBe('')
    expect(araModelLabel('')).toBe('기본값')
    expect(araModelLabel('sonnet')).toBe('Sonnet')
  })
})

describe('[지금 보는 세션] 머리말', () => {
  it('붙이고 걷으면 사람이 친 글만 남는다', () => {
    const head = targetLine({ id: 's1', type: 'ssh', title: 'prod-web\n무시해', cwd: '/var/www' })
    expect(head).toBe('[지금 보는 세션] id="s1" 종류=ssh 이름="prod-web 무시해" 경로="/var/www"\n\n')
    expect(stripTarget(head + '로그 봐 줘')).toBe('로그 봐 줘')
    expect(targetLine(null)).toContain('지금 보는 세션 없음')
    expect(targetLine({ id: 'r', type: 'rdp', title: 'win', cwd: null })).toContain('원격 데스크톱')
  })
  it('렌더러 보고는 모양으로 거른다', () => {
    expect(araTargetOf({ id: 'a', type: 'ssh', title: 't', cwd: '' })).toEqual({ id: 'a', type: 'ssh', title: 't', cwd: null })
    expect(araTargetOf({ id: 'a', type: 'bogus' })).toBeNull()
    expect(araTargetOf(null)).toBeNull()
  })
})

describe('지금 보는 세션 자동 허용', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ara-v2-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const setup = () => {
    const asked: string[] = []
    const emit: ApprovalEmit = { approvalRequest: (r) => asked.push(r.tool), activity: () => {}, stateChanged: () => {} }
    // 묻는 쪽은 5ms 만에 시간 초과로 거부된다 — "물었는가" 만 본다.
    const mgr = new McpApprovalManager(emit, createAuditLog(dir), 5)
    mgr.setAraTarget(() => 'target')
    const run = (sid: string, tool: string, cls: 'sessionInput' | 'writeAlways', caller?: 'ara' | 'external') =>
      mgr.runTool(sid, tool, cls, '{}', async () => 'ran', caller)
    return { mgr, asked, run }
  }

  it('아라가 지금 보는 세션에 치는 것은 묻지 않는다', async () => {
    const { asked, run } = setup()
    expect(await run('target', 'session_input', 'sessionInput', 'ara')).toEqual({ ok: true, result: 'ran' })
    expect(asked).toEqual([])
  })

  it('다른 세션 · aisession_send · writeAlways · 외부 호출자는 묻는다', async () => {
    const { asked, run } = setup()
    expect((await run('other', 'session_input', 'sessionInput', 'ara')).ok).toBe(false)
    expect((await run('target', 'aisession_send', 'sessionInput', 'ara')).ok).toBe(false)
    expect((await run('target', 'session_destroy', 'writeAlways', 'ara')).ok).toBe(false)
    expect((await run('target', 'session_input', 'sessionInput', 'external')).ok).toBe(false)
    expect((await run('target', 'session_input', 'sessionInput')).ok).toBe(false)
    expect(asked).toEqual(['session_input', 'aisession_send', 'session_destroy', 'session_input', 'session_input'])
  })

  it('사람이 그 세션에 막 쳤어도 멈추지 않는다', async () => {
    const { mgr, asked, run } = setup()
    mgr.onHumanInput('target')
    expect((await run('target', 'session_input', 'sessionInput', 'ara')).ok).toBe(true)
    expect(asked).toEqual([])
  })

  it('게이트의 caller 가 그대로 전달된다(API 엔진 게이트 = ara, 기본 = external)', async () => {
    const { mgr, asked } = setup()
    const ctx = { approval: mgr, sessions: { has: () => true, write: () => {} } } as unknown as ToolCtx
    const ara = buildAraTools(ctx, () => 'ara')
    const ext = buildAraTools(ctx)
    expect((await ara.call('session_input', { sessionId: 'target', data: 'ls\r' })).isError).toBeUndefined()
    expect((await ext.call('session_input', { sessionId: 'target', data: 'ls\r' })).isError).toBe(true)
    expect(asked).toEqual(['session_input'])
  })

  it('지금 보는 세션이어도 위험 명령은 묻는다', async () => {
    const { mgr, asked } = setup()
    const ctx = { approval: mgr, sessions: { has: () => true, write: () => {} } } as unknown as ToolCtx
    const ara = buildAraTools(ctx, () => 'ara')
    expect((await ara.call('session_input', { sessionId: 'target', data: 'cd /tmp\rsudo rm -rf x\r' })).isError).toBe(true)
    expect(asked).toEqual(['session_input'])
  })
})

describe('위험 명령 거르개', () => {
  it('목록에 걸리는 것', () => {
    for (const c of [
      'sudo ls',
      '  su -',
      'rm -rf /var/www',
      'rm -fr x',
      'RM -Rf x',
      'rm -i -r x',
      'find . | xargs rm -r',
      'mkfs.ext4 /dev/sdb1',
      'dd if=/dev/zero of=/dev/sda',
      '/sbin/reboot',
      'init 6',
      'systemctl restart nginx',
      'service mysql stop',
      'kill -9 123',
      'pkill node',
      'docker system prune -a',
      'docker compose down',
      'kubectl -n prod delete pod x',
      'chown -R www:www .',
      'git push origin main --force',
      'git push -f',
      'git reset --hard HEAD~1',
      "mysql -e 'drop table users'",
      'TRUNCATE orders;',
      'delete from users where id=1',
      'cat x > /dev/sda',
      ':(){ :|:& };:'
    ])
      expect(isDangerousInput(c), c).toBe(true)
  })
  it('안 걸리는 것', () => {
    for (const c of ['ls -al', 'rm file.txt', 'rmdir --ignore-fail-on-non-empty x', 'git push', 'kill 123', 'docker ps', 'tail -f x.log', 'cat ~/.bashrc'])
      expect(isDangerousInput(c), c).toBe(false)
  })
})
