// R16 [내 신고] — 신고한 PC 가 관리자 댓글·상태 변경을 알아채고 답글을 단다. 계약은 docs/bug-report-api.md.
//
// BugReport.ts 와 같은 규칙: electron 을 import 하지 않는다(경로·fetch 는 호출부가 넘긴다 — 시험이 가짜를 넣는다).
// 🔴 기기 ID 는 헤더에만 싣는다 — 돌려주는 값·로그 어디에도 적지 않는다.
//
// userData/my-reports.json 한 파일에 둘을 둔다:
//   sent — 이 PC 가 보낸 신고 id. **비어 있으면 서버에 묻지 않는다**(신고한 적 없는 PC 가 10분마다 두드리지 않게).
//   seen — 신고별로 마지막으로 본 것. 시각은 **서버 시계**(lastAdminCommentAt)로 적는다 — PC 시계가 틀려도 안 어긋난다.
//          상태·고친 판은 시각 대신 값을 적어 비교한다(서버가 상태 바뀐 시각을 따로 두지 않는다).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  MyReportItem,
  MyReportNews,
  MyReportsResult,
  ReportComment,
  ReportDetail,
  ReportDetailResult,
  ReportFail,
  ReportReplyResult
} from '@shared/bugReport'

export const MY_REPORTS_FILE = 'my-reports.json'
const ID_RE = /^r-\d{8}-\d{4,}$/
const TIMEOUT_MS = 10_000

type Seen = { at: number; status: string; fixedIn: string | null; toasted?: string }
// probed — 1.0.15 이하에서 보낸 신고는 sent 에 없다. 그래서 **처음 한 번은** sent 가 비어도 묻고, 나온 것을 sent 로 들인다.
type MineState = { sent: string[]; seen: Record<string, Seen>; probed?: boolean }
type ServerMine = Omit<MyReportItem, 'fresh'>

/** 본 적 없는 신고의 기준 — 막 보낸 모습. 이보다 달라졌으면 새 것이다. */
const UNSEEN: Seen = { at: 0, status: 'open', fixedIn: null }

export function readMineState(userData: string): MineState {
  try {
    const v = JSON.parse(readFileSync(join(userData, MY_REPORTS_FILE), 'utf8')) as Partial<MineState>
    return {
      sent: Array.isArray(v.sent) ? v.sent.filter((x) => typeof x === 'string') : [],
      seen: v.seen && typeof v.seen === 'object' ? v.seen : {},
      probed: v.probed === true
    }
  } catch {
    return { sent: [], seen: {} } // 없거나 깨졌다 — 처음부터
  }
}

function writeMineState(userData: string, st: MineState): void {
  if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, MY_REPORTS_FILE), JSON.stringify(st))
}

/** 신고를 보낸 뒤 부른다 — 이것이 있어야 폴링이 시작된다. */
export function recordSent(userData: string, id: string): void {
  const st = readMineState(userData)
  if (!st.sent.includes(id)) st.sent.push(id)
  writeMineState(userData, st)
}

/** 새 것인가 — 관리자 댓글이 본 뒤에 달렸거나, 상태·고친 판이 본 것과 다르다. 🔴 내 답글은 여기 안 걸린다. */
export function newsKind(item: ServerMine, seen: Seen = UNSEEN): 'comment' | 'status' | null {
  if ((item.lastAdminCommentAt ?? 0) > seen.at) return 'comment'
  if (item.status !== seen.status || item.fixedIn !== seen.fixedIn) return 'status'
  return null
}

/** 한 번 알린 변화의 열쇠 — 같은 열쇠면 다시 띄우지 않는다. */
const newsKey = (i: { lastAdminCommentAt: number | null; status: string; fixedIn: string | null }): string =>
  `${i.lastAdminCommentAt ?? 0}|${i.status}|${i.fixedIn ?? ''}`

const headers = (device: string) => ({ 'X-ARA-Device': device })

async function failOf(res: Response): Promise<ReportFail> {
  const j = (await res.json().catch(() => null)) as { error?: unknown } | null
  return j && typeof j.error === 'string' ? { ok: false, reason: 'server', error: j.error } : { ok: false, reason: 'http', status: res.status }
}

/**
 * 목록 + 새로 알릴 것. 보낸 신고가 없으면 **서버에 묻지 않는다.**
 * 🔴 닿지 못하면 조용히 ok:false — 사내 서버라 밖에서는 늘 실패한다. 로그 한 줄만(기기 ID 는 안 찍는다).
 */
export async function checkMine(
  api: string,
  device: string,
  userData: string,
  fetchImpl: typeof fetch = fetch
): Promise<MyReportsResult> {
  const st = readMineState(userData)
  if (st.sent.length === 0 && st.probed) return { ok: true, items: [], news: [] }
  let list: ServerMine[]
  try {
    const res = await fetchImpl(`${api}/api/mine`, { headers: headers(device), signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const v: unknown = await res.json()
    if (!Array.isArray(v)) throw new Error('목록이 배열이 아니다')
    list = v as ServerMine[]
  } catch (e) {
    console.warn(`[내 신고] 서버에 닿지 못함: ${(e as Error)?.message ?? e}`)
    return { ok: false }
  }
  const items: MyReportItem[] = []
  const news: MyReportNews[] = []
  let changed = false
  if (!st.probed) {
    st.probed = true
    for (const i of list) if (!st.sent.includes(String(i.id))) st.sent.push(String(i.id))
    changed = true
  }
  for (const i of list) {
    const item: MyReportItem = {
      id: String(i.id),
      number: Number(i.number),
      title: String(i.title ?? ''),
      status: String(i.status ?? ''),
      fixedIn: typeof i.fixedIn === 'string' ? i.fixedIn : null,
      updatedAt: Number(i.updatedAt) || 0,
      lastAdminCommentAt: typeof i.lastAdminCommentAt === 'number' ? i.lastAdminCommentAt : null,
      comments: Number(i.comments) || 0,
      fresh: false
    }
    const seen = st.seen[item.id]
    const kind = newsKind(item, seen)
    item.fresh = kind !== null
    items.push(item)
    if (kind && seen?.toasted !== newsKey(item)) {
      news.push({ id: item.id, number: item.number, kind, status: item.status, fixedIn: item.fixedIn })
      st.seen[item.id] = { ...(seen ?? UNSEEN), toasted: newsKey(item) }
      changed = true
    }
  }
  if (changed) writeMineState(userData, st)
  return { ok: true, items, news }
}

/** 읽음 — 상세를 연 순간의 모습을 적는다. 그 모습으로는 다시 알리지도 않는다. */
export function markSeen(userData: string, r: Pick<ReportDetail, 'id' | 'status' | 'fixedIn' | 'comments'>): void {
  const st = readMineState(userData)
  const lastAdminCommentAt = r.comments.filter((c) => c.author === 'admin').pop()?.at ?? null
  st.seen[r.id] = {
    at: lastAdminCommentAt ?? 0,
    status: r.status,
    fixedIn: r.fixedIn,
    toasted: newsKey({ lastAdminCommentAt, status: r.status, fixedIn: r.fixedIn })
  }
  writeMineState(userData, st)
}

const badId: ReportFail = { ok: false, reason: 'server', error: '신고 번호가 올바르지 않습니다.' }

/** 상세 — 성공하면 읽음으로 적는다. id 는 렌더러에서 온 값이라 모양부터 본다(주소에 그대로 붙으므로). */
export async function fetchDetail(
  api: string,
  device: string,
  userData: string,
  id: string,
  fetchImpl: typeof fetch = fetch
): Promise<ReportDetailResult> {
  if (!ID_RE.test(id)) return badId
  let res: Response
  try {
    res = await fetchImpl(`${api}/api/reports/${id}`, { headers: headers(device), signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (!res.ok) return failOf(res)
  const d = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!d) return { ok: false, reason: 'http', status: res.status }
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const report: ReportDetail = {
    id: s(d.id),
    number: Number(d.number),
    title: s(d.title),
    what: s(d.what),
    happened: s(d.happened),
    expected: s(d.expected),
    status: s(d.status),
    fixedIn: typeof d.fixedIn === 'string' ? d.fixedIn : null,
    createdAt: Number(d.createdAt) || 0,
    comments: (Array.isArray(d.comments) ? d.comments : []).map(
      (c: Record<string, unknown>): ReportComment => ({
        at: Number(c.at) || 0,
        author: c.author === 'admin' ? 'admin' : 'reporter',
        body: s(c.body)
      })
    )
  }
  markSeen(userData, report)
  return { ok: true, report }
}

/** 답글 — 한 번만 보낸다(다시 보내지 않는다 — DLP 규칙과 같다). */
export async function postReply(
  api: string,
  device: string,
  id: string,
  body: string,
  fetchImpl: typeof fetch = fetch
): Promise<ReportReplyResult> {
  if (!ID_RE.test(id)) return badId
  let res: Response
  try {
    res = await fetchImpl(`${api}/api/reports/${id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers(device) },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (!res.ok) return failOf(res)
  const j = (await res.json().catch(() => null)) as { comment?: ReportComment } | null
  if (!j?.comment) return { ok: false, reason: 'http', status: res.status }
  return { ok: true, comment: j.comment }
}
