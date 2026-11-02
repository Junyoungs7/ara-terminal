// M14 R2 `ara` CLI — 아라(main)와 CLI 가 같이 읽는 계약. node 모듈을 쓰지 않는다(렌더러도 설치 상태 모양을 읽는다).
// Orca src/shared/runtime-bootstrap.ts(메타데이터 파일·transport)·cli-install-types·cli-install-path-format(orcaRef ec112c6b01)의 아라판.
//
// 길: 아라가 켜지면 userData 에 `ara-runtime.json`(파이프 이름·토큰·pid)을 쓰고, CLI 는 그 파일을 읽어 파이프에
// 한 줄 JSON 요청을 보낸다(Orca 와 같은 NDJSON — {id, authToken, method, params} → {id, ok, result|error}).

/** Orca PRIMARY_RUNTIME_METADATA_FILE. 아라 userData 안. */
export const CLI_RUNTIME_FILE = 'ara-runtime.json'

export type CliTransport = { kind: 'named-pipe' | 'unix'; endpoint: string }

/** Orca RuntimeMetadata 의 아라판. */
export type CliRuntimeMetadata = {
  runtimeId: string
  pid: number
  transports: CliTransport[]
  authToken: string
  startedAt: number
  appVersion: string
}

export type CliRequest = { id: string; authToken: string; method: string; params?: unknown }
export type CliError = { code: string; message: string; nextSteps?: string[] }
export type CliResponse<T = unknown> = { id: string; ok: true; result: T } | { id: string; ok: false; error: CliError }

/** CLI 가 파이프로 부를 수 있는 것(main/cli/handlers.ts). 렌더러 IPC 와 따로다. */
export const CLI_METHODS = [
  'status.get',
  'repo.list',
  'worktree.list',
  'worktree.show',
  'worktree.create',
  'worktree.set',
  'worktree.rm',
  'terminal.list',
  'terminal.create',
  'terminal.send',
  'terminal.read',
  'agent.launch'
] as const
export type CliMethod = (typeof CLI_METHODS)[number]

/** 한 요청 줄 상한 — 파이프 너머(같은 사용자) 값이라도 main 힙을 무한히 먹지 않게. MCP_MAX_BODY_BYTES 와 같은 크기. */
export const CLI_MAX_LINE_BYTES = 1024 * 1024

// ── CLI 등록(PATH) ─────────────────────────────────────────────────────────────

/**
 * Orca CliInstallStatus 의 아라판. state:
 *  · installed     = 사용자 PATH 에 아라 bin 폴더가 있다
 *  · not_installed = 없다
 *  · unsupported   = 설치본이 아니거나(개발 실행) Windows 가 아니다
 *  · unknown       = 사용자 PATH 를 못 읽었다(그때는 쓰지 않는다)
 */
export type CliInstallState = 'installed' | 'not_installed' | 'unsupported' | 'unknown'
export type CliInstallStatus = {
  state: CliInstallState
  /** 사용자 PATH 에 넣는 폴더 = 설치 폴더의 resources\bin(ara.cmd 가 있다). */
  binDir: string | null
  /** 같은 이름(ara.cmd·ara.exe 등)이 PATH 앞쪽 다른 폴더에 있어 가려질 때 그 경로. */
  shadowedBy: string | null
  detail: string | null
}

/** Orca splitPathEntries('win32') — 빈 칸은 버린다. */
export function splitPathEntries(value: string | null | undefined): string[] {
  return (value ?? '').split(';').filter((e) => e.trim().length > 0)
}

/** Windows PATH 항목 비교 — 대소문자·끝 \ 무시, %VAR% 는 주어진 env 로 풀어 본다(Orca samePathEntry 의 win32 몫). */
export function samePathEntry(a: string, b: string, env: Record<string, string | undefined> = {}): boolean {
  const norm = (p: string): string =>
    p
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/%([^%]+)%/g, (m, name: string) => {
        const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
        return key ? (env[key] ?? m) : m
      })
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase()
  return norm(a) === norm(b)
}

/** 붙이기 — 이미 있으면 null(쓸 것 없음). 다른 항목은 바이트 그대로 둔다. */
export function withPathEntry(current: string | null, dir: string, env: Record<string, string | undefined> = {}): string | null {
  const entries = splitPathEntries(current)
  if (entries.some((e) => samePathEntry(e, dir, env))) return null
  return [...entries, dir].join(';')
}

/** 빼기 — 없으면 null(쓸 것 없음). 우리 폴더만 빼고 나머지는 순서·글자 그대로. */
export function withoutPathEntry(current: string | null, dir: string, env: Record<string, string | undefined> = {}): string | null {
  const entries = splitPathEntries(current)
  const next = entries.filter((e) => !samePathEntry(e, dir, env))
  return next.length === entries.length ? null : next.join(';')
}

// ── 번들 스킬 ───────────────────────────────────────────────────────────────────

/** Orca 번들 스킬 orca-cli 의 아라판 이름(resources/skills/ara-cli/SKILL.md). */
export const BUNDLED_CLI_SKILL = 'ara-cli'
/** 설치 상태 — 대상 뿌리별. differs = 같은 이름 폴더가 있는데 번들 판과 내용이 다르다(업데이트 대상). */
export type BundledSkillState = 'missing' | 'installed' | 'differs'
export type BundledSkillStatus = { available: boolean; targets: { rootId: string; path: string; state: BundledSkillState }[] }
