// M14 R2 `ara` CLI 본체 — Orca src/cli/index.ts(help → 검사 → 실행 → --json 봉투, orcaRef ec112c6b01)의 아라판.
// 시험이 그대로 부르게 입출력·환경·띄우기를 인자로 받는다(tests/araCli.test.ts — 가짜 아라 파이프와 왕복).
import { basename } from 'node:path'
import { camel, CliUsageError, findCommandSpec, isCommandGroup, parseArgs, resolveHelpPath, validateCommandAndFlags } from './args'
import { call, CliClientError, defaultUserDataPath, getStatus, openApp, type AppStatus } from './client'
import { COMMAND_SPECS, specPaths, type CommandSpec } from './specs'

export type CliIo = {
  out(s: string): void
  err(s: string): void
  env: Record<string, string | undefined>
  cwd: string
  version: string
  /** 아라 창 띄우기(ara open). 없으면 "직접 켜 주세요". */
  launchApp?: () => void
  /** 요청 시간 상한(시험이 줄인다). */
  timeoutMs?: number
  openTimeoutMs?: number
}

/** 에이전트 띄우기·작업 단위 만들기는 git·에이전트 감지가 껴서 길다. 나머지는 짧게. */
const LONG_METHODS = new Set(['worktree.create', 'agent.launch', 'worktree.rm'])
const DEFAULT_TIMEOUT_MS = 15_000
const LONG_TIMEOUT_MS = 180_000
const OPEN_TIMEOUT_MS = 30_000

function helpText(path: readonly string[]): string {
  const spec = findCommandSpec(COMMAND_SPECS, path)
  if (spec) return [spec.summary, '', `사용: ${spec.usage}`, ...(spec.examples?.length ? ['', '예:', ...spec.examples.map((e) => `  ${e}`)] : [])].join('\n')
  const shown = COMMAND_SPECS.filter((s) => !s.hidden && (path.length === 0 || specPaths(s).some((p) => path.every((v, i) => p[i] === v))))
  return [
    path.length ? `ara ${path.join(' ')} — 명령` : 'ara — 아라를 터미널에서(아라가 켜져 있어야 합니다)',
    '',
    ...shown.map((s) => `  ara ${s.path.join(' ').padEnd(18)} ${s.summary}`),
    '',
    '  ara                    (인자 없이) 이 폴더에서 아라 열기',
    '  ara help <명령>        자세한 사용법 · 모든 명령은 --json 을 받습니다'
  ].join('\n')
}

const short = (ref: unknown): string => (typeof ref === 'string' ? ref.replace(/^refs\/heads\//, '') : '')
type Wt = { id: string; displayName: string; branch?: string; path: string; comment?: string; workspaceStatus?: string }
const wtLine = (w: Wt): string => [w.displayName, short(w.branch) || '-', w.workspaceStatus ?? '-', w.path].join('\t') + (w.comment ? `\n    ${w.comment.split('\n')[0]}` : '')

/** 사람 눈용 한두 줄. 모르는 모양은 JSON 그대로. */
function formatText(spec: CommandSpec, r: unknown): string {
  const o = (r ?? {}) as Record<string, unknown>
  switch (spec.method) {
    case 'repo.list':
      return (o['repos'] as { id: string; displayName: string; path: string }[]).map((p) => `${p.displayName}\t${p.path}\tid:${p.id}`).join('\n') || '(프로젝트 없음)'
    case 'worktree.list':
      return (o['worktrees'] as Wt[]).map(wtLine).join('\n') || '(작업 단위 없음)'
    case 'worktree.show':
    case 'worktree.set':
      return `${wtLine(o['worktree'] as Wt)}\nid:${(o['worktree'] as Wt).id}`
    case 'worktree.create': {
      const w = o['worktree'] as Wt
      const l = o['launch'] as { terminal: string } | undefined
      return `만듦: ${w.displayName}\t${w.path}\nid:${w.id}${l ? `\n에이전트 탭: ${l.terminal}` : ''}`
    }
    case 'worktree.rm':
      return `지움: ${String(o['removed'])}${o['preservedBranch'] ? `\n브랜치는 남김(병합 안 됨): ${String(o['preservedBranch'])}` : ''}`
    case 'terminal.list':
      return (o['terminals'] as { id: string; space: string; title: string; cwd: string | null }[]).map((t) => `${t.id}\t${t.space}\t${t.title}\t${t.cwd ?? ''}`).join('\n') || '(열린 터미널 없음)'
    case 'terminal.create':
      return `열림: ${(o['terminal'] as { id: string }).id}`
    case 'terminal.send':
      return '보냄'
    case 'terminal.read':
      return String(o['text'] ?? '')
    case 'agent.launch':
      return `에이전트 탭: ${(o['launch'] as { terminal: string }).terminal}`
    default:
      return JSON.stringify(r, null, 2)
  }
}

const statusText = (s: AppStatus): string => (s.app.running ? `아라: 켜짐 (pid ${s.app.pid}, ${s.app.version})` : s.runtime.state === 'stale_bootstrap' ? '아라: 꺼짐(지난 실행이 남긴 파일 있음)' : '아라: 꺼짐')

/** 종료 코드: 0 성공, 1 실패(아라 쪽·연결), 2 잘못 친 명령(Orca cli-exit-code 의 usage). */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    io.out(`${io.version}\n`)
    return 0
  }
  const parsed = parseArgs(argv)
  const json = parsed.flags.has('json')
  const helpPath = resolveHelpPath(parsed)
  if (helpPath !== null || parsed.commandPath.length === 0 || (!findCommandSpec(COMMAND_SPECS, parsed.commandPath) && isCommandGroup(COMMAND_SPECS, parsed.commandPath) && parsed.flags.size === 0)) {
    const path = helpPath ?? parsed.commandPath
    io.out(`${helpText(path)}\n`)
    return path.length > 0 && !findCommandSpec(COMMAND_SPECS, path) && !isCommandGroup(COMMAND_SPECS, path) ? 2 : 0
  }
  const fail = (code: string, message: string, nextSteps: string[], exit: number): number => {
    if (json) io.out(`${JSON.stringify({ ok: false, error: { code, message, nextSteps } })}\n`)
    else io.err(`${message}${nextSteps.length ? `\n${nextSteps.map((s) => `  ${s}`).join('\n')}` : ''}\n`)
    return exit
  }
  const ok = (result: unknown, text: string): number => {
    io.out(json ? `${JSON.stringify({ ok: true, result })}\n` : `${text}\n`)
    return 0
  }
  try {
    const spec = validateCommandAndFlags(COMMAND_SPECS, parsed)
    const userData = defaultUserDataPath(io.env)
    if (spec.path[0] === 'status') {
      const s = await getStatus(userData)
      return ok(s, statusText(s))
    }
    if (spec.path[0] === 'open') {
      if (!io.launchApp) throw new CliClientError('runtime_unavailable', '이 실행에서는 아라를 띄울 수 없습니다 — 아라를 직접 켜 주세요.')
      const s = await openApp(userData, io.launchApp, io.openTimeoutMs ?? OPEN_TIMEOUT_MS)
      return ok(s, statusText(s))
    }
    const params: Record<string, unknown> = { cwd: io.cwd, ...spec.defaults }
    for (const [k, v] of parsed.flags) if (k !== 'json' && k !== 'help') params[camel(k)] = v
    // Orca: 터미널을 안 고르면 이 명령을 친 그 터미널 — 아라 에이전트 탭은 셸 env 에 자기 id(ARA_PANE_KEY)를 갖고 있다.
    if (spec.path[0] === 'terminal' && (spec.path[1] === 'send' || spec.path[1] === 'read') && params['terminal'] === undefined && io.env['ARA_PANE_KEY']) {
      params['terminal'] = io.env['ARA_PANE_KEY']
    }
    const timeout = io.timeoutMs ?? (LONG_METHODS.has(spec.method!) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
    const result = await call<unknown>(userData, spec.method!, params, timeout)
    return ok(result, formatText(spec, result))
  } catch (e) {
    if (e instanceof CliUsageError) return fail(e.code, e.message, e.nextSteps, 2)
    if (e instanceof CliClientError) return fail(e.code, e.message, e.nextSteps, 1)
    return fail('internal', e instanceof Error ? e.message : String(e), [], 1)
  }
}

/** node 로 띄워졌으면(개발) 아라 실행 파일이 아니다 — 띄울 수 없다. ara.cmd 는 아라 실행 파일 + ELECTRON_RUN_AS_NODE 로 부른다. */
export function isNodeBinary(execPath: string): boolean {
  return /^node(\.exe)?$/i.test(basename(execPath))
}
