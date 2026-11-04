// M13 계정 여러 개(Claude·Codex) — Orca claude-accounts·codex-accounts 의 모양: 계정마다 아라가 만든 설정 폴더(userData/accounts/<cli>/<id>)를 두고,
// 실행 env(CLAUDE_CONFIG_DIR·CODEX_HOME)로 고른다. 고른 계정은 그 뒤 새로 띄우는 에이전트에 쓰인다(이미 도는 탭은 그대로 — 바꾸려면 R0 '다른 계정으로 이어서').
// 🔴 사용자 기본 폴더(~/.claude·~/.codex)의 설정은 바꾸지 않는다 — '시스템 기본' 은 env 를 안 붙이는 것. 예외 하나: 아래 R0 대화 기록(Claude 가 원래 쓰는 자리로 합침).
// M13 R2 공유(Orca claude-profile-provisioning·claude-profile-sharing·codex-home-paths 와 같은 목록): 기본 폴더의 **폴더**(agents·commands·skills·plugins…)는
//    계정 폴더에 링크(Windows junction, 그 밖 symlink)로 걸고, **파일**(settings.json·CLAUDE.md·Codex config.toml·AGENTS.md…)은 복사한다
//    (편집기 저장이 rename-replace 라 파일 링크는 끊긴다 — Orca 와 같은 이유). 자격·세션 등 계정별 항목은 걸지도 복사하지도 않는다(CLAUDE_PRIVATE).
// 원격 3차 R0 대화 기록 공유(Orca claude-profile-history.ts shareClaudeProfileHistory): Claude 히스토리 폴더(projects·transcripts…, CLAUDE_HISTORY)는
//    공용 공유 목록이 아니라 **전용 길**로 기본 폴더에 합친 뒤 계정 폴더에서 링크한다 — 계정을 바꿔 `--resume <id>` 해도 대화를 찾는다.
//    이 한 가지는 기본 폴더(~/.claude/projects 등 — Claude 가 원래 쓰는 자리)에 기록을 옮겨 넣는다. 충돌 항목은 덮지 않고 계정 폴더 `<이름>.ara-merge` 에 남긴다.
//    Codex 는 공유하지 않는다 — 재개할 때 그 rollout 을 대상 CODEX_HOME 에 복사한다(Orca prepareCodexAccountRestartResume, codexResume).
// 🔴 링크가 있으니 계정 폴더는 **removeAccountTree 로만** 지운다 — 링크는 끊기만 하고 따라 들어가지 않는다(따라 들어가면 원본 ~/.claude 가 지워진다).
// 🔴 토큰은 아라가 저장하지 않는다. 로그인은 각 CLI 의 로그인 명령(claude auth login --claudeai · codex login)을 그 폴더 env 로 돌린다 — CLI 가 브라우저를 연다.
// 뺀 것: 계정 자동 감지(관찰한 설정 폴더)·WSL·원격 실행 계정(원격 서버는 서버 쪽 로그인)·키체인·Codex 장치 인증·Claude 붙여넣기 코드 로그인.
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import { runProcess, type RunOptions, type RunResult } from '../util/runProcess'
import { ACCOUNT_PROVIDERS, EMPTY_ACCOUNTS, type AccountProvider, type AccountsView } from '@shared/usage'

export const ACCOUNT_ENV: Record<AccountProvider, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const MAX_LABEL = 40

type Run = (file: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>

export type AccountsFeature = {
  view(): AccountsView
  add(p: AccountProvider, label: string): string
  remove(p: AccountProvider, id: string): void
  rename(p: AccountProvider, id: string, label: string): void
  select(p: AccountProvider, id: string | null): void
  /** 그 계정의 설정 폴더(없으면 null). id 를 안 주면 지금 고른 계정. 고른 게 시스템 기본이면 null. */
  dir(p: AccountProvider, id?: string | null): string | null
  /**
   * 에이전트 실행에 붙일 env — 시스템 기본이면 빈 객체. Codex 는 붙이기 전에 config.toml 을 다시 복사한다.
   * account: 안 주면 고른 계정, null = 시스템 기본, id = 그 계정(R0 다른 계정으로 이어서). 없는 id 는 고른 계정으로.
   * resume(Codex): 그 rollout 이 대상 폴더에 없으면 다른 폴더(기본·다른 계정)에서 복사해 둔다 — 같은 대화로 이어 띄우게.
   */
  launchEnv(p: AccountProvider, account?: string | null, resume?: string): Record<string, string>
  /** 그 계정 폴더로 CLI 로그인 명령을 돌린다(끝날 때까지). */
  login(p: AccountProvider, id: string): Promise<{ ok: boolean; error?: string }>
}

export const labelOf = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_LABEL) : '')

function viewOf(v: unknown): AccountsView {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<AccountProvider, { active?: unknown; list?: unknown }>>
  const out = structuredClone(EMPTY_ACCOUNTS)
  for (const p of ACCOUNT_PROVIDERS) {
    const list = Array.isArray(o[p]?.list) ? (o[p]!.list as { id?: unknown; label?: unknown }[]) : []
    out[p].list = list.filter((a) => typeof a?.id === 'string' && /^[a-f0-9-]{8,64}$/.test(a.id)).map((a) => ({ id: a.id as string, label: labelOf(a.label) || (a.id as string).slice(0, 8) }))
    const active = o[p]?.active
    out[p].active = typeof active === 'string' && out[p].list.some((a) => a.id === active) ? active : null
  }
  return out
}

// Orca claude-profile-provisioning CLAUDE_RUNTIME_STATE_ENTRIES — 계정마다 따로 두는 것(자격·실행 상태).
// settings.json 은 공유하지만 아래 seed 가 따로 복사한다(Orca copySettings). history.jsonl(프롬프트 기록)·sessions(살아 있는 프로세스 대장)는 계정별로 남긴다.
// ponytail: history.jsonl 병합(Orca mergeClaudeProfilePromptHistory)은 뺐다 — ↑ 키 이전 프롬프트만 계정별이다. 필요해지면 그 병합을 옮긴다.
const CLAUDE_PRIVATE: ReadonlySet<string> = new Set([
  '.claude.json', '.claude.json.backup', '.credentials.json', '.session_ingress_token', 'active-time.json', 'antproto.json', 'api-dumps', 'backups', 'bridge-spawn',
  'cache', 'ccr', 'ccr-home-seed.json', 'chrome', 'computer-use.lock', 'daemon', 'debug', 'downloads', 'dump-prompts', 'feedback', 'feedback-bundles',
  'file-transfers', 'gh-pr-status-cache.json', 'hfi-auth.json', 'history.jsonl', 'ide', 'image-cache', 'jobs', 'local', 'local-settings', 'logs', 'loop.md',
  'mcp-discovery-cache', 'mcp-needs-auth-cache.json', 'mcp-skill-archives', 'policy-limits.json', 'project-settings', 'remote',
  'remote-control', 'remote-settings.json', 'scratch', 'seed-admin', 'server-sessions.json', 'server.lock', 'sessions', 'shares',
  'startup-perf', 'state', 'stats-cache.json', 'statsig', 'storage-v2', 'systemd', 'teams', 'telemetry', 'traces', 'uploads',
  'usage-data', 'settings.json'
])
/** Orca CLAUDE_PROFILE_HISTORY_DIRS — 기본 폴더로 합쳐 모든 계정이 같이 보는 대화 기록(shareClaudeHistory). sessions 는 뺀다(폴더마다의 프로세스 대장). */
export const CLAUDE_HISTORY = ['projects', 'session-env', 'file-history', 'shell-snapshots', 'todos', 'paste-cache', 'tasks', 'plans', 'transcripts'] as const
const HISTORY: ReadonlySet<string> = new Set(CLAUDE_HISTORY)
/** Orca isSharedEntry — 숨은 항목·daemon*·agent-memory* 도 계정별. 히스토리 폴더는 공용 링크가 아니라 shareClaudeHistory 가 다룬다. */
export const isClaudeShared = (name: string): boolean =>
  !CLAUDE_PRIVATE.has(name) && !HISTORY.has(name) && !name.startsWith('.') && !name.startsWith('daemon') && !name.startsWith('agent-memory')
/** Orca codex-home-paths CODEX_SYSTEM_RESOURCE_ENTRIES + config.toml(Orca config-mirror). 이 밖(auth.json·sessions·history.jsonl…)은 계정별. */
export const CODEX_SHARED = ['skills', 'hooks', 'plugins', 'plugin-state', 'profile-v2', 'themes', 'prompts', join('.tmp', 'bundled-marketplaces'), 'AGENTS.md', 'config.toml'] as const

/** 내용이 다르면 복사(원본은 읽기만). 대상이 링크면 사용자가 건 것 — 손대지 않는다. */
function syncFile(src: string, dst: string): void {
  try {
    if (!statSync(src, { throwIfNoEntry: false })?.isFile()) return
    const st = lstatSync(dst, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) return
    if (st && readFileSync(dst).equals(readFileSync(src))) return
    copyFileSync(src, dst)
  } catch {
    /* 복사 실패는 그 설정 없이 띄운다 */
  }
}

/** Orca linkClaudeProfileDirectory — 없거나 빈 폴더면 링크, 살아 있는 링크는 그대로, 내용 있는 폴더는 사용자(또는 CLI) 것이라 그대로. */
function linkDir(src: string, dst: string, win: boolean): void {
  try {
    const st = lstatSync(dst, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) {
      if (existsSync(dst)) return
      unlinkLink(dst) // 끊어진 링크만 지운다
    } else if (st) {
      if (!st.isDirectory() || readdirSync(dst).length > 0) return
      rmdirSync(dst)
    }
    mkdirSync(dirname(dst), { recursive: true })
    symlinkSync(src, dst, win ? 'junction' : 'dir')
  } catch {
    /* 못 걸면 그 확장 없이 띄운다 */
  }
}

/** 링크(junction·symlink) 자체만 지운다 — 대상 내용은 건드리지 않는다. */
function unlinkLink(p: string): void {
  try {
    unlinkSync(p)
  } catch {
    rmdirSync(p) // 디렉터리 junction 이 unlink 로 안 빠지는 경우 — rmdir 도 링크만 뺀다(재귀 아님)
  }
}

/**
 * 계정 폴더를 지우는 **유일한** 길. lstat 으로 보고 링크는 끊기만 하며 절대 따라 들어가지 않는다 — 진짜 폴더만 안으로 내려간다.
 * rmSync recursive·RMDir /r 같은 재귀 삭제에 맡기지 않는다(2026-09-29 junction 째로 재귀 삭제해 원본 node_modules 가 통째로 지워진 사고).
 */
export function removeAccountTree(p: string): void {
  const st = lstatSync(p, { throwIfNoEntry: false })
  if (!st) return
  if (st.isSymbolicLink()) return unlinkLink(p)
  if (!st.isDirectory()) return unlinkSync(p)
  for (const n of readdirSync(p)) removeAccountTree(join(p, n))
  rmdirSync(p)
}

const MERGE_SUFFIX = '.ara-merge'
const lstatOf = (p: string) => lstatSync(p, { throwIfNoEntry: false })

/** Orca moveHistoryTree — 없는 자리로만 옮긴다(rename). 같은 이름이 있으면 폴더끼리는 안으로, 아니면 **그대로 남긴다**(덮지 않는다). 남긴 수를 돌려준다. */
function moveTree(src: string, dst: string): number {
  let kept = 0
  for (const item of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, item.name)
    const to = join(dst, item.name)
    try {
      const there = lstatOf(to)
      if (!there) renameSync(from, to)
      else if (item.isDirectory() && there.isDirectory() && !there.isSymbolicLink()) kept += moveTree(from, to)
      else kept++
    } catch {
      kept++ // 잠긴 파일·다른 드라이브(EXDEV) — 그 자리에 남긴다
    }
  }
  if (readdirSync(src).length === 0) rmdirSync(src)
  return kept
}

/**
 * Orca mergeClaudeProfileDirectory — 계정 폴더의 히스토리 폴더 `name` 을 기본 폴더 쪽으로 합치고 그 자리에 링크를 건다.
 * 순서: 계정 폴더 것을 `<name>.ara-merge` 로 비켜 두고 → 링크 → 비켜 둔 것을 기본 쪽으로 옮김(충돌은 .ara-merge 에 남음).
 * 링크를 못 걸면 비켜 둔 것을 제자리로 돌린다 — 계정은 예전처럼(기록만 따로) 돈다. 사용자가 건 링크·폴더 아닌 것은 그대로.
 * @returns 링크가 기본 폴더를 가리키게 됐나
 */
export function shareHistoryDir(profile: string, home: string, name: string, win: boolean, link: typeof symlinkSync = symlinkSync): boolean {
  const source = join(profile, name)
  const dest = join(home, name)
  const pending = source + MERGE_SUFFIX
  mkdirSync(dest, { recursive: true })
  if (lstatOf(pending)?.isDirectory() && lstatOf(source)?.isSymbolicLink()) moveTree(pending, dest) // 지난번 못 옮긴 것 — 다시 시도
  const cur = lstatOf(source)
  if (cur?.isSymbolicLink()) return true
  if (cur && !cur.isDirectory()) return false
  if (cur) {
    if (lstatOf(pending)) return false // 지난 충돌이 남아 있는데 CLI 가 폴더를 다시 만들었다 — 계정을 그대로 둔다(사람이 정리)
    renameSync(source, pending)
  }
  try {
    link(dest, source, win ? 'junction' : 'dir')
  } catch {
    if (cur && !lstatOf(source)) renameSync(pending, source)
    return false
  }
  if (cur) moveTree(pending, dest)
  return true
}

/** 히스토리 폴더 전부(Orca shareClaudeProfileHistory). 하나가 실패해도 나머지는 한다. */
export function shareClaudeHistory(profile: string, home: string, win: boolean): void {
  for (const n of CLAUDE_HISTORY) {
    try {
      shareHistoryDir(profile, home, n, win)
    } catch {
      /* 그 폴더만 계정별로 남는다 */
    }
  }
}

/** Codex rollout(sessions/Y/M/D/rollout-…-<id>.jsonl)의 sessions 아래 상대 경로. 없으면 null. */
export function findCodexRollout(home: string, threadId: string): string | null {
  const root = join(home, 'sessions')
  const tail = `-${threadId}.jsonl`
  const ls = (p: string): string[] => {
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  }
  for (const y of ls(root)) for (const m of ls(join(root, y))) for (const d of ls(join(root, y, m))) {
    const f = ls(join(root, y, m, d)).find((n) => n.startsWith('rollout-') && n.endsWith(tail))
    if (f) return join(y, m, d, f)
  }
  return null
}

export function createAccountsFeature(deps: {
  userData: string
  /** 시스템 기본 폴더(복사 원본) — CLAUDE_CONFIG_DIR·CODEX_HOME 또는 홈 아래. */
  defaultDir: (p: AccountProvider) => string
  run?: Run
  platform?: NodeJS.Platform
  onChange?: (v: AccountsView) => void
}): AccountsFeature {
  const file = join(deps.userData, 'usage-accounts.json')
  const root = join(deps.userData, 'accounts')
  let view = viewOf(readJsonWithBackup<unknown>(file, null))
  const run = deps.run ?? runProcess
  const win = (deps.platform ?? process.platform) === 'win32'
  const commit = (): void => {
    writeJsonAtomic(file, view)
    deps.onChange?.(view)
  }
  const pathOf = (p: AccountProvider, id: string): string => join(root, p, id)
  const has = (p: AccountProvider, id: string): boolean => view[p].list.some((a) => a.id === id)
  /** 기본 폴더의 공유 항목을 계정 폴더에 건다(폴더 = 링크, 파일 = 복사). 만들 때와 띄울 때마다 — 나중에 깐 스킬·플러그인도 따라온다. */
  const seed = (p: AccountProvider, dir: string): void => {
    const src = deps.defaultDir(p)
    // R0 대화 기록은 기본 폴더가 아직 없어도 건다(shareHistoryDir 가 기본 쪽 폴더를 만든다 — Claude 가 원래 쓰는 자리).
    if (p === 'claude') shareClaudeHistory(dir, src, win)
    let names: string[]
    try {
      names = p === 'claude' ? [...readdirSync(src).filter(isClaudeShared), 'settings.json'] : [...CODEX_SHARED]
    } catch {
      return // 기본 폴더가 없다
    }
    for (const n of names) {
      const s = join(src, n)
      const st = statSync(s, { throwIfNoEntry: false })
      if (st?.isDirectory()) linkDir(s, join(dir, n), win)
      else if (st?.isFile()) syncFile(s, join(dir, n))
    }
  }
  /** Orca prepareCodexAccountRestartResume — 대상에 없으면 아는 다른 폴더에서 rollout 을 복사(원본은 그대로, 대상에 있으면 손대지 않는다). */
  const codexResume = (threadId: string, target: string): void => {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(threadId) || findCodexRollout(target, threadId)) return
    for (const home of [deps.defaultDir('codex'), ...view.codex.list.map((a) => pathOf('codex', a.id))]) {
      const rel = home === target ? null : findCodexRollout(home, threadId)
      if (!rel) continue
      try {
        mkdirSync(dirname(join(target, 'sessions', rel)), { recursive: true })
        copyFileSync(join(home, 'sessions', rel), join(target, 'sessions', rel))
      } catch {
        /* 못 옮기면 CLI 가 '못 찾음'을 말한다 */
      }
      return
    }
  }

  return {
    view: () => view,
    add(p, label) {
      const id = randomUUID()
      const dir = pathOf(p, id)
      mkdirSync(dir, { recursive: true })
      seed(p, dir)
      view = { ...view, [p]: { ...view[p], list: [...view[p].list, { id, label: labelOf(label) || `${p} ${view[p].list.length + 1}` }] } }
      commit()
      return id
    },
    remove(p, id) {
      if (!has(p, id)) return
      const dir = resolve(pathOf(p, id))
      // 아라 계정 폴더 안일 때만 지운다(경로 이탈 금지). 안에 원본으로 가는 링크가 있다 — removeAccountTree 가 링크부터 끊는다.
      const rel = relative(resolve(root), dir)
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        try {
          removeAccountTree(dir)
        } catch {
          /* 잠긴 파일(로그인 중인 CLI 등) — 남은 것은 그대로 두고 목록에서는 뺀다 */
        }
      }
      view = { ...view, [p]: { active: view[p].active === id ? null : view[p].active, list: view[p].list.filter((a) => a.id !== id) } }
      commit()
    },
    rename(p, id, label) {
      const l = labelOf(label)
      if (!has(p, id) || !l) return
      view = { ...view, [p]: { ...view[p], list: view[p].list.map((a) => (a.id === id ? { ...a, label: l } : a)) } }
      commit()
    },
    select(p, id) {
      if (id !== null && !has(p, id)) return
      view = { ...view, [p]: { ...view[p], active: id } }
      commit()
    },
    dir(p, id) {
      const pick = id === undefined ? view[p].active : id
      return pick && has(p, pick) ? pathOf(p, pick) : null
    },
    launchEnv(p, account, resume) {
      const id = account === undefined || (account !== null && !has(p, account)) ? view[p].active : account
      const dir = id && has(p, id) ? pathOf(p, id) : null
      if (dir) {
        mkdirSync(dir, { recursive: true })
        seed(p, dir)
      }
      if (p === 'codex' && resume) codexResume(resume, dir ?? deps.defaultDir('codex'))
      return dir ? { [ACCOUNT_ENV[p]]: dir } : {}
    },
    async login(p, id) {
      if (!has(p, id)) return { ok: false, error: '없는 계정' }
      const dir = pathOf(p, id)
      mkdirSync(dir, { recursive: true })
      // Orca claude-login-session: `claude auth login --claudeai` · codex-login-session: `codex login`. 브라우저는 CLI 가 연다.
      const [bin, args] = p === 'claude' ? ['claude', ['auth', 'login', '--claudeai']] : ['codex', ['login']]
      // Windows npm 셔임(.cmd)은 cmd 없이 못 뜬다(detect.ts 와 같은 이유) — 이름은 표의 상수라 셸 주입 자리가 없다.
      const r = win
        ? await run(process.env['ComSpec'] || 'cmd.exe', ['/d', '/c', bin, ...args], { env: { [ACCOUNT_ENV[p]]: dir }, timeoutMs: LOGIN_TIMEOUT_MS })
        : await run(bin, args, { env: { [ACCOUNT_ENV[p]]: dir }, timeoutMs: LOGIN_TIMEOUT_MS })
      if (r.error) return { ok: false, error: r.error.message }
      const credFile = p === 'claude' ? '.credentials.json' : 'auth.json'
      return existsSync(join(dir, credFile)) ? { ok: true } : { ok: false, error: '로그인이 끝나지 않았습니다' }
    }
  }
}
