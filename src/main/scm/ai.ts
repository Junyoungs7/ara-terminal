// M12 R3 RV-02 — 소스 제어 [AI 로 쓰기]의 main 쪽: git 에서 맥락을 모으고 CLI 에이전트를 한 번 실행해 글을 받는다.
// Orca main/text-generation/(source-control-text-generation-requests · source-control-local-process · source-control-remote-generation ·
// pull-request-context)의 핵심. 규칙·프롬프트는 @shared/scmAi.
//  · 실행 = agents/options runAgentOnce(설정의 명령 바꾸기·env 그대로, Windows 는 cmd /d /c, 프롬프트는 stdin). 로컬은 runProcess,
//    원격 작업 단위는 work/backend 의 SSH exec 로 **그 서버의 CLI**(Orca remote-execution) — 서버에 없으면 noCliRemote 로 안내.
//  · 결과는 돌려주기만 — 커밋·푸시·브랜치 바꾸기는 사용자가 누를 때(묶음 11).
import type { AgentId, AgentSettings } from '@shared/agents'
import { remoteAgentSettings } from '@shared/runOn'
import { DEFAULT_BASE_REF_ARGS, pickDefaultBaseRef } from '@shared/gitDiff'
import {
  CLAUDE_ENTERPRISE_REFUSAL,
  SCM_AI_TIMEOUT_MS,
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildMrPrompt,
  commitMessageOf,
  failureExcerpt,
  parseMrFields,
  sanitizeBranchSlug,
  scmAiAgentOf,
  scmAiArgs,
  type ScmAiKind,
  type ScmAiResult
} from '@shared/scmAi'
import { runAgentOnce } from '../agents/options'
import type { Exec } from '../work/backend'
import type { RunResult } from '../util/runProcess'

const GIT_MS = 30_000
/** 패치 상한 — 넘으면 패치 없이 파일 목록만(Orca: "diff omitted — too large"). */
const PATCH_MAX = 16 * 1024 * 1024
/** cmd.exe 가 "명령을 찾을 수 없음"에 내는 코드 · POSIX 셸의 127. */
const NOT_FOUND_CODES = new Set([9009, 127])

type Ctx = { root: string; x: Exec; remote: boolean; settings: AgentSettings; signal?: AbortSignal; win?: boolean }

async function git(c: Ctx, args: string[]): Promise<RunResult> {
  return c.x('git', ['-c', 'core.quotePath=false', ...args], { cwd: c.root, timeoutMs: GIT_MS, maxBuffer: PATCH_MAX, env: { GIT_TERMINAL_PROMPT: '0' }, signal: c.signal })
}
const out = async (c: Ctx, args: string[]): Promise<string> => {
  const r = await git(c, args)
  return r.code === 0 ? r.stdout.trim() : ''
}
/** 패치는 상한을 넘으면 ''(실패 = 너무 큼). */
const patchOf = async (c: Ctx, args: string[]): Promise<string> => {
  const r = await git(c, ['diff', '--no-color', '--no-ext-diff', ...args])
  return r.code === 0 ? r.stdout : ''
}

/** 지금 브랜치에서 base 까지(MR·브랜치 이름이 쓴다). 기준을 못 찾으면 null. */
async function branchContext(c: Ctx): Promise<{ base: string; commits: string; files: string; patch: string } | null> {
  const d = await git(c, [...DEFAULT_BASE_REF_ARGS])
  const base = d.code === 0 ? pickDefaultBaseRef(d.stdout) : null
  if (!base) return null
  const mb = await out(c, ['merge-base', base, 'HEAD'])
  if (!mb) return null
  return {
    base: base.replace(/^origin\//, ''),
    commits: await out(c, ['log', '--format=%h %s', `${mb}..HEAD`]),
    files: await out(c, ['diff', '--name-status', mb, 'HEAD']),
    patch: await patchOf(c, [mb, 'HEAD'])
  }
}

/** 에이전트 한 번 — Claude 가 기업 MCP 설정으로 --strict-mcp-config 를 거절하면 그것만 빼고 한 번 더(Orca runClaudeBackgroundAttempts). */
async function runAgent(c: Ctx, agent: AgentId, prompt: string): Promise<RunResult> {
  const win = c.remote ? false : (c.win ?? process.platform === 'win32')
  const settings = c.remote ? remoteAgentSettings(c.settings, agent) : c.settings
  // 원격: `sh -c` 는 로그인 PATH(~/.local/bin·nvm 등)를 모른다 — 로그인 셸로 한 번 감싸 그 서버 사용자의 CLI 를 찾는다.
  const run: Exec = c.remote ? (file, args, o) => c.x('sh', ['-lc', 'exec "$0" "$@"', file, ...args], o) : c.x
  const once = (strictMcp: boolean): Promise<RunResult> =>
    runAgentOnce({ agent, settings, args: scmAiArgs(agent, { strictMcp, posix: !win }), input: prompt, cwd: c.root, timeoutMs: SCM_AI_TIMEOUT_MS, signal: c.signal }, run, win)
  const r = await once(true)
  if (agent === 'claude' && r.code !== 0 && `${r.stdout}\n${r.stderr}`.includes(CLAUDE_ENTERPRISE_REFUSAL)) return once(false)
  return r
}

/** 실행 결과 → 실패 코드(성공이면 null). */
function failureOf(r: RunResult, c: Ctx, agent: AgentId): Extract<ScmAiResult, { ok: false }> | null {
  if (r.error?.name === 'AbortError' || c.signal?.aborted) return { ok: false, code: 'canceled', agent }
  if ((r.error as { killed?: boolean } | null)?.killed) return { ok: false, code: 'timeout', agent }
  const enoent = (r.error as { code?: unknown } | null)?.code === 'ENOENT'
  if (enoent || NOT_FOUND_CODES.has(r.code)) return { ok: false, code: c.remote ? 'noCliRemote' : 'noCli', agent, message: failureExcerpt(r.stdout, r.stderr) }
  if (r.code !== 0) return { ok: false, code: 'failed', agent, message: failureExcerpt(r.stdout, r.stderr) ?? r.error?.message }
  return null
}

export async function generateScmText(kind: ScmAiKind, c: Ctx): Promise<ScmAiResult> {
  const agent = scmAiAgentOf(c.settings.defaultAgent)
  const branch = (await out(c, ['symbolic-ref', '--short', '-q', 'HEAD'])) || null
  let prompt: string
  let base = ''
  if (kind === 'commit') {
    const stagedSummary = await out(c, ['diff', '--cached', '--name-status'])
    if (!stagedSummary) return { ok: false, code: 'noStaged' }
    prompt = buildCommitMessagePrompt({ branch, stagedSummary, stagedPatch: await patchOf(c, ['--cached']) })
  } else {
    const b = await branchContext(c)
    if (kind === 'mr') {
      if (!b) return { ok: false, code: 'noBase' }
      if (!b.commits) return { ok: false, code: 'noBranchChanges' }
      base = b.base
      prompt = buildMrPrompt({ branch, base: b.base, commitSummary: b.commits, changeSummary: b.files, patch: b.patch })
    } else {
      // 브랜치 이름 — 이 브랜치의 커밋·바뀐 파일 + 아직 안 올린 변경(첫 커밋 전에도 지을 수 있게).
      const working = await out(c, ['status', '--short'])
      const work = [b?.commits && `Commits:\n${b.commits}`, b?.files && `Changed files:\n${b.files}`, working && `Uncommitted changes:\n${working}`].filter(Boolean).join('\n\n')
      if (!work) return { ok: false, code: 'noBranchChanges' }
      prompt = buildBranchNamePrompt(work.slice(0, 8_000))
    }
  }
  if (c.signal?.aborted) return { ok: false, code: 'canceled', agent }
  const r = await runAgent(c, agent, prompt)
  const bad = failureOf(r, c, agent)
  if (bad) return bad
  if (kind === 'commit') {
    const text = commitMessageOf(r.stdout)
    return text ? { ok: true, agent, text } : { ok: false, code: 'empty', agent, message: failureExcerpt(r.stdout, r.stderr) }
  }
  if (kind === 'mr') {
    try {
      return { ok: true, agent, ...parseMrFields(r.stdout, base) }
    } catch {
      return { ok: false, code: 'empty', agent, message: failureExcerpt(r.stdout, r.stderr) }
    }
  }
  const slug = sanitizeBranchSlug(r.stdout)
  return slug ? { ok: true, agent, slug } : { ok: false, code: 'empty', agent, message: failureExcerpt(r.stdout, r.stderr) }
}

/** 브랜치 이름 바꾸기 — 사용자가 [이름 바꾸기]를 눌렀을 때만. git 의 이름 규칙(check-ref-format)으로 거른다. */
export async function renameBranch(root: string, name: string, x: Exec): Promise<{ ok: boolean; message?: string }> {
  const c: Ctx = { root, x, remote: false, settings: undefined as never }
  if (!name || name.startsWith('-') || (await git(c, ['check-ref-format', '--branch', name])).code !== 0) return { ok: false, message: 'badTarget' }
  const r = await git(c, ['branch', '-m', name])
  return r.code === 0 ? { ok: true, message: name } : { ok: false, message: (r.stderr || r.stdout).trim() || 'rename failed' }
}
