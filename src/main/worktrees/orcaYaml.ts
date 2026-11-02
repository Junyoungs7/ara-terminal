// 3차 WS-23 저장소 설정 파일 — Orca 와 **같은 파일 `orca.yaml`** 을 읽는다(아라 이름 파일을 따로 두지 않는다: 팀이 Orca·아라를 섞어 써도
// 저장소에 체크인한 한 파일로 같게 동작한다). 출처: stablyai/orca @ec112c6b01 (MIT)
//  · src/shared/orca-yaml.ts parseOrcaYaml·normalizeSharedDirectories, orca-yaml-file-limit.ts(256KiB·필드 64KiB)
//  · src/main/setup-runner-script-text.ts buildWindowsRunnerScript·buildPosixRunnerScript, setup-hook-env-vars.ts getSetupEnvVars
//  · src/main/hooks.ts runHook(archive 120초)
// 아라가 쓰는 칸: scripts.setup·scripts.archive·setupAgentStartupPolicy·worktree.sharedDirectories.
// 안 쓰는 칸: defaultTabs(아라 AI 공간엔 셸 탭이 없다)·issueCommand(이슈 연동 없음)·environmentRecipes(클라우드 VM 없음).
// 파서는 js-yaml(electron-updater 가 이미 끌어온 것) — Orca 의 `yaml` 과 같게 중복 키는 파일째 거절한다. alias 확장 상한(100)은 뺐다:
// js-yaml 은 alias 를 복사하지 않고 같은 객체를 가리켜 확장 폭탄이 생기지 않는다.
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { load } from 'js-yaml'
import { runProcess, type RunResult } from '../util/runProcess'
import type { OrcaYaml } from '@shared/worktrees'

export const ORCA_YAML_FILE = 'orca.yaml'
const MAX_FILE_CHARS = 256 * 1024
const MAX_FIELD_CHARS = 64 * 1024
const MAX_SHARED_DIRECTORIES = 100
/** Orca HOOK_TIMEOUT — archive 는 지우기를 막으므로 짧게. */
export const ARCHIVE_TIMEOUT_MS = 120_000
/** setup 은 Orca 가 터미널에서 시간 상한 없이 돈다 — 아라는 터미널 없이 돌리므로 상한을 둔다. ponytail: 30분, 더 긴 설치가 나오면 늘린다. */
export const SETUP_TIMEOUT_MS = 30 * 60_000
const HOOK_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8')
const asRecord = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
function asTrimmedString(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > MAX_FIELD_CHARS || utf8Bytes(v) > MAX_FIELD_CHARS) return undefined
  return v.trim() || undefined
}

/** Orca normalizeSharedDirectories — 안의 `./`·`.`·`..`·빈 조각·`.git` 은 거절(접지 않는다), 앞 100개만. */
function normalizeSharedDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value.slice(0, MAX_SHARED_DIRECTORIES)) {
    const raw = asTrimmedString(entry)
    if (!raw) continue
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    const segments = normalized.split('/')
    if (
      !normalized ||
      normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized) ||
      segments.includes('..') ||
      segments.includes('.') ||
      segments.includes('') ||
      segments.includes('.git')
    ) {
      continue
    }
    seen.add(normalized)
  }
  return Array.from(seen)
}

/** Orca parseOrcaYaml — YAML 오류·중복 키·mapping 아닌 뿌리·크기 초과면 null(파일째). 잘못된 칸만 빠지고 나머지는 산다. */
export function parseOrcaYaml(content: string): OrcaYaml | null {
  if (content.length > MAX_FILE_CHARS || utf8Bytes(content) > MAX_FILE_CHARS) return null
  let root: unknown
  try {
    root = load(content)
  } catch {
    return null
  }
  const record = asRecord(root)
  if (!record) return null
  const scripts = asRecord(record.scripts)
  const setup = scripts ? asTrimmedString(scripts.setup) : undefined
  const archive = scripts ? asTrimmedString(scripts.archive) : undefined
  const policy = record.setupAgentStartupPolicy === 'start-immediately' || record.setupAgentStartupPolicy === 'wait-for-setup' ? record.setupAgentStartupPolicy : undefined
  const wt = asRecord(record.worktree)
  const sharedDirectories = wt ? normalizeSharedDirectories(wt.sharedDirectories) : []
  if (!setup && !archive && !policy && sharedDirectories.length === 0) return null
  return {
    scripts: { ...(setup ? { setup } : {}), ...(archive ? { archive } : {}) },
    ...(policy ? { setupAgentStartupPolicy: policy } : {}),
    ...(sharedDirectories.length > 0 ? { worktree: { sharedDirectories } } : {})
  }
}

/** 저장소(또는 워크트리) 뿌리의 orca.yaml. 없음 = found false, 있는데 못 읽음 = yaml null. */
export async function readOrcaYaml(dir: string): Promise<{ found: boolean; yaml: OrcaYaml | null }> {
  const path = join(dir, ORCA_YAML_FILE)
  const st = await lstat(path).catch(() => null)
  if (!st?.isFile()) return { found: false, yaml: null }
  if (st.size > MAX_FILE_CHARS * 4) return { found: true, yaml: null }
  try {
    return { found: true, yaml: parseOrcaYaml(await readFile(path, 'utf8')) }
  } catch {
    return { found: true, yaml: null }
  }
}

/** 승인 기록 열쇠 — 스크립트 글 그대로의 sha256. 한 글자라도 바뀌면 다시 묻는다. */
export const scriptHash = (script: string): string => createHash('sha256').update(script, 'utf8').digest('hex')

/** Orca getSetupEnvVars — CONDUCTOR·GHOSTX 는 Orca 가 둔 호환 별칭 그대로. */
export function setupEnvVars(rootPath: string, worktreePath: string): Record<string, string> {
  return {
    ORCA_ROOT_PATH: rootPath,
    ORCA_WORKTREE_PATH: worktreePath,
    ORCA_WORKSPACE_NAME: basename(worktreePath),
    CONDUCTOR_ROOT_PATH: rootPath,
    GHOSTX_ROOT_PATH: rootPath
  }
}

const isShebangLine = (line: string): boolean => line.startsWith('#!')

/** Orca buildWindowsRunnerScript — 줄마다 `call`, 실패하면 바로 멈춘다. `#!` 로 시작하면 cmd 로 못 돌린다고 거절(Git Bash 갈래는 뺐다). */
export function buildWindowsRunnerScript(script: string): string {
  const header = '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n'
  const lines = script.split(/\r?\n/)
  if (isShebangLine((lines[0] ?? '').trim())) {
    return `${header}echo Ara setup: this script starts with a "#!" interpreter line, so it needs a POSIX shell. 1>&2\r\necho Ara setup: cmd.exe cannot execute it; rewrite the script in cmd syntax. 1>&2\r\nexit /b 1\r\n`
  }
  let out = header
  for (const raw of lines) {
    const command = raw.trim()
    out += command ? `call ${command}\r\nif errorlevel 1 exit /b %errorlevel%\r\n` : '\r\n'
  }
  return out
}

/** Orca buildPosixRunnerScript — bash + set -e. 셔뱅의 셸 옵션 재생은 뺐다(첫 줄 셔뱅은 bash 가 주석으로 읽는다). */
export function buildPosixRunnerScript(script: string): string {
  return `#!/usr/bin/env bash\nset -e\n${script.replace(/\r\n/g, '\n')}\n`
}

/**
 * 스크립트를 셸 파일로 써서 돌린다(runProcess — 창 없음·시간 상한·출력 상한). cwd = 워크트리. 출력은 오는 대로 onOutput.
 * 실행 파일은 임시 폴더에 쓰고 끝나면 지운다(워크트리를 더럽히지 않게).
 */
export async function runOrcaScript(
  script: string,
  o: { cwd: string; rootPath: string; timeoutMs: number; platform?: string; onOutput?: (s: string) => void }
): Promise<RunResult> {
  const win = (o.platform ?? process.platform) === 'win32'
  const dir = await mkdtemp(join(tmpdir(), 'ara-orca-hook-'))
  const file = join(dir, win ? 'run.cmd' : 'run.sh')
  try {
    await writeFile(file, win ? buildWindowsRunnerScript(script) : buildPosixRunnerScript(script), 'utf8')
    const [cmd, args] = win ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', file]] : ['bash', [file]]
    return await runProcess(cmd, args, {
      cwd: o.cwd,
      env: setupEnvVars(o.rootPath, o.cwd),
      timeoutMs: o.timeoutMs,
      maxBuffer: HOOK_OUTPUT_LIMIT_BYTES,
      onStdout: o.onOutput,
      onStderr: o.onOutput
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
