// M14 R2 `ara` 명령 표 — Orca src/cli/command-spec.ts(모양)·specs/core·worktree·terminal·agent-launch(orcaRef ec112c6b01)의 1차 몫.
// 아라 이름으로 옮기고 아라에 있는 기능만 남겼다(뺀 것은 보고서 표). method = 아라(main/cli/handlers.ts)에 보낼 요청.
import type { CliMethod } from '@shared/araCli'

export type CommandSpec = {
  path: string[]
  aliases?: string[][]
  /** 오타 제안이 엉뚱한 지우기로 이끌지 않게(Orca destructive). */
  destructive?: boolean
  hidden?: boolean
  summary: string
  usage: string
  allowedFlags: string[]
  examples?: string[]
  /** 아라에 보낼 요청. 없으면 CLI 안에서 끝난다(status·open). */
  method?: CliMethod
  /** 이 명령이 기본으로 채우는 값(worktree current = worktree show --worktree active). */
  defaults?: Record<string, string>
}

export function specPaths(spec: CommandSpec): string[][] {
  return spec.aliases ? [spec.path, ...spec.aliases] : [spec.path]
}

/** 모든 명령이 받는 것(Orca GLOBAL_FLAGS 의 로컬 몫). */
export const GLOBAL_FLAGS = ['json', 'help']
/** 값을 받지 않는 플래그(Orca BOOLEAN_FLAGS). */
export const BOOLEAN_FLAGS = new Set(['json', 'help', 'force', 'enter'])

const WT = '--worktree <선택자>'

export const COMMAND_SPECS: CommandSpec[] = [
  { path: ['status'], summary: '아라가 켜져 있는지', usage: 'ara status [--json]', allowedFlags: [], examples: ['ara status --json'] },
  { path: ['open'], summary: '아라를 켜고(꺼져 있으면) 창이 뜰 때까지 기다린다', usage: 'ara open [--json]', allowedFlags: [] },

  { path: ['repo', 'list'], aliases: [['repo', 'ls']], summary: '아라 프로젝트 목록', usage: 'ara repo list [--json]', allowedFlags: [], method: 'repo.list' },

  {
    path: ['worktree', 'list'],
    aliases: [['worktree', 'ls']],
    summary: '작업 단위 목록',
    usage: 'ara worktree list [--repo <선택자>] [--json]',
    allowedFlags: ['repo'],
    method: 'worktree.list'
  },
  { path: ['worktree', 'current'], summary: '지금 폴더의 작업 단위', usage: 'ara worktree current [--json]', allowedFlags: [], method: 'worktree.show', defaults: { worktree: 'active' } },
  { path: ['worktree', 'show'], summary: '작업 단위 하나', usage: `ara worktree show ${WT} [--json]`, allowedFlags: ['worktree'], method: 'worktree.show' },
  {
    path: ['worktree', 'create'],
    summary: '새 작업 단위(git worktree) — --agent 를 주면 거기에 에이전트 탭도',
    usage: 'ara worktree create --name <이름> [--repo <선택자>] [--base-branch <브랜치>] [--agent claude|codex|gemini] [--prompt <지시>] [--json]',
    allowedFlags: ['name', 'repo', 'base-branch', 'agent', 'prompt'],
    method: 'worktree.create',
    examples: ['ara worktree create --name fix-login --agent claude --prompt "로그인 버그를 고쳐 줘" --json']
  },
  {
    path: ['worktree', 'set'],
    summary: '작업 단위 메모·카드 상태 쓰기',
    usage: `ara worktree set ${WT} [--comment <메모>] [--workspace-status todo|in-progress|in-review|completed|null] [--json]`,
    allowedFlags: ['worktree', 'comment', 'workspace-status'],
    method: 'worktree.set',
    examples: ['ara worktree set --worktree active --comment "재현함, 고치는 중" --json', 'ara worktree set --worktree active --workspace-status in-review --json']
  },
  {
    path: ['worktree', 'rm'],
    aliases: [
      ['worktree', 'remove'],
      ['worktree', 'delete']
    ],
    destructive: true,
    summary: '작업 단위 지우기(브랜치는 git branch -d 규칙대로)',
    usage: `ara worktree rm ${WT} [--force] [--json]`,
    allowedFlags: ['worktree', 'force'],
    method: 'worktree.rm'
  },

  { path: ['terminal', 'list'], aliases: [['terminal', 'ls']], summary: '열린 터미널(에이전트 탭 포함)', usage: `ara terminal list [${WT}] [--json]`, allowedFlags: ['worktree'], method: 'terminal.list' },
  {
    path: ['terminal', 'create'],
    summary: '그 폴더에 로컬 셸 탭을 연다(터미널 공간) — --command 를 주면 실행',
    usage: `ara terminal create [${WT}] [--command <명령>] [--title <이름>] [--json]`,
    allowedFlags: ['worktree', 'command', 'title'],
    method: 'terminal.create',
    examples: ['ara terminal create --worktree active --command "npm test" --json']
  },
  {
    path: ['terminal', 'send'],
    summary: '터미널에 글을 보낸다(--enter 면 Enter 까지). --terminal 이 없으면 지금 에이전트 탭',
    usage: 'ara terminal send [--terminal <id>] --text <글> [--enter] [--json]',
    allowedFlags: ['terminal', 'text', 'enter'],
    method: 'terminal.send'
  },
  { path: ['terminal', 'read'], summary: '터미널 화면 글', usage: 'ara terminal read [--terminal <id>] [--json]', allowedFlags: ['terminal'], method: 'terminal.read' },

  {
    path: ['agent', 'launch'],
    summary: '있는 작업 단위에 에이전트 탭을 띄운다(앱의 [+] 와 같은 길)',
    usage: `ara agent launch --agent claude|codex|gemini [${WT}] [--prompt <지시>] [--json]`,
    allowedFlags: ['agent', 'worktree', 'prompt'],
    method: 'agent.launch'
  }
]
