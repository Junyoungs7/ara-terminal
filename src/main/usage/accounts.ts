// M13 계정 여러 개(Claude·Codex) — Orca claude-accounts·codex-accounts 의 모양: 계정마다 아라가 만든 설정 폴더(userData/accounts/<cli>/<id>)를 두고,
// 실행 env(CLAUDE_CONFIG_DIR·CODEX_HOME)로 고른다. 고른 계정은 그 뒤 새로 띄우는 에이전트에 쓰인다(이미 도는 탭은 그대로 — Orca 와 같다).
// 🔴 사용자 기본 폴더(~/.claude·~/.codex)에는 쓰지 않는다 — '시스템 기본' 은 env 를 안 붙이는 것. 읽기만: 새 계정 폴더에 Claude settings.json·CLAUDE.md,
//    Codex config.toml 을 복사해 둔다(Orca 는 링크·미러 — 아라는 복사. 링크(junction)는 계정을 지울 때 원본까지 지울 위험이 있다).
// 🔴 토큰은 아라가 저장하지 않는다. 로그인은 각 CLI 의 로그인 명령(claude auth login --claudeai · codex login)을 그 폴더 env 로 돌린다 — CLI 가 브라우저를 연다.
// 뺀 것: 계정 자동 감지(관찰한 설정 폴더)·WSL·원격 실행 계정(원격 서버는 서버 쪽 로그인)·키체인·Codex 장치 인증·Claude 붙여넣기 코드 로그인.
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
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
  /** 에이전트 실행에 붙일 env — 시스템 기본이면 빈 객체. Codex 는 붙이기 전에 config.toml 을 다시 복사한다. */
  launchEnv(p: AccountProvider): Record<string, string>
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

/** 원본이 있고 대상이 없거나 더 오래됐으면 복사(원본은 읽기만). */
function copyIfNewer(src: string, dst: string, onlyIfMissing = false): void {
  try {
    if (!existsSync(src)) return
    if (existsSync(dst) && (onlyIfMissing || statSync(dst).mtimeMs >= statSync(src).mtimeMs)) return
    copyFileSync(src, dst)
  } catch {
    /* 복사 실패는 그 설정 없이 띄운다 */
  }
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
  const seed = (p: AccountProvider, dir: string, onlyIfMissing: boolean): void => {
    const src = deps.defaultDir(p)
    if (p === 'claude') for (const f of ['settings.json', 'CLAUDE.md']) copyIfNewer(join(src, f), join(dir, f), onlyIfMissing)
    else copyIfNewer(join(src, 'config.toml'), join(dir, 'config.toml'))
  }

  return {
    view: () => view,
    add(p, label) {
      const id = randomUUID()
      const dir = pathOf(p, id)
      mkdirSync(dir, { recursive: true })
      seed(p, dir, true)
      view = { ...view, [p]: { ...view[p], list: [...view[p].list, { id, label: labelOf(label) || `${p} ${view[p].list.length + 1}` }] } }
      commit()
      return id
    },
    remove(p, id) {
      if (!has(p, id)) return
      const dir = resolve(pathOf(p, id))
      // 아라 계정 폴더 안일 때만 지운다(경로 이탈 금지). 링크를 만들지 않으므로 지워도 바깥은 안 다친다.
      const rel = relative(resolve(root), dir)
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) rmSync(dir, { recursive: true, force: true })
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
    launchEnv(p) {
      const id = view[p].active
      if (!id || !has(p, id)) return {}
      const dir = pathOf(p, id)
      mkdirSync(dir, { recursive: true })
      if (p === 'codex') seed(p, dir, false)
      return { [ACCOUNT_ENV[p]]: dir }
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
