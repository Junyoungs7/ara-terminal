// FB-monitor(FB-0004) — 트리 우클릭 tmux 서브메뉴가 쓰는 `tmux ls` 파서 + main exec 왕복.
// "설치 안 됨"·"세션 없음"·"정상"을 각각 다른 안내로 구분하는 게 요구사항이라 그 세 갈래를 각각 본다.
import { describe, it, expect, afterEach } from 'vitest'
import type { Client, ServerChannel } from 'ssh2'
import { parseTmuxLs } from '../src/shared/tmuxList'
import { tmuxMenuItem } from '../src/renderer/interactions/actions'
import { connectSsh, type SshBackend } from '../src/main/sessions/ssh/SshBackend'
import { fetchTmuxSessions } from '../src/main/telemetry/TmuxSessions'
import { startPasswordServer, type Harness } from './ssh-harness'
import type { SshProfile } from '../src/shared/types'

describe('parseTmuxLs — tmux ls 2>&1 출력 파싱', () => {
  it('세션이 있으면 이름을 뽑는다(윈도 수·생성시각 등 나머지는 버린다)', () => {
    const out = 'work: 2 windows (created Mon Aug  3 10:00:00 2026) [220x50] (attached)\n' + 'deploy: 1 windows (created Mon Aug  3 09:00:00 2026) [220x50]\n'
    expect(parseTmuxLs(out)).toEqual({ status: 'ok', sessions: ['work', 'deploy'] })
  })

  it('서버가 없으면(세션 0개) noServer', () => {
    expect(parseTmuxLs('no server running on /tmp/tmux-1000/default\n')).toEqual({ status: 'noServer', sessions: [] })
  })

  it('출력이 완전히 비어도 noServer로 취급한다(일부 환경은 메시지 없이 빈 문자열)', () => {
    expect(parseTmuxLs('')).toEqual({ status: 'noServer', sessions: [] })
    expect(parseTmuxLs('   \n  ')).toEqual({ status: 'noServer', sessions: [] })
  })

  it('tmux 가 설치되어 있지 않으면 notInstalled(bash/dash 두 형식 모두)', () => {
    expect(parseTmuxLs('bash: tmux: command not found\n')).toEqual({ status: 'notInstalled', sessions: [] })
    expect(parseTmuxLs('sh: 1: tmux: not found\n')).toEqual({ status: 'notInstalled', sessions: [] })
  })

  it('알아볼 수 없는 응답은 error(빈 목록으로 조용히 넘기지 않고 구분해서 안내한다)', () => {
    expect(parseTmuxLs('???garbage???\n').status).toBe('error')
  })

  it('세션 이름에 공백이 있어도 첫 콜론 기준으로 정확히 잘린다', () => {
    expect(parseTmuxLs('my work: 1 windows (created ...) [80x24]\n')).toEqual({ status: 'ok', sessions: ['my work'] })
  })
})

describe('tmuxMenuItem — 서브메뉴 항목 조립(순수 변환)', () => {
  it('로딩 중엔 안내 하나만 비활성으로 뜬다(새 세션/분리 등 고정 액션은 그대로 있다)', () => {
    const items = tmuxMenuItem('loading').submenu!
    expect(items.map((i) => i.id)).toEqual(['session.tmux.new', 'tmux.status', 'session.tmux.detach', 'session.tmux.prevWindow', 'session.tmux.nextWindow'])
    expect(items.find((i) => i.id === 'tmux.status')?.disabled).toBe(true)
  })

  it('세션이 있으면 각 이름이 클릭 가능한 붙기 항목으로 들어간다', () => {
    const items = tmuxMenuItem({ status: 'ok', sessions: ['work', 'deploy'] }).submenu!
    const attach = items.filter((i) => i.id.startsWith('session.tmux.attach:'))
    expect(attach.map((i) => i.id)).toEqual(['session.tmux.attach:work', 'session.tmux.attach:deploy'])
    expect(attach.map((i) => i.label)).toEqual(['work', 'deploy'])
    for (const i of attach) expect(i.disabled).toBeFalsy()
  })

  it('미설치·세션없음·오류는 서로 다른 안내 문구다(무의미한 "모르겠음" 반복 금지)', () => {
    const labelOf = (status: 'notInstalled' | 'noServer' | 'error') =>
      tmuxMenuItem({ status, sessions: [] }).submenu!.find((i) => i.id === 'tmux.status')!.label
    const labels = new Set([labelOf('notInstalled'), labelOf('noServer'), labelOf('error')])
    expect(labels.size).toBe(3) // 세 안내가 모두 다른 문구
  })

  it('부모 항목은 언제나 서브메뉴를 갖고 직접 액션 id 가 없다(호버로만 열림)', () => {
    const item = tmuxMenuItem('loading')
    expect(item.id).toBe('session.tmux')
    expect(item.submenu).toBeDefined()
  })
})

// ── ssh2 하네스 exec 왕복(실서버 없음 — DLP) ──
let harness: Harness | null = null
let backend: SshBackend | null = null

afterEach(async () => {
  backend?.kill()
  backend = null
  await harness?.close()
  harness = null
})

function pwProfile(port: number): SshProfile {
  return {
    id: 'p1',
    name: 'harness',
    host: '127.0.0.1',
    port,
    username: 'tester',
    type: 'ssh',
    auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }
  }
}

async function connectClient(): Promise<Client> {
  const res = await connectSsh(pwProfile(harness!.port), {
    knownHosts: {},
    secret: harness!.password,
    acceptHostKey: true,
    onHostKeyAccepted: () => {}
  })
  if (!res.ok) throw new Error('connect failed: ' + res.reason)
  backend = res.backend
  return res.backend.sshClient()!
}

describe('fetchTmuxSessions — 실제 exec 채널로 조회', () => {
  it('원격이 tmux ls 결과를 흘리면 파싱된 세션 목록으로 돌아온다', async () => {
    let receivedCmd = ''
    harness = await startPasswordServer({
      execHandler: (command, stream: ServerChannel) => {
        receivedCmd = command
        stream.write('work: 1 windows (created Mon Aug  3 10:00:00 2026) [80x24]\n')
        stream.exit(0)
        stream.end()
      }
    })
    const client = await connectClient()
    const result = await fetchTmuxSessions(client)
    expect(receivedCmd).toBe('tmux ls 2>&1') // stderr 도 합쳐 받아야 미설치/서버없음을 구분할 수 있다
    expect(result).toEqual({ status: 'ok', sessions: ['work'] })
  })

  it('tmux 가 없는 서버는 notInstalled로 온다(2>&1 로 원격 셸이 이미 stdout 에 합쳐 보낸다)', async () => {
    harness = await startPasswordServer({
      execHandler: (_command, stream: ServerChannel) => {
        // 실제 원격에서는 "2>&1"이 셸 단계에서 합쳐지므로 exec 채널엔 이 텍스트가 stdout(stream)으로
        // 온다 — stream.stderr 가 아니다(하네스는 셸을 실행하지 않으므로 우리가 직접 그 모양을 흉내낸다).
        stream.write('bash: tmux: command not found\n')
        stream.exit(127)
        stream.end()
      }
    })
    const client = await connectClient()
    expect(await fetchTmuxSessions(client)).toEqual({ status: 'notInstalled', sessions: [] })
  })
})
