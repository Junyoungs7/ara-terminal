// M6 R2 — WS-06 파일 목록(rg --files) · WS-09 전체 검색(rg --json). Orca src/main/ripgrep/(orcaRef fdfcfb3551)의 1차 판 — 로컬 워크트리만.
// 스폰은 runProcess 하나로(tests/spawnBoundary.test.ts 래칫): 셸 없음 · 창 없음 · 시간·출력 상한. 끊기는 signal.
import { join } from 'node:path'
import { runProcess } from '../util/runProcess'
import {
  QUICK_OPEN_LISTING_MAX,
  SEARCH_MAX_RESULTS,
  SEARCH_TIMEOUT_MS,
  buildListArgs,
  buildSearchArgs,
  ingestRgJsonLine,
  newSearchAcc,
  normalizeRgPath,
  type SearchFile,
  type SearchOptions
} from '@shared/codeSearch'

/**
 * 앱에 실린 rg 경로 — Orca bundledRipgrepCommand 의 자리. appPath = app.getAppPath()
 * (개발 = 저장소 루트, 설치본 = resources/app.asar). 실행 파일은 asar 안에서 못 띄우므로 electron-builder.yml 의
 * asarUnpack 이 푼 **app.asar.unpacked** 쪽을 가리킨다. PATH 의 rg 로 물러서지 않는다(Orca 와 같다 — 설치본이 저장소 안의 rg.exe 를 잡지 않게).
 */
export function rgBinPath(appPath: string, platform: string, arch: string): string {
  const exe = platform === 'win32' ? 'rg.exe' : 'rg'
  return join(appPath, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', `${platform}-${arch}`, exe).replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
}

const LIST_TIMEOUT_MS = 10_000
/** 목록 출력 상한 — 2만 개 × 경로 길이. 넘으면 그때까지(상한에서 끊으니 보통 안 닿는다). */
const LIST_MAX_BUFFER = 16 * 1024 * 1024
/** 검색 출력 상한 — 결과 2000개에서 끊지만 긴 줄(5MB 파일의 한 줄)이 모이면 여기서 끊긴다 → truncated. ponytail: execFile 이 stdout 을 한 벌 더 모은다, 메모리가 문제면 runProcess 에 '모으지 않음' 갈래. */
const SEARCH_MAX_BUFFER = 64 * 1024 * 1024
const win = process.platform === 'win32'

export type ListResult = { ok: true; files: string[]; truncated: boolean } | { ok: false; message: string }

/** 워크트리 파일 목록(.gitignore 존중, 숨김 파일 포함, 도구 폴더 제외) — 2만 개에서 끊는다. */
export async function listFiles(rg: string, root: string): Promise<ListResult> {
  const ac = new AbortController()
  let buf = ''
  let count = 0
  const r = await runProcess(rg, buildListArgs(win), {
    cwd: root,
    timeoutMs: LIST_TIMEOUT_MS,
    maxBuffer: LIST_MAX_BUFFER,
    signal: ac.signal,
    onStdout: (chunk) => {
      buf += chunk
      for (let i = chunk.indexOf('\0'); i !== -1; i = chunk.indexOf('\0', i + 1)) count++
      if (count > QUICK_OPEN_LISTING_MAX) ac.abort()
    }
  })
  // rg 종료 1 = 파일 없음. 끊은 것(상한)은 실패가 아니다.
  if (r.error && !ac.signal.aborted && r.code !== 1 && !buf) return { ok: false, message: r.stderr.trim() || r.error.message }
  const files: string[] = []
  for (const raw of buf.split('\0')) {
    const p = normalizeRgPath(raw)
    if (p !== null) files.push(p)
    if (files.length >= QUICK_OPEN_LISTING_MAX) break
  }
  return { ok: true, files, truncated: ac.signal.aborted || count > QUICK_OPEN_LISTING_MAX }
}

export type SearchDone = { ok: true; total: number; truncated: boolean; cancelled: boolean } | { ok: false; message: string }

/** 결과를 렌더러로 묶어 보내는 간격 — 줄마다 보내면 큰 저장소에서 IPC·렌더가 막힌다. */
export const SEARCH_BATCH_MS = 100

/**
 * 전체 검색 — rg --json 을 줄 단위로 읽어 모으고, SEARCH_BATCH_MS 마다 **새로 맞은 것만** onBatch 로 넘긴다.
 * 결과 2000개·15초에서 멈추고(truncated), signal 로 끊으면 cancelled. 정규식 오류 등 rg 의 실패(종료 2)는 rg 의 말을 그대로.
 */
export async function searchText(rg: string, root: string, o: SearchOptions, signal: AbortSignal, onBatch: (files: SearchFile[]) => void): Promise<SearchDone> {
  const acc = newSearchAcc()
  const stop = new AbortController()
  const cancel = (): void => stop.abort()
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) stop.abort()
  let rest = ''
  // 지난 묶음 뒤에 더해진 것 — 파일별로 몇 번째 맞음부터 보냈는지.
  const sent = new Map<string, number>()
  const flush = (): void => {
    const out: SearchFile[] = []
    for (const f of acc.files.values()) {
      const from = sent.get(f.path) ?? 0
      if (f.matches.length > from) out.push({ path: f.path, matches: f.matches.slice(from) })
      sent.set(f.path, f.matches.length)
    }
    if (out.length) onBatch(out)
  }
  const timer = setInterval(flush, SEARCH_BATCH_MS)
  const take = (line: string): void => {
    if (!stop.signal.aborted && ingestRgJsonLine(line, acc, SEARCH_MAX_RESULTS) === 'stop') stop.abort()
  }
  try {
    const r = await runProcess(rg, buildSearchArgs(o, win), {
      cwd: root,
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxBuffer: SEARCH_MAX_BUFFER,
      signal: stop.signal,
      onStdout: (chunk) => {
        const lines = (rest + chunk).split('\n')
        rest = lines.pop() ?? ''
        for (const l of lines) take(l)
      }
    })
    if (!r.error) take(rest)
    flush()
    if (signal.aborted) return { ok: true, total: acc.total, truncated: true, cancelled: true }
    // 0 = 맞음 있음, 1 = 없음. 상한에서 끊은 것(acc.truncated 가 이미 켜짐)·시간 초과(killed)·출력 상한은 그때까지의 결과 + truncated.
    if (r.error && r.code !== 1 && !stop.signal.aborted) {
      const killed = (r.error as { killed?: boolean }).killed === true || /maxBuffer/i.test(r.error.message)
      // 종료 2 인데 결과가 있으면 일부 파일을 못 읽은 것(권한 등) — 찾은 것은 보여 준다.
      if (!killed && acc.total === 0) return { ok: false, message: r.stderr.trim() || r.error.message }
      if (killed) acc.truncated = true
    }
    return { ok: true, total: acc.total, truncated: acc.truncated, cancelled: false }
  } finally {
    clearInterval(timer)
    signal.removeEventListener('abort', cancel)
  }
}
