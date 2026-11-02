// M14 R2 `ara` CLI 등록 — Orca src/main/cli/cli-path-registration.ts·windows-user-path-registry.ts·cli-privileged-processes.ts
// (orcaRef ec112c6b01)의 Windows 몫. **설정에서 [CLI 설치]·[제거]를 눌렀을 때만** 부른다(앱이 켜질 때 스스로 쓰지 않는다).
//
//  · 하는 일: 사용자 PATH(HKCU\Environment\Path)에 설치 폴더의 `resources\bin` 한 줄을 붙이거나 뗀다. 그 폴더에는 ara.cmd 하나뿐이다
//    (dll·exe 가 든 설치 폴더 자체를 넣지 않는다 — installer.nsh 의 App Paths 주석이 경고한 이름 충돌을 피한다).
//  · 다른 항목은 순서·글자 그대로 둔다. 값 종류(REG_EXPAND_SZ/REG_SZ)도 그대로 — %USERPROFILE% 같은 항목이 풀려 굳지 않게
//    (Orca 의 NSIS 정리 매크로와 같은 규칙. Orca 앱 쪽은 SetEnvironmentVariable 로 써서 REG_SZ 가 되는데, 그건 따르지 않았다).
//  · 못 읽으면 쓰지 않는다(Orca: PATH 는 읽고-고치고-쓰기라, 반쯤 읽은 값으로 쓰면 사용자 PATH 를 잃는다).
//  · 되돌리기 = [제거](우리 줄만 뺀다). 앱을 지우면 installer.nsh 의 customUnInstall 도 같은 줄을 뺀다.
// App Paths(`ara.exe` → 아라, 탐색기 주소창용)와의 관계: ara.cmd 는 인자가 없으면 아라를 그 폴더에서 띄운다 — 탐색기에서 PATH 의
// ara.cmd 가 먼저 잡혀도 `ara` 는 지금처럼 "여기서 아라"다. 인자가 있으면 CLI.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { runProcess } from '../util/runProcess'
import { splitPathEntries, samePathEntry, withPathEntry, withoutPathEntry, type CliInstallStatus } from '@shared/araCli'

export type UserPathRead = { ok: true; value: string | null; kind: 'String' | 'ExpandString' | 'None' } | { ok: false; detail: string }
export type CliInstallDeps = {
  platform: NodeJS.Platform
  isPackaged: boolean
  resourcesPath: string
  /** 아라 프로세스의 PATH(가려짐 확인용 — 시스템 PATH 가 사용자 PATH 앞이다). */
  processPath: string
  env: Record<string, string | undefined>
  readUserPath(): Promise<UserPathRead>
  writeUserPath(value: string | null, kind: 'String' | 'ExpandString'): Promise<void>
  exists(p: string): boolean
}

const CMD_NAMES = ['ara.exe', 'ara.com', 'ara.bat', 'ara.cmd']

export function cliBinDir(d: Pick<CliInstallDeps, 'platform' | 'isPackaged' | 'resourcesPath' | 'exists'>): string | null {
  if (d.platform !== 'win32' || !d.isPackaged) return null
  const dir = join(d.resourcesPath, 'bin')
  return d.exists(join(dir, 'ara.cmd')) ? dir : null
}

export async function cliInstallStatus(d: CliInstallDeps): Promise<CliInstallStatus> {
  const binDir = cliBinDir(d)
  if (!binDir) {
    return { state: 'unsupported', binDir: null, shadowedBy: null, detail: d.platform !== 'win32' ? 'Windows 에서만 등록합니다.' : '설치본에서만 등록합니다(개발 실행에는 bin 이 없습니다).' }
  }
  const r = await d.readUserPath()
  if (!r.ok) return { state: 'unknown', binDir, shadowedBy: null, detail: r.detail }
  const installed = splitPathEntries(r.value).some((e) => samePathEntry(e, binDir, d.env))
  // 우리 폴더보다 앞에 같은 이름이 있으면 그것이 먼저 잡힌다(시스템 PATH 가 사용자 PATH 앞).
  let shadowedBy: string | null = null
  for (const dir of d.processPath.split(delimiter).filter(Boolean)) {
    if (samePathEntry(dir, binDir, d.env)) break
    const hit = CMD_NAMES.map((n) => join(dir, n)).find((p) => d.exists(p))
    if (hit) {
      shadowedBy = hit
      break
    }
  }
  return { state: installed ? 'installed' : 'not_installed', binDir, shadowedBy, detail: installed ? '새로 연 터미널부터 ara 가 보입니다.' : null }
}

async function mutate(d: CliInstallDeps, op: 'add' | 'remove'): Promise<CliInstallStatus> {
  const binDir = cliBinDir(d)
  if (!binDir) return cliInstallStatus(d)
  const r = await d.readUserPath()
  if (!r.ok) throw new Error(`${r.detail} PATH 는 바꾸지 않았습니다.`)
  const next = op === 'add' ? withPathEntry(r.value, binDir, d.env) : withoutPathEntry(r.value, binDir, d.env)
  if (next !== null) await d.writeUserPath(next || null, r.kind === 'String' ? 'String' : 'ExpandString')
  return cliInstallStatus(d)
}
export const installCli = (d: CliInstallDeps): Promise<CliInstallStatus> => mutate(d, 'add')
export const uninstallCli = (d: CliInstallDeps): Promise<CliInstallStatus> => mutate(d, 'remove')

// ── 진짜 레지스트리(PowerShell) — 시험은 이 둘을 가짜로 바꾼다 ─────────────────────────

const PS = 'powershell.exe'
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command']
const PS_TIMEOUT_MS = 15_000

/** 펼치지 않은 원래 값(DoNotExpandEnvironmentNames)과 종류를 읽는다. 출력은 UTF-8 JSON 한 줄. */
export async function readUserPathRegistry(): Promise<UserPathRead> {
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
    "$v = $k.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')",
    "$kind = if ($null -eq $v) { 'None' } else { $k.GetValueKind('Path').ToString() }",
    '[Console]::Out.Write((ConvertTo-Json @{ value = $v; kind = $kind } -Compress))'
  ].join('; ')
  const r = await runProcess(PS, [...PS_ARGS, script], { timeoutMs: PS_TIMEOUT_MS })
  if (r.code !== 0) return { ok: false, detail: `사용자 PATH 를 못 읽었습니다: ${(r.stderr || r.error?.message || '').trim()}` }
  try {
    const o = JSON.parse(r.stdout.trim()) as { value: unknown; kind: unknown }
    if (o.kind !== 'String' && o.kind !== 'ExpandString' && o.kind !== 'None') return { ok: false, detail: `사용자 PATH 값 종류가 낯섭니다(${String(o.kind)}).` }
    return { ok: true, value: typeof o.value === 'string' ? o.value : null, kind: o.kind }
  } catch {
    return { ok: false, detail: '사용자 PATH 읽기 결과를 못 알아봤습니다.' }
  }
}

/**
 * 값은 명령 글에 끼우지 않고 env 로 넘긴다(runProcess 규칙). 쓴 뒤 WM_SETTINGCHANGE 를 알려야 새 터미널·탐색기가 바뀐 PATH 를 본다 —
 * .NET 의 SetEnvironmentVariable(User)가 레지스트리를 고친 뒤 그 알림을 보낸다. 우리 값은 종류를 지키려 직접 썼으므로,
 * 없는 이름을 지우는 호출(바뀌는 것 없음)로 알림만 빌린다.
 */
export async function writeUserPathRegistry(value: string | null, kind: 'String' | 'ExpandString'): Promise<void> {
  const script = [
    "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "if ($env:ARA_CLI_PATH_VALUE) { $k.SetValue('Path', $env:ARA_CLI_PATH_VALUE, [Microsoft.Win32.RegistryValueKind]$env:ARA_CLI_PATH_KIND) } else { $k.DeleteValue('Path', $false) }",
    '$k.Close()',
    "[Environment]::SetEnvironmentVariable('ARA_CLI_PATH_NOTIFY', $null, 'User')"
  ].join('; ')
  const r = await runProcess(PS, [...PS_ARGS, script], { timeoutMs: PS_TIMEOUT_MS, env: { ARA_CLI_PATH_VALUE: value ?? '', ARA_CLI_PATH_KIND: kind } })
  if (r.code !== 0) {
    const msg = (r.stderr || r.error?.message || '').trim()
    // Orca: 그룹 정책으로 막힌 PC — 날 오류 대신 할 일을 말한다.
    if (/denied|UnauthorizedAccess|거부/i.test(msg)) throw new Error('Windows 가 사용자 PATH 쓰기를 막았습니다(조직 정책일 수 있습니다). 직접 PATH 에 넣거나 빼 주세요.')
    throw new Error(`사용자 PATH 를 못 썼습니다: ${msg}`)
  }
}

export function realInstallDeps(o: { isPackaged: boolean; resourcesPath: string }): CliInstallDeps {
  return {
    platform: process.platform,
    isPackaged: o.isPackaged,
    resourcesPath: o.resourcesPath,
    processPath: process.env['PATH'] ?? process.env['Path'] ?? '',
    env: process.env,
    readUserPath: readUserPathRegistry,
    writeUserPath: writeUserPathRegistry,
    exists: existsSync
  }
}
