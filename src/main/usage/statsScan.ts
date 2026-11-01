// M13 통계 — transcript 를 읽어 토큰을 합친다. utility process(statsWorker.ts)에서 돈다(main 을 막지 않는다). 시험은 이 함수를 바로 부른다.
// 읽기만 한다. 고친 지 since 보다 오래된 파일은 열지 않는다(30일 밖 기록은 건너뛴다). 파일 수 상한이 있다.
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { aggregateTurns, parseClaudeLine, parseCodexLine, type CodexCtx, type StatsReport, type Turn } from '@shared/usageStats'

/** 한 번에 읽는 파일 상한 — 넘으면 최근에 고친 것부터. ponytail: 증분 캐시 없음, 느려지면 Orca persisted-source-cache 처럼 파일별 결과를 남긴다. */
const MAX_FILES = 4000
const MAX_DEPTH = 5

async function listJsonl(root: string, since: number, out: { path: string; mtime: number }[], depth = 0): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) await listJsonl(p, since, out, depth + 1)
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        const s = await stat(p)
        if (s.mtimeMs >= since) out.push({ path: p, mtime: s.mtimeMs })
      } catch {
        /* 사라진 파일 */
      }
    }
  }
}

async function eachLine(path: string, f: (line: string) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) f(line)
  } catch {
    /* 읽다 끊긴 파일은 읽은 데까지 */
  }
}

/** dirs.claude = Claude 설정 폴더들(그 아래 projects/), dirs.codex = Codex 홈들(그 아래 sessions/). */
export async function scanUsage(dirs: { claude: string[]; codex: string[] }, since: number, now = Date.now()): Promise<StatsReport> {
  const claudeFiles: { path: string; mtime: number }[] = []
  const codexFiles: { path: string; mtime: number }[] = []
  for (const d of new Set(dirs.claude)) await listJsonl(join(d, 'projects'), since, claudeFiles)
  for (const d of new Set(dirs.codex)) await listJsonl(join(d, 'sessions'), since, codexFiles)
  const newest = (a: { mtime: number }, b: { mtime: number }): number => b.mtime - a.mtime
  const cf = claudeFiles.sort(newest).slice(0, MAX_FILES)
  const xf = codexFiles.sort(newest).slice(0, Math.max(0, MAX_FILES - cf.length))

  // Claude: 같은 응답이 여러 줄(스트리밍)·여러 파일(이어하기·포크)에 실린다 — 키가 같으면 마지막 것 하나만.
  const claude = new Map<string, Turn>()
  const loose: Turn[] = []
  for (const f of cf) {
    await eachLine(f.path, (line) => {
      const r = parseClaudeLine(line)
      if (!r) return
      if (r.key) claude.set(r.key, r.turn)
      else loose.push(r.turn)
    })
  }
  const codex: Turn[] = []
  for (const f of xf) {
    const ctx: CodexCtx = { model: null, prev: null }
    await eachLine(f.path, (line) => {
      const t = parseCodexLine(line, ctx)
      if (t) codex.push(t)
    })
  }
  return { since, at: now, files: cf.length + xf.length, claude: aggregateTurns([...claude.values(), ...loose], since), codex: aggregateTurns(codex, since) }
}
