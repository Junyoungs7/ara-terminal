// M4 AI-07 지난 에이전트 세션 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 로컬 CLI 세션 기록을 **읽기만** 한다.
// Orca src/main/ai-vault(orcaRef fdfcfb3551)의 핵심만: 뿌리 = claude ~/.claude/projects · codex ~/.codex/sessions · gemini ~/.gemini/tmp,
// 하위 에이전트 폴더(subagents)는 건너뜀, 최신 파일 몇 개만 파싱, 파싱 결과는 (mtime·크기)로 캐시.
// 성능 원칙: 목록은 화면을 **열 때** 읽고(감시·백그라운드 스캔 없음), 큰 파일은 머리·꼬리만 읽는다.
// ponytail: main 에서 비동기 fs 로 읽는다(계획 5-3 은 utility process) — 파일 300개 × 128KB 상한이라 충분. 느리면 utilityHost 로.
import { CHAT_NAME_OPENING } from '@shared/agentOptions'
import { createHash } from 'node:crypto'
import { open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { shell as electronShell } from 'electron'
import { handle } from '../ipc/handle'
import { startUtilityHost, type UtilityHost } from '../stability/utilityHost'
import type { SearchFile } from './search'
import { readJsonWithBackup } from '../util/atomicJson'
import { defaultLaunchShell } from '../sessions/PtyBackend'
import { agentSettingsOf, isAgentId, planAgentLaunch, type AgentId } from '@shared/agents'
import {
  DETAIL_TURNS,
  headTailLines,
  parseGeminiDocument,
  parseSessionLines,
  resumeCommandText,
  SEARCH_MIN_CHARS,
  sortSessions,
  type ParsedSession,
  type VaultSearchResult,
  type VaultSession
} from '@shared/vault'

const HEAD = 64 * 1024
const TAIL_LIST = 64 * 1024
const TAIL_DETAIL = 256 * 1024
/** gemini 옛 json 문서는 머리·꼬리로 못 읽는다 — 이보다 크면 건너뛴다. */
const DOC_MAX = 4 * 1024 * 1024
/** 최신 파일 몇 개만 파싱한다(Orca session-newest-files). */
const MAX_FILES = 300

type FileHit = SearchFile

async function walk(dir: string, depth: number, out: string[], ext: RegExp): Promise<void> {
  let ents
  try {
    ents = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 없는 뿌리 = 그 CLI 를 안 씀
  }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (depth > 0 && e.name !== 'subagents') await walk(p, depth - 1, out, ext)
    } else if (e.isFile() && ext.test(e.name)) out.push(p)
  }
}

async function readHeadTail(path: string, size: number, tailBytes: number): Promise<string[]> {
  const fh = await open(path, 'r')
  try {
    const headLen = Math.min(size, HEAD)
    const head = Buffer.alloc(headLen)
    await fh.read(head, 0, headLen, 0)
    if (size <= HEAD) return headTailLines(head.toString('utf8'), null)
    const tailLen = Math.min(tailBytes, size - HEAD)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    return headTailLines(head.toString('utf8'), tail.toString('utf8'))
  } finally {
    await fh.close()
  }
}

async function parseFile(f: FileHit, tailBytes: number, keep: number): Promise<ParsedSession | null> {
  if (f.agent === 'gemini' && f.path.endsWith('.json')) {
    if (f.size > DOC_MAX) return null
    return parseGeminiDocument(await readFile(f.path, 'utf8'), keep)
  }
  return parseSessionLines(f.agent, await readHeadTail(f.path, f.size, tailBytes), keep)
}

export function registerVaultFeature(deps: {
  /** 세션 기록을 찾을 홈. e2e 는 임시 홈(main/index.ts hookHome) — 시험이 사용자 실제 기록을 읽지 않는다. */
  home: string
  userData: string
  /** M11 전문 검색 utility process 모듈(기본 out/main/vaultSearchWorker.js). */
  searchWorker?: string
  /** M11 삭제 = 휴지통으로(Orca moveToTrash). 시험이 바꾼다. */
  trash?: (path: string) => Promise<void>
}): void {
  const roots: { agent: AgentId; dir: string; depth: number; ext: RegExp }[] = [
    { agent: 'claude', dir: join(deps.home, '.claude', 'projects'), depth: 1, ext: /\.jsonl$/i },
    // ponytail: CODEX_HOME 은 안 따른다(기본 홈만) — 쓰는 사람이 생기면 Orca codexHomeSessionsDir 처럼.
    { agent: 'codex', dir: join(deps.home, '.codex', 'sessions'), depth: 3, ext: /\.jsonl$/i },
    { agent: 'gemini', dir: join(deps.home, '.gemini', 'tmp'), depth: 2, ext: /\.jsonl?$/i }
  ]
  const cache = new Map<string, { key: string; s: VaultSession | null }>()
  /** 마지막 목록이 본 파일 — 상세는 이 안의 파일만 연다(렌더러가 준 경로를 그대로 믿지 않는다). */
  const known = new Map<string, FileHit>()

  /** gemini tmp/<해시> → 폴더. 새 판은 `.project_root` 파일을, 옛 판은 sha256(폴더)를 쓴다 — 아는 폴더와 맞춰 본다. */
  const geminiCwd = async (file: string, byHash: Map<string, string>): Promise<string | null> => {
    const projectDir = basename(dirname(file)) === 'chats' ? dirname(dirname(file)) : dirname(file)
    const hit = byHash.get(basename(projectDir))
    if (hit) return hit
    try {
      return (await readFile(join(projectDir, '.project_root'), 'utf8')).trim() || null
    } catch {
      return null
    }
  }

  /** 세 뿌리의 세션 파일 전부(최신 먼저). 목록은 앞 MAX_FILES 개, 전문 검색은 전부(SEARCH_MAX_FILES 까지). */
  const allFiles = async (): Promise<FileHit[]> => {
    const hits: FileHit[] = []
    for (const r of roots) {
      const paths: string[] = []
      await walk(r.dir, r.depth, paths, r.ext)
      // gemini 는 tmp/<프로젝트>/chats 아래만 세션이다(옆의 logs.json·체크포인트는 아니다).
      for (const p of r.agent === 'gemini' ? paths.filter((x) => basename(dirname(x)) === 'chats') : paths) {
        try {
          const st = await stat(p)
          hits.push({ agent: r.agent, path: p, mtimeMs: st.mtimeMs, size: st.size, createdAt: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs })
        } catch {
          // 읽는 사이 지워졌다
        }
      }
    }
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return hits
  }
  const hashMap = (cwds: unknown): Map<string, string> => {
    const byHash = new Map<string, string>()
    for (const c of Array.isArray(cwds) ? cwds.filter((x): x is string => typeof x === 'string') : []) {
      for (const v of new Set([c, c.replace(/\//g, '\\'), c.replace(/\\/g, '/')])) byHash.set(createHash('sha256').update(v).digest('hex'), c)
    }
    return byHash
  }

  handle('vault:list', async ({ cwds }) => {
    const newest = (await allFiles()).slice(0, MAX_FILES)
    known.clear()
    for (const f of newest) known.set(f.path, f)
    const byHash = hashMap(cwds)
    const out: VaultSession[] = []
    for (const f of newest) {
      const key = `${f.mtimeMs}:${f.size}`
      let s = cache.get(f.path)?.key === key ? cache.get(f.path)!.s : undefined
      if (s === undefined) {
        try {
          const p = await parseFile(f, TAIL_LIST, 0)
          // M5 AI-19 채팅 이름 짓기의 한 번짜리 실행(claude -p)은 지난 세션이 아니다 — Orca 도 같은 첫 줄로 숨긴다.
          s = p?.id && !p.firstPrompt?.startsWith(CHAT_NAME_OPENING)
            ? { agent: f.agent, id: p.id, cwd: p.cwd, file: f.path, at: f.mtimeMs, createdAt: f.createdAt, title: p.title, firstPrompt: p.firstPrompt }
            : null
        } catch {
          s = null
        }
        cache.set(f.path, { key, s })
      }
      if (!s) continue
      // gemini 폴더는 아는 폴더 목록에 따라 달라진다 — 캐시하지 않고 매번 맞춘다.
      out.push(f.agent === 'gemini' && !s.cwd ? { ...s, cwd: await geminiCwd(f.path, byHash) } : s)
    }
    return sortSessions(out)
  })

  handle('vault:detail', async ({ file }) => {
    const f = known.get(file)
    if (!f) return { ok: false, error: '목록에 없는 파일입니다. 새로 고침 하세요.' }
    const s = cache.get(file)?.s
    if (!s) return { ok: false, error: '읽을 수 없는 세션 기록입니다.' }
    try {
      const p = await parseFile(f, TAIL_DETAIL, DETAIL_TURNS)
      return { ok: true, session: s, turns: p?.turns ?? [] }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 복사용 재개 명령 — 실행과 같은 계획(planAgentLaunch resume)에 폴더 이동을 붙인다. 설정은 agents.json(에이전트 기능이 저장한 것).
  handle('vault:resumeCommand', ({ agent, id, cwd }) => {
    if (!isAgentId(agent) || typeof id !== 'string') return { ok: false, error: '모르는 세션' }
    const settings = agentSettingsOf(readJsonWithBackup<unknown>(join(deps.userData, 'agents.json'), null))
    const shell = defaultLaunchShell()
    const plan = planAgentLaunch({ agent, settings, shell, resume: id })
    if (!plan.ok) return plan
    return { ok: true, text: resumeCommandText(plan.line, typeof cwd === 'string' ? cwd : null, shell) }
  })

  // ── M11 전문 검색(utility process — 처음 검색할 때 띄운다) ──
  let worker: UtilityHost | null = null
  let reqSeq = 0
  const waiting = new Map<number, (m: Record<string, unknown>) => void>()
  const ensureWorker = (): UtilityHost =>
    (worker ??= startUtilityHost({
      modulePath: deps.searchWorker ?? join(__dirname, 'vaultSearchWorker.js'),
      serviceName: 'ara-vault-search',
      onMessage: (m) => {
        const r = m as Record<string, unknown>
        const done = typeof r?.['id'] === 'number' ? waiting.get(r['id']) : undefined
        if (done) {
          waiting.delete(r['id'] as number)
          done(r)
        }
      },
      onGiveUp: () => {
        for (const done of waiting.values()) done({ ok: false, error: 'search worker stopped' })
        waiting.clear()
        worker = null
      }
    }))
  handle('vault:search', async ({ query, cwds }): Promise<VaultSearchResult> => {
    const q = typeof query === 'string' ? query.trim() : ''
    if (q.length < SEARCH_MIN_CHARS) return { ok: true, sessions: [], scanned: 0, truncated: false }
    const files = await allFiles()
    const id = ++reqSeq
    // 앞선 요청은 버린다(워커도 새 id 를 보면 그만둔다).
    for (const [k, done] of waiting) {
      waiting.delete(k)
      done({ ok: false, error: 'superseded' })
    }
    const r = await new Promise<Record<string, unknown>>((res) => {
      waiting.set(id, res)
      if (!ensureWorker().post({ id, query: q, files })) {
        waiting.delete(id)
        res({ ok: false, error: 'search worker not running' })
      }
    })
    if (r['ok'] !== true) return { ok: false, error: String(r['error'] ?? 'search failed') }
    const byHash = hashMap(cwds)
    const out: VaultSession[] = []
    for (const h of (r['hits'] as { file: FileHit; session: ParsedSession; snippet: string }[]) ?? []) {
      const f = h.file
      const s: VaultSession = { agent: f.agent, id: h.session.id!, cwd: h.session.cwd, file: f.path, at: f.mtimeMs, createdAt: f.createdAt, title: h.session.title, firstPrompt: h.session.firstPrompt }
      // 목록 밖(오래된) 파일도 상세·재개·삭제가 되게 이번에 본 파일로 올린다.
      known.set(f.path, f)
      cache.set(f.path, { key: `${f.mtimeMs}:${f.size}`, s })
      out.push({ ...s, ...(f.agent === 'gemini' && !s.cwd ? { cwd: await geminiCwd(f.path, byHash) } : {}), snippet: h.snippet })
    }
    return { ok: true, sessions: out, scanned: Number(r['scanned']) || 0, truncated: r['truncated'] === true }
  })

  // ── M11 삭제(Orca session-delete: 확인은 렌더러가, 여기선 목록에 있던 파일만 · 휴지통으로) ──
  // e2e 는 임시 홈의 픽스처를 사용자 휴지통에 넣지 않는다(PC 침범 금지) — 그냥 지운다.
  const trash = deps.trash ?? (process.env['ARA_E2E'] === '1' ? (p: string) => rm(p, { recursive: true, force: true }) : (p: string) => electronShell.trashItem(p))
  handle('vault:delete', async ({ file }) => {
    const f = typeof file === 'string' ? known.get(file) : undefined
    if (!f) return { ok: false, error: '목록에 없는 파일입니다. 새로 고침 하세요.' }
    try {
      for (const p of deleteTargets(f.agent, f.path, deps.home)) {
        if (existsSync(p)) await trash(p)
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    known.delete(f.path)
    cache.delete(f.path)
    return { ok: true }
  })
}

/**
 * 지울 것들(Orca sessionDeleteRemovals) — 딸린 것 먼저, 기록 파일은 마지막(중간에 실패하면 목록에 남아 다시 지울 수 있게).
 * claude: `<프로젝트 폴더>/<세션 id>/`(하위 에이전트 기록) · `~/.claude/session-env/<세션 id>/` · 기록 파일. 나머지: 기록 파일만.
 * 파일 기록 되감기 백업(file-history)은 사용자 파일의 사본이라 남긴다(Orca 같음).
 */
export function deleteTargets(agent: AgentId, file: string, home: string): string[] {
  const path = resolve(file)
  if (agent !== 'claude') return [path]
  const stem = basename(path, extname(path))
  if (!stem || stem === '.' || stem === '..' || stem.includes(sep)) return [path]
  return [join(dirname(path), stem), join(home, '.claude', 'session-env', stem), path]
}
