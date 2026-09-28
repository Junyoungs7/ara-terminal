// #205 RDP 파일을 **윈도우 클립보드**로 주고받는 다리 — 탐색기 Ctrl+C/Ctrl+V 와 이어지는 자리.
//
// Electron `clipboard` 는 파일 형식(CF_HDROP)을 못 다룬다(util/clipboardFiles.ts — 읽기는 첫 파일
// 하나뿐, 쓰기는 길이 없다). 2026-09-21 확인한 다리는 PowerShell 두 줄이다(네이티브 모듈 불필요):
//   · 쓰기 `Set-Clipboard -LiteralPath <경로들>`  · 읽기 `Get-Clipboard -Format FileDropList`
//
// 🔴 **경로를 명령 문자열에 끼워 넣지 않는다.** 원격→로컬의 파일명은 원격이 정한 값이다(신뢰 경계 밖).
// 따옴표·`$`·백틱이 든 이름이 명령에 섞이면 그 이름이 곧 코드가 된다. 그래서 스크립트는 **고정 상수**로
// 두고(-EncodedCommand — 인용 규칙 자체를 안 탄다), 경로는 **환경 변수에 JSON 으로** 넘긴다.
// 환경 변수는 Windows 에서 UTF-16 이라 한글도 코드페이지를 안 탄다(stdin 은 5.1 에서 OEM 코드페이지로
// 읽혀 한글이 깨진다 — 그래서 stdin 을 안 썼다). 출력도 같은 이유로 base64(UTF-8 JSON)로 받는다.
//
// 🔴 **실패를 다시 시도하지 않는다.** 사내 PC 의 DLP(오피스키퍼)가 클립보드 파일·임시 파일에 반응할 수
// 있다 — 막힌 것을 되풀이하면 경보만 늘어난다. 사유를 그대로 돌려 화면에 보인다.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'
import { handle } from '../ipc/handle'
import { safeBase, uniqueName } from '../fs/saveBytes'

/**
 * 로컬→원격 합계 상한. `uploadFiles` 는 브라우저 `File` 을 요구하는데 경로에서 **디스크 기반 File 을
 * 만들 수 없다** — 바이트를 통째로 메모리에 올려 IPC 로 건너야 한다. 큰 파일은 창에 끌어다 놓으면 된다
 * (드롭은 진짜 File 을 줘서 스트리밍된다 — RdpView 의 onDrop).
 */
export const LOCAL_TO_REMOTE_MAX = 100 * 1024 * 1024

const ENV_KEY = 'ARA_CLIP_PATHS'
const PS_TIMEOUT_MS = 15_000

// 둘 다 **상수**다 — 어떤 값도 이 문자열에 끼워 넣지 않는다(위 머리 주석). ForEach 로 한 번 푸는 이유:
// 5.1 의 ConvertFrom-Json 은 배열을 한 덩어리로 내보내 @() 로 감싸면 {value,Count} 로 직렬화된다(실측).
const SET_SCRIPT =
  "$ProgressPreference='SilentlyContinue'; $p = @(ConvertFrom-Json $env:ARA_CLIP_PATHS | ForEach-Object { $_ }); Set-Clipboard -LiteralPath $p"
const GET_SCRIPT =
  "$ProgressPreference='SilentlyContinue'; $f = @(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject $f)))"

/** powershell.exe 인자 배열(순수 — 시험 대상). 스크립트만 싣는다. */
export function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/** 클립보드에 올릴 호출 한 벌(순수 — 시험 대상). 경로는 env 에만 있고 인자에는 없다. */
export function setClipboardCall(paths: readonly string[]): { args: string[]; env: Record<string, string> } {
  return { args: psArgs(SET_SCRIPT), env: { [ENV_KEY]: JSON.stringify(paths) } }
}

export function getClipboardCall(): { args: string[] } {
  return { args: psArgs(GET_SCRIPT) }
}

/** GET_SCRIPT 의 출력 → 경로 목록. 모양이 틀리면 빈 목록(클립보드 내용은 오류로 알릴 대상이 아니다). */
export function parseFileDropOutput(stdout: string): string[] {
  try {
    const v: unknown = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'))
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p !== '') : []
  } catch {
    return []
  }
}

/** 로컬→원격 합계가 상한을 넘나. */
export function overLimit(sizes: readonly number[], max = LOCAL_TO_REMOTE_MAX): boolean {
  return sizes.reduce((a, b) => a + b, 0) > max
}

function runPs(args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      args,
      { env: { ...process.env, ...env }, timeout: PS_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        // stderr 가 사유다(DLP 가 막으면 여기에 적힌다) — 그대로 올린다.
        if (err) reject(new Error(String(stderr).trim() || err.message))
        else resolve(String(stdout))
      }
    )
  })
}

const clipRoot = (): string => join(app.getPath('userData'), 'rdp-clip')

/**
 * 받은 파일을 `root/<난수>/` 에 쓰고 그 경로들을 돌려준다.
 *
 * 🔴 수명: **다음 복사 때와 앱 종료 때** 지운다. 클립보드가 가리키는 동안은 지우면 안 되는데, 클립보드가
 * 가리키는 것은 늘 **마지막 한 벌**이다 — 그래서 새 벌을 쓰기 전에 root 를 통째로 비운다(앞 벌 + 지난번
 * 비정상 종료가 남긴 것까지). 사용자가 그사이 다른 것을 복사했다면 앞 벌은 이미 아무도 안 가리킨다.
 */
export async function stageFiles(
  root: string,
  files: readonly { name: unknown; bytes: unknown }[]
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  await rm(root, { recursive: true, force: true })
  const dir = join(root, randomBytes(8).toString('hex'))
  await mkdir(dir, { recursive: true })
  const taken = new Set<string>()
  const paths: string[] = []
  for (const f of files) {
    // 이름은 원격이 준 값이다 — saveBytes 와 같은 검사를 지난다(`..\`·드라이브 접두로 폴더 밖에 못 쓴다).
    const base = safeBase(f.name)
    if (!base) return { ok: false, message: '원격이 보낸 파일 이름을 쓸 수 없습니다.' }
    if (!(f.bytes instanceof Uint8Array)) return { ok: false, message: '내려받은 내용이 비어 있습니다.' }
    // 한 번에 평평하게 놓는다 — 같은 이름이 둘이면 `이름 (2)` 로 비켜 간다.
    const name = uniqueName(base, (n) => taken.has(n.toLowerCase()))
    taken.add(name.toLowerCase())
    const p = join(dir, name)
    await writeFile(p, f.bytes)
    paths.push(p)
  }
  return { ok: true, paths }
}

/** 앱 종료 때 — quitStep 은 동기라 여기도 동기다. */
export function cleanupRdpClip(): void {
  rmSync(clipRoot(), { recursive: true, force: true })
}

export function registerRdpClipIpc(): void {
  // 원격 → 로컬: 받은 바이트를 임시 폴더에 쓰고 윈도우 클립보드에 파일로 올린다(탐색기 Ctrl+V).
  handle('rdpClip:put', async ({ files }) => {
    if (process.platform !== 'win32') return { ok: false, message: '파일 클립보드는 Windows 에서만 됩니다.' }
    if (!Array.isArray(files) || files.length === 0) return { ok: false, message: '받은 파일이 없습니다.' }
    try {
      const staged = await stageFiles(clipRoot(), files)
      if (!staged.ok) return staged
      const call = setClipboardCall(staged.paths)
      await runPs(call.args, call.env)
      return { ok: true, paths: staged.paths }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })

  // 로컬 → 원격: 탐색기에서 복사한 파일을 **바이트째** 읽어 준다(렌더러가 File 로 만들어 uploadFiles).
  // 🔴 렌더러가 물을 때만 돈다 — 폴링하지 않는다(포커스마다 프로세스를 띄우면 무겁다).
  handle('rdpClip:readLocal', async () => {
    if (process.platform !== 'win32') return { ok: true, files: [] }
    try {
      const paths = parseFileDropOutput(await runPs(getClipboardCall().args))
      // 폴더는 뺀다 — 구조를 재조립해 알려야 하는데(FileGroupDescriptor 의 상대 경로) 그 길은 드롭이
      // 이미 한다(provider.handleDrop 이 폴더를 훑는다). 여기서 또 만들 이유가 없다.
      const entries: { path: string; size: number; mtime: number }[] = []
      for (const p of paths) {
        const s = await stat(p).catch(() => null)
        if (s?.isFile()) entries.push({ path: p, size: s.size, mtime: s.mtimeMs })
      }
      // 상한은 **읽기 전에** 본다 — 넘는 것을 메모리에 올린 뒤 거절하면 상한의 의미가 없다.
      if (overLimit(entries.map((e) => e.size))) return { ok: false, tooBig: true, message: '' }
      const out: { path: string; name: string; bytes: Uint8Array; lastModified: number }[] = []
      for (const e of entries) {
        out.push({ path: e.path, name: basename(e.path), bytes: await readFile(e.path), lastModified: e.mtime })
      }
      return { ok: true, files: out }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })
}
