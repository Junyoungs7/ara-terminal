// M4 AI-07 지난 에이전트 세션 — 순수 규칙(main 스캔·렌더러 목록·단위 시험이 같이 읽는다).
// Orca(orcaRef fdfcfb3551) src/main/ai-vault 의 핵심만 옮겼다:
//  · 레코드 읽기 = session-scanner-primary-parsers.ts(claude) · session-scanner-codex-parser.ts(session_meta·turn_context·event_msg)
//    · session-scanner-gemini-parsers.ts(user·gemini 메시지, json 문서·jsonl 둘 다)
//  · 큰 파일은 머리·꼬리만 — 첫 지시·id·cwd 는 머리, 최근 턴은 꼬리(local-log-tail-reader 의 꼬리 읽기 방식).
//  · 재개 명령의 cd 부분 = shared/ai-vault-resume-command.ts buildAiVaultResumeShellCommand(셸별 문법).
import type { AgentId } from './agents'
import type { LaunchShell } from './aiCli'
import { quoteArg } from './agents'

export type VaultTurn = { role: 'user' | 'assistant'; text: string }

export type VaultSession = {
  agent: AgentId
  /** 재개에 넘길 세션 id. */
  id: string
  /** 그 세션을 시작한 폴더. 모르면 null(gemini 는 프로젝트 해시만 남긴다 — main 이 아는 폴더와 맞춰 본다). */
  cwd: string | null
  file: string
  /** 마지막 기록 시각(ms, 파일 mtime) — 목록 정렬. */
  at: number
  /** CLI 가 붙인 제목(claude custom-title·ai-title). */
  title: string | null
  firstPrompt: string | null
}

export type VaultDetail = { ok: true; session: VaultSession; turns: VaultTurn[] } | { ok: false; error: string }

/** 상세에 보일 최근 턴 수. */
export const DETAIL_TURNS = 8
/** 한 턴 글의 상한(화면 — 긴 출력 통째로 안 싣는다). */
const TURN_CHARS = 2000

// 세션 id 는 파일 내용(신뢰 경계 밖)이다 — 셸 줄에 들어가므로 uuid 꼴만 받는다.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** 하네스가 사용자 턴처럼 끼워 넣는 글(Orca isKnownHarnessInjectedUserTurnText) — 첫 지시가 아니다. */
const INJECTED = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr|environment_context|user_instructions)>/

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** content(글 · [{type:'text',text}] · gemini [{text}]) → 글. tool_result·이미지 조각은 뺀다. */
export function textOfContent(content: unknown): string | null {
  if (typeof content === 'string') return str(content)
  if (!Array.isArray(content)) return null
  const parts = content
    .map((p) => rec(p))
    .filter((p): p is Rec => !!p && (p.type === undefined || p.type === 'text' || p.type === 'input_text' || p.type === 'output_text'))
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
  return parts.length ? parts.join('\n') : null
}

type Acc = { id: string | null; cwd: string | null; title: string | null; aiTitle: string | null; firstPrompt: string | null; turns: VaultTurn[] }

function pushTurn(acc: Acc, role: VaultTurn['role'], text: string | null, keep: number): void {
  if (!text) return
  if (role === 'user') {
    if (INJECTED.test(text)) return
    acc.firstPrompt ??= text.trim()
  }
  acc.turns.push({ role, text: text.length > TURN_CHARS ? text.slice(0, TURN_CHARS) + '…' : text })
  if (acc.turns.length > keep) acc.turns.shift()
}

function consume(agent: AgentId, acc: Acc, r: Rec, keep: number): void {
  if (agent === 'claude') {
    acc.id ??= str(r.sessionId)
    acc.cwd ??= str(r.cwd) // 첫 cwd(Orca #9361 — 재개는 시작한 폴더에서)
    if (r.type === 'custom-title') acc.title = str(r.customTitle) ?? acc.title
    else if (r.type === 'ai-title') acc.aiTitle = str(r.aiTitle) ?? acc.aiTitle
    else if (r.type === 'user' && r.isMeta !== true) pushTurn(acc, 'user', textOfContent(rec(r.message)?.content), keep)
    else if (r.type === 'assistant') pushTurn(acc, 'assistant', textOfContent(rec(r.message)?.content), keep)
    return
  }
  if (agent === 'codex') {
    const p = rec(r.payload)
    if (!p) return
    if (r.type === 'session_meta') {
      // 갈래(fork)는 부모 메타를 뒤에 또 싣는다 — 첫 것이 이 세션.
      acc.id ??= str(p.id)
      acc.cwd ??= str(p.cwd)
    } else if (r.type === 'turn_context') acc.cwd ??= str(p.cwd)
    else if (r.type === 'event_msg' && p.type === 'user_message') pushTurn(acc, 'user', str(p.message), keep)
    else if (r.type === 'event_msg' && p.type === 'agent_message') pushTurn(acc, 'assistant', str(p.message), keep)
    return
  }
  acc.id ??= str(r.sessionId)
  if (r.type === 'user') pushTurn(acc, 'user', textOfContent(r.content), keep)
  else if (r.type === 'gemini') pushTurn(acc, 'assistant', textOfContent(r.content), keep)
}

export type ParsedSession = { id: string | null; cwd: string | null; title: string | null; firstPrompt: string | null; turns: VaultTurn[] }

/** jsonl 줄들 → 세션 요지. 깨진 줄(머리·꼬리 경계·쓰는 중)은 건너뛴다. */
export function parseSessionLines(agent: AgentId, lines: Iterable<string>, keep = DETAIL_TURNS): ParsedSession {
  const acc: Acc = { id: null, cwd: null, title: null, aiTitle: null, firstPrompt: null, turns: [] }
  for (const line of lines) {
    if (!line.trim()) continue
    let r: Rec | null = null
    try {
      r = rec(JSON.parse(line))
    } catch {
      continue
    }
    if (r) consume(agent, acc, r, keep)
  }
  return done(acc)
}

/** gemini 옛 형식(json 문서 하나: sessionId·messages[]). */
export function parseGeminiDocument(text: string, keep = DETAIL_TURNS): ParsedSession {
  const acc: Acc = { id: null, cwd: null, title: null, aiTitle: null, firstPrompt: null, turns: [] }
  let doc: Rec | null = null
  try {
    doc = rec(JSON.parse(text))
  } catch {
    return done(acc)
  }
  acc.id = str(doc?.sessionId)
  for (const m of Array.isArray(doc?.messages) ? doc.messages : []) {
    const r = rec(m)
    if (r) consume('gemini', acc, r, keep)
  }
  return done(acc)
}

function done(acc: Acc): ParsedSession {
  return { id: acc.id && SAFE_ID.test(acc.id) ? acc.id : null, cwd: acc.cwd, title: acc.title ?? acc.aiTitle, firstPrompt: acc.firstPrompt, turns: acc.turns }
}

/**
 * 머리·꼬리 조각 → 온전한 줄. tail 이 없으면 머리가 파일 전부다. 있으면 머리의 끝 줄·꼬리의 첫 줄은 잘렸을 수 있어 버린다.
 */
export function headTailLines(head: string, tail: string | null): string[] {
  const h = head.split('\n')
  if (tail === null) return h
  h.pop()
  const t = tail.split('\n')
  t.shift()
  return [...h, ...t]
}

/** 최신이 위. 같은 시각이면 id 순(목록이 흔들리지 않게). */
export function sortSessions<T extends Pick<VaultSession, 'at' | 'id'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
}

/** 경로 비교 키 — 끝 구분자·`\`/`/` 차이를 없애고, Windows 드라이브 경로는 대소문자도 무시. */
export function pathKey(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s
}

/**
 * 복사용 재개 명령 — 실행 계획 한 줄(planAgentLaunch resume) 앞에 그 셸 문법으로 폴더 이동을 붙인다(Orca buildAiVaultResumeShellCommand).
 * 폴더를 그 셸에 담을 수 없으면(cmd 의 `"%!`) 폴더 없이 한 줄만.
 */
export function resumeCommandText(line: string, cwd: string | null, shell: LaunchShell): string {
  const q = cwd ? quoteArg(cwd, shell) : null
  if (!q) return line
  if (shell === 'powershell') return `Set-Location -LiteralPath ${q}; ${line}`
  if (shell === 'cmd') return `cd /d ${q} && ${line}`
  return `cd ${q} && ${line}`
}
