// P3 R2-A TM-09 셸 선택·인자 — 로컬 셸 프로필을 실제 실행 파일·인자로 푼다(데몬 프로세스에서도 돈다 — node 만 쓴다).
// Git Bash 찾기는 Orca src/main/git-bash.ts(getGitBashCandidatePaths·isGitForWindowsBashPath) 그대로, pwsh 찾기는 Orca pwsh.ts 와 같은 순서
// (PATH → Program Files\PowerShell\7). 감지는 파일 있나만 본다 — 아무것도 띄우지 않는다(wsl -l 같은 배포판 목록은 뺐다).
import { existsSync, readFileSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'
import { BUILTIN_SHELLS, type BuiltinShell, type ShellChoice } from '@shared/termExtra'

type Env = Record<string, string | undefined>
type Exists = (p: string) => boolean

function readEnv(env: Env, names: string[]): string | undefined {
  for (const n of names) if (env[n]) return env[n]
  return undefined
}

export function isGitForWindowsBashPath(shellPath: string): boolean {
  return /(?:^|\\)(?:git|portablegit)(?:\\usr)?\\bin\\bash\.exe$/.test(pathWin32.normalize(shellPath).toLowerCase())
}

/** Orca getGitBashCandidatePaths — Program Files·LocalAppData\Programs·PATH 의 git\cmd 옆. */
export function gitBashCandidates(env: Env = process.env): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (p: string | undefined): void => {
    if (!p) return
    const n = pathWin32.normalize(p)
    if (!seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase())
      out.push(n)
    }
  }
  for (const root of [
    readEnv(env, ['ProgramFiles', 'PROGRAMFILES']),
    readEnv(env, ['ProgramW6432', 'PROGRAMW6432']),
    readEnv(env, ['ProgramFiles(x86)', 'PROGRAMFILES(X86)']),
    readEnv(env, ['LOCALAPPDATA', 'LocalAppData'])
  ]) {
    if (!root) continue
    push(pathWin32.join(root, 'Git', 'bin', 'bash.exe'))
    push(pathWin32.join(root, 'Git', 'usr', 'bin', 'bash.exe'))
    push(pathWin32.join(root, 'Programs', 'Git', 'bin', 'bash.exe'))
    push(pathWin32.join(root, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'))
  }
  for (const raw of (readEnv(env, ['Path', 'PATH']) ?? '').split(';')) {
    const seg = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!seg) continue
    const direct = pathWin32.join(seg, 'bash.exe')
    if (isGitForWindowsBashPath(direct)) push(direct)
    const base = pathWin32.basename(seg).toLowerCase()
    const parent = pathWin32.dirname(seg)
    const parentBase = pathWin32.basename(parent).toLowerCase()
    if (base === 'cmd' && (parentBase === 'git' || parentBase === 'portablegit')) {
      push(pathWin32.join(parent, 'bin', 'bash.exe'))
      push(pathWin32.join(parent, 'usr', 'bin', 'bash.exe'))
    } else if (base === 'git' || base === 'portablegit') {
      push(pathWin32.join(seg, 'bin', 'bash.exe'))
      push(pathWin32.join(seg, 'usr', 'bin', 'bash.exe'))
    }
  }
  return out
}

function onPath(exe: string, env: Env, exists: Exists): string | null {
  for (const raw of (readEnv(env, ['Path', 'PATH']) ?? '').split(';')) {
    const seg = raw.trim().replace(/^"(.*)"$/, '$1')
    if (seg && exists(pathWin32.join(seg, exe))) return pathWin32.join(seg, exe)
  }
  return null
}

/** 내장 셸 하나의 실행 파일. 없으면 null(설정에서 [없음]으로 보인다, 스폰은 생성자의 cmd 폴백이 받는다). */
export function builtinShellPath(id: BuiltinShell, env: Env = process.env, exists: Exists = existsSync): string | null {
  const sys = readEnv(env, ['SystemRoot', 'SYSTEMROOT', 'windir']) ?? 'C:\\Windows'
  switch (id) {
    case 'powershell.exe':
      return 'powershell.exe'
    case 'cmd.exe':
      return 'cmd.exe'
    case 'pwsh.exe': {
      const pf = readEnv(env, ['ProgramFiles', 'PROGRAMFILES'])
      return onPath('pwsh.exe', env, exists) ?? (pf && exists(pathWin32.join(pf, 'PowerShell', '7', 'pwsh.exe')) ? pathWin32.join(pf, 'PowerShell', '7', 'pwsh.exe') : null)
    }
    case 'git-bash':
      return gitBashCandidates(env).find((c) => isGitForWindowsBashPath(c) && exists(c)) ?? null
    case 'wsl.exe': {
      const p = pathWin32.join(sys, 'System32', 'wsl.exe')
      return exists(p) ? p : null
    }
  }
}

/** 프로필별 기본 인자. Git Bash 는 Orca 처럼 로그인 대화형(--login -i). */
export function defaultShellArgs(id: string): string[] {
  if (id === 'powershell.exe' || id === 'pwsh.exe') return ['-NoLogo']
  if (id === 'git-bash') return ['--login', '-i']
  return []
}

/** 설정 화면 목록. Windows = 내장 다섯(있나 표시), mac/linux = /etc/shells 의 셸들(자동 + 그 경로들). */
export function detectShells(platform: NodeJS.Platform = process.platform, env: Env = process.env, exists: Exists = existsSync, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): ShellChoice[] {
  if (platform === 'win32') {
    const label: Record<BuiltinShell, string> = { 'powershell.exe': 'Windows PowerShell', 'pwsh.exe': 'PowerShell 7 (pwsh)', 'cmd.exe': 'Command Prompt (cmd)', 'git-bash': 'Git Bash', 'wsl.exe': 'WSL' }
    return BUILTIN_SHELLS.map((id) => ({ id, label: label[id], path: builtinShellPath(id, env, exists) }))
  }
  let lines: string[] = []
  try {
    lines = read('/etc/shells').split('\n')
  } catch {
    /* 없으면 자동만 */
  }
  const seen = new Set<string>()
  return lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/') && !seen.has(l) && (seen.add(l), true))
    .map((p) => ({ id: p, label: p, path: exists(p) ? p : null }))
}

/**
 * 세션 spec 의 셸 id + 인자 → 실행 파일·인자. null = 자동(호출측의 기존 규칙). 내장 셸이 없으면 null 이 아니라 그 이름 그대로 —
 * 스폰이 실패해 cmd 로 떨어지는 지금 길을 그대로 탄다.
 */
export function resolveShellProfile(id: string | undefined, args: string[] | undefined, env: Env = process.env, exists: Exists = existsSync): { file: string; args: string[] } | null {
  if (!id) return null
  const builtin = (BUILTIN_SHELLS as readonly string[]).includes(id) ? (id as BuiltinShell) : null
  const file = builtin ? (builtinShellPath(builtin, env, exists) ?? (builtin === 'git-bash' ? 'bash.exe' : id)) : id
  return { file, args: args ?? defaultShellArgs(id) }
}
