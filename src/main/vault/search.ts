// M11 세션 전문 검색 — utility process(searchWorker.ts)가 부르는 순수 Node 부분(시험은 이 함수를 바로 부른다).
// Orca src/main/ai-vault-search(orcaRef fdfcfb3551)는 SQLite FTS5 색인을 child service 로 유지한다. 아라는 색인을 두지 않고
// 검색할 때 최신 파일부터 끝까지 한 줄씩 읽는다(새 의존성 없음 · 대화 내용이 디스크 색인에 또 남지 않음 — Orca 기능 문서의 "비밀이 색인에 남음" 위험).
// ponytail: 매번 전부 읽는다 — 기록이 GB 단위로 쌓여 느려지면 (mtime·크기) 키 색인을 utility process 안에 둔다.
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { AgentId } from '@shared/agents'
import { CHAT_NAME_OPENING } from '@shared/agentOptions'
import { matchSnippet, parseGeminiDocument, parseSessionLines, SEARCH_MAX_RESULTS, type ParsedSession } from '@shared/vault'

export type SearchFile = { agent: AgentId; path: string; mtimeMs: number; size: number; createdAt: number }
export type SearchHit = { file: SearchFile; session: ParsedSession; snippet: string }

/** gemini 옛 json 문서 상한(목록과 같다). */
const DOC_MAX = 4 * 1024 * 1024
/** 한 번에 읽을 파일 수 상한 — 넘으면 truncated(오래된 것은 안 본다). */
export const SEARCH_MAX_FILES = 3000

async function* lines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const l of rl) yield l
  } finally {
    rl.close()
  }
}

async function parseWithSink(f: SearchFile, sink: (t: string) => void): Promise<ParsedSession | null> {
  if (f.agent === 'gemini' && f.path.endsWith('.json')) {
    if (f.size > DOC_MAX) return null
    return parseGeminiDocument(await readFile(f.path, 'utf8'), 0, sink)
  }
  // parseSessionLines 는 동기 Iterable 을 받는다 — 줄을 모아 넘기면 큰 파일이 통째로 메모리에 오른다. 줄마다 따로 넘기고 머리 것을 합친다.
  const merged: ParsedSession = { id: null, cwd: null, title: null, firstPrompt: null, turns: [] }
  for await (const l of lines(f.path)) {
    if (!l.trim()) continue
    const p = parseSessionLines(f.agent, [l], 0, sink)
    merged.id ??= p.id
    merged.cwd ??= p.cwd
    merged.title = p.title ?? merged.title
    merged.firstPrompt ??= p.firstPrompt
  }
  return merged
}

/**
 * 파일들(최신 먼저)에서 query 를 찾는다. 세션 id 가 없거나 채팅 이름 짓기 한 번짜리 실행이면 뺀다(목록과 같은 규칙).
 * 제목·첫 지시·대화 글(사람·에이전트, 하네스 주입 제외)을 본다 — 도구 출력·JSON 키는 안 본다.
 */
export async function searchSessionFiles(
  files: readonly SearchFile[],
  query: string,
  isCancelled: () => boolean = () => false
): Promise<{ hits: SearchHit[]; scanned: number; truncated: boolean }> {
  const needle = query.trim().toLowerCase()
  const hits: SearchHit[] = []
  let scanned = 0
  for (const f of files) {
    if (isCancelled() || hits.length >= SEARCH_MAX_RESULTS || scanned >= SEARCH_MAX_FILES) return { hits, scanned, truncated: true }
    scanned++
    let snippet: string | null = null
    try {
      const s = await parseWithSink(f, (t) => {
        snippet ??= matchSnippet(t, needle)
      })
      if (!s?.id || s.firstPrompt?.startsWith(CHAT_NAME_OPENING)) continue
      snippet ??= (s.title && matchSnippet(s.title, needle)) || null
      if (snippet) hits.push({ file: f, session: s, snippet })
    } catch {
      // 읽는 사이 지워졌거나 못 읽는 파일 — 건너뛴다
    }
  }
  return { hits, scanned, truncated: false }
}
