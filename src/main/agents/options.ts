// M5 R2 — 채팅 옵션의 main 쪽: 모델 목록(AI-15)·슬래시 목록(AI-16)·채팅 이름(AI-19). 규칙은 @shared/agentOptions.
// 프로세스는 runProcess 로만(셸 안 거침·창 없음·시간 상한). Windows 의 npm 셔임(.cmd)은 cmd.exe 없이 못 뜬다 — 감지(detect.ts)와 같이
// `cmd /d /c <실행 파일> <고정 인자>` 로 맡기고, 사용자 글(이름 짓기의 첫 요청)은 **stdin 으로만** 넣는다(인자에 안 끼운다).
// 시험은 run 을 바꿔 끼운다 — 진짜 claude/codex/gemini 를 띄우지 않는다.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { AGENTS, parseAgentCommand, quoteArg, type AgentId, type AgentSettings } from '@shared/agents'
import {
  BUILTIN_SLASH,
  CHAT_NAME_ARGS,
  CLAUDE_MODEL_LIST_ARGS,
  CLAUDE_MODEL_LIST_STDIN,
  chatNamePrompt,
  commandNameOf,
  describeMarkdown,
  parseClaudeModelList,
  sanitizeChatName,
  type ModelCatalog,
  type SlashItem
} from '@shared/agentOptions'
import { runProcess, type RunOptions, type RunResult } from '../util/runProcess'

type Run = (file: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>

const MODEL_LIST_TIMEOUT_MS = 20_000
const NAME_TIMEOUT_MS = 60_000
/** 폴더 스캔 상한(Orca claude-command-folder-scan): 깊이·항목 수·파일 크기. */
const SCAN_DEPTH = 24
const SCAN_ENTRIES = 1000
const FILE_BYTES = 256 * 1024

/** 그 에이전트를 한 번 띄운다(설정의 명령 바꾸기·env 그대로). 담을 수 없는 실행 파일이면 error. */
export async function runAgentOnce(
  o: { agent: AgentId; settings: AgentSettings; args: readonly string[]; input: string; cwd?: string; timeoutMs: number; signal?: AbortSignal },
  run: Run = runProcess,
  win = process.platform === 'win32'
): Promise<RunResult> {
  const prefs = o.settings.agents[o.agent]
  const cmd = parseAgentCommand(AGENTS[o.agent].bin, prefs.command, win ? 'literal' : 'escape')
  if (!cmd.ok) return { code: 1, stdout: '', stderr: '', error: new Error(cmd.error) }
  const env = { ...prefs.env, ...cmd.env }
  const opts: RunOptions = { cwd: o.cwd, env, timeoutMs: o.timeoutMs, input: o.input, maxBuffer: 4 * 1024 * 1024, signal: o.signal }
  if (!win) return run(cmd.binary, [...cmd.prefixArgs, ...o.args], opts)
  if (quoteArg(cmd.binary, 'cmd') === null) return { code: 1, stdout: '', stderr: '', error: new Error(`cmd 에 담을 수 없는 실행 파일: ${cmd.binary}`) }
  // 경로로 준 실행 파일이 없으면 cmd 는 "경로를 찾을 수 없습니다"(종료 1)로 끝나 '실행 실패'로 보인다 — 띄우기 전에 ENOENT 로(= 못 찾음).
  // 이름만 준 것은 cmd 가 PATH 에서 못 찾으면 9009 로 알린다. 확장자 없는 경로는 cmd 처럼 PATHEXT 를 붙여 본다.
  if (/[\\/]/.test(cmd.binary)) {
    const p = resolve(o.cwd ?? process.cwd(), cmd.binary)
    const exts = ['', ...(process.env['PATHEXT'] || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    if (!exts.some((e) => existsSync(p + e))) return { code: 1, stdout: '', stderr: '', error: Object.assign(new Error(`실행 파일이 없습니다: ${cmd.binary}`), { code: 'ENOENT' }) }
  }
  return run(process.env['ComSpec'] || 'cmd.exe', ['/d', '/c', cmd.binary, ...cmd.prefixArgs, ...o.args], opts)
}

/** AI-15 — 설치된 CLI 에 모델 목록을 묻는다(지금은 Claude 만). 실패는 error 로(피커는 모델 칸을 숨기고 CLI 기본값으로 띄운다). */
export async function listModels(agent: AgentId, settings: AgentSettings, run?: Run, win = process.platform === 'win32'): Promise<ModelCatalog> {
  if (agent !== 'claude') return { error: 'unsupported' }
  // 훅 끄기(--settings JSON)는 cmd 인용이 위험해 POSIX 에서만. Windows 는 아라 훅이 칸 키 없이 와서 버려진다(남의 훅은 돈다 — 한계).
  const args = win ? CLAUDE_MODEL_LIST_ARGS : [...CLAUDE_MODEL_LIST_ARGS, '--settings', '{"disableAllHooks":true}']
  const r = await runAgentOnce({ agent, settings, args, input: CLAUDE_MODEL_LIST_STDIN, timeoutMs: MODEL_LIST_TIMEOUT_MS }, run, win)
  const models = parseClaudeModelList(r.stdout)
  if (models.length) return { models }
  return { error: (r.stderr || r.error?.message || 'no models').trim().slice(0, 300) }
}

/** AI-19 — 첫 요청으로 이름을 짓는다(그 에이전트로, 읽기 전용 한 번). 못 지으면 null. */
export async function generateChatName(o: { agent: AgentId; settings: AgentSettings; cwd: string; firstPrompt: string }, run?: Run, win = process.platform === 'win32'): Promise<string | null> {
  if (!o.firstPrompt.trim()) return null
  const r = await runAgentOnce({ agent: o.agent, settings: o.settings, args: CHAT_NAME_ARGS[o.agent], input: chatNamePrompt(o.firstPrompt), cwd: o.cwd, timeoutMs: NAME_TIMEOUT_MS }, run, win)
  return r.error ? null : sanitizeChatName(r.stdout)
}

// ── AI-16 슬래시 목록(폴더 스캔) ──
type Budget = { left: number }

/** root 아래 .md(또는 ext) 파일 — 심볼릭 링크는 따라가지 않는다, 이름 순. */
function walk(root: string, ext: string, budget: Budget, depth = 0, out: string[] = []): string[] {
  if (depth > SCAN_DEPTH || budget.left <= 0) return out
  let names: string[] = []
  try {
    names = readdirSync(root).sort()
  } catch {
    return out
  }
  for (const n of names) {
    if (budget.left-- <= 0) break
    const p = join(root, n)
    try {
      const st = lstatSync(p)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(p, ext, budget, depth + 1, out)
      else if (st.isFile() && n.toLowerCase().endsWith(ext)) out.push(p)
    } catch {
      /* 사라진 파일 */
    }
  }
  return out
}

const head = (p: string): string => {
  try {
    return readFileSync(p, 'utf8').slice(0, FILE_BYTES)
  } catch {
    return ''
  }
}

/** 명령 폴더들 — 앞 뿌리가 같은 이름을 이긴다(Orca: 프로젝트가 사용자보다 먼저). */
function scanCommands(roots: readonly { dir: string; source: 'project' | 'user' }[], ext: string, budget: Budget, prefix = ''): SlashItem[] {
  const out = new Map<string, SlashItem>()
  for (const r of roots) {
    for (const f of walk(r.dir, ext, budget)) {
      const name = commandNameOf(relative(r.dir, f).replace(/\.[^.\\/]+$/, '.md'))
      if (!name || out.has(prefix + name)) continue
      const body = head(f)
      const description = ext === '.toml' ? /^description\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(body)?.[1] : describeMarkdown(body).description
      out.set(prefix + name, { name: prefix + name, kind: 'command', source: r.source, ...(description ? { description } : {}) })
    }
  }
  return [...out.values()]
}

/** 스킬 폴더들 — <뿌리>/<이름>/SKILL.md 하나가 스킬 하나. */
function scanSkills(roots: readonly { dir: string; source: 'project' | 'user' }[], budget: Budget): SlashItem[] {
  const out = new Map<string, SlashItem>()
  for (const r of roots) {
    let names: string[] = []
    try {
      names = readdirSync(r.dir).sort()
    } catch {
      continue
    }
    for (const n of names) {
      if (budget.left-- <= 0) break
      const f = join(r.dir, n, 'SKILL.md')
      if (!existsSync(f)) continue
      const d = describeMarkdown(head(f))
      const name = commandNameOf(d.name ?? n)
      if (!name || out.has(name)) continue
      out.set(name, { name, kind: 'skill', source: r.source, ...(d.description ? { description: d.description } : {}) })
    }
  }
  return [...out.values()]
}

/**
 * 에이전트별 `/` 목록: 기본 명령 + 사용자·프로젝트 명령·스킬 폴더(Orca claude-at-rest-commands 의 폴더 갈래).
 *  · claude — <cwd>/.claude/commands·skills, <설정 폴더>/commands·skills (설정 폴더 = CLAUDE_CONFIG_DIR 또는 ~/.claude)
 *  · codex — $CODEX_HOME/prompts/*.md → `/prompts:<이름>`
 *  · gemini — <cwd>/.gemini/commands·~/.gemini/commands 의 *.toml (description = "…")
 */
export function scanSlash(agent: AgentId, cwd: string, home: string, env: NodeJS.ProcessEnv = process.env): SlashItem[] {
  const budget: Budget = { left: SCAN_ENTRIES }
  const builtin: SlashItem[] = BUILTIN_SLASH[agent].map((name) => ({ name, kind: 'builtin' }))
  let found: SlashItem[] = []
  if (agent === 'claude') {
    const cfg = env['CLAUDE_CONFIG_DIR'] || join(home, '.claude')
    found = [
      ...scanCommands([{ dir: join(cwd, '.claude', 'commands'), source: 'project' }, { dir: join(cfg, 'commands'), source: 'user' }], '.md', budget),
      ...scanSkills([{ dir: join(cwd, '.claude', 'skills'), source: 'project' }, { dir: join(cfg, 'skills'), source: 'user' }], budget)
    ]
  } else if (agent === 'codex') {
    found = scanCommands([{ dir: join(env['CODEX_HOME'] || join(home, '.codex'), 'prompts'), source: 'user' }], '.md', budget, 'prompts:')
  } else {
    found = scanCommands([{ dir: join(cwd, '.gemini', 'commands'), source: 'project' }, { dir: join(home, '.gemini', 'commands'), source: 'user' }], '.toml', budget)
  }
  const names = new Set(builtin.map((b) => b.name))
  return [...builtin, ...found.filter((x) => !names.has(x.name))]
}
