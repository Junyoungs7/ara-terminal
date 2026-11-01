// M7 R1 WS-11 diff 줄 주석 → 에이전트 — 순수 규칙. Orca shared/diff-comment-types·diff-comments-format,
// store/slices/diff-comment-persistence(normalizeDiffComment)(orcaRef fdfcfb3551)의 1차 판.
import type { DiffMode } from './gitDiff'

export type DiffComment = {
  id: string
  /** 워크트리 기준 '/' 경로. */
  filePath: string
  /** 범위 시작(포함). lineNumber 이하일 때만. */
  startLine?: number
  /** 범위 끝(포함) — diff 의 바뀐 쪽(오른쪽) 줄 번호. 0 = 파일 전체. */
  lineNumber: number
  body: string
  createdAt: number
  updatedAt?: number
  /** 에이전트에게 보낸 때. 고치면 지운다(Orca). */
  sentAt?: number
  scope?: DiffMode
}

/** Orca formatDiffComment — 붙여 넣는 계약을 결정적·따옴표 안전하게. */
export function formatDiffComment(c: DiffComment): string {
  const escaped = c.body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  const loc = c.lineNumber === 0 ? 'Scope: file' : c.startLine !== undefined && c.startLine !== c.lineNumber ? `Lines: ${c.startLine}-${c.lineNumber}` : `Line: ${c.lineNumber}`
  return [`File: ${c.filePath}`, loc, `User comment: "${escaped}"`].join('\n')
}

export const formatDiffComments = (comments: readonly DiffComment[]): string => comments.map(formatDiffComment).join('\n\n')

/** 저장소에서 읽은 값 하나 → 주석(모양이 틀리면 null). Orca normalizeDiffComment 의 규칙 + 모양 검사. */
export function normalizeDiffComment(v: unknown): DiffComment | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const { id, filePath, lineNumber, body, createdAt } = o
  if (typeof id !== 'string' || typeof filePath !== 'string' || typeof body !== 'string') return null
  if (typeof lineNumber !== 'number' || !Number.isInteger(lineNumber) || lineNumber < 0 || typeof createdAt !== 'number') return null
  const startLine = Number.isInteger(o.startLine) && (o.startLine as number) >= 1 && (o.startLine as number) <= lineNumber ? (o.startLine as number) : undefined
  const sentAt = typeof o.sentAt === 'number' && Number.isFinite(o.sentAt) && o.sentAt > 0 ? o.sentAt : undefined
  const updatedAt = typeof o.updatedAt === 'number' ? o.updatedAt : undefined
  const scope = o.scope === 'unstaged' || o.scope === 'staged' || o.scope === 'branch' ? o.scope : undefined
  return { id, filePath, lineNumber, body, createdAt, ...(startLine !== undefined ? { startLine } : {}), ...(sentAt ? { sentAt } : {}), ...(updatedAt ? { updatedAt } : {}), ...(scope ? { scope } : {}) }
}

/** 저장 형식 = { [워크트리 경로]: DiffComment[] }. 깨진 항목은 버리고 나머지는 살린다. */
export function parseStoredComments(raw: unknown): Record<string, DiffComment[]> {
  const out: Record<string, DiffComment[]> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const ok = list.map(normalizeDiffComment).filter((c): c is DiffComment => c !== null)
    if (ok.length) out[k] = ok
  }
  return out
}

/** 보낸 것 표시 — 보낸 사이 고친 주석(updatedAt 이 보낸 스냅숏보다 뒤)은 그대로 둔다(Orca deliverySnapshotMatches). */
export function markSent(list: readonly DiffComment[], sent: readonly DiffComment[], at: number): DiffComment[] {
  const snap = new Map(sent.map((c) => [c.id, c]))
  return list.map((c) => {
    const s = snap.get(c.id)
    return s && s.body === c.body && s.lineNumber === c.lineNumber && s.startLine === c.startLine ? { ...c, sentAt: at } : c
  })
}
