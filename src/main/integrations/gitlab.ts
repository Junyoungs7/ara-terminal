// M15 IN-01 사내 GitLab — REST v4 를 개인 토큰(PRIVATE-TOKEN)으로 직접 부른다.
// Orca(src/main/gitlab/*)는 glab CLI 의 로그인을 빌려 같은 REST 경로(projects/:id/merge_requests, user)를 부른다 — 아라는 CLI 설치·로그인을
// 요구하지 않으려고 같은 경로를 토큰으로 부른다. 응답 → 목록 칸은 Orca mappers.ts(mapMRInfo: draft·web_url·head_pipeline·detailed_merge_status)를 따랐다.
// 토큰은 이 파일 밖으로 나가지 않는다(오류 글에도 안 싣는다).
import type { GitLabMr, GitLabMrState, GitLabResult } from '@shared/integrations'

export type FetchLike = (
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const TIMEOUT_MS = 15_000
const PER_PAGE = 20
type Fail = { ok: false; error: string; detail?: string }

const enc = (project: string): string => encodeURIComponent(project)

type RawMr = {
  iid?: number
  title?: string
  state?: string
  draft?: boolean
  work_in_progress?: boolean
  web_url?: string
  source_branch?: string
  target_branch?: string
  author?: { username?: string } | null
  head_pipeline?: { status?: string } | null
  detailed_merge_status?: string
  merge_status?: string
  updated_at?: string
}

export function mapMr(d: RawMr): GitLabMr {
  const title = d.title ?? ''
  return {
    iid: d.iid ?? 0,
    title,
    state: d.state ?? '',
    // Orca mapMRState: draft 깃발 또는 옛 Draft:/WIP: 머리말.
    draft: d.draft === true || d.work_in_progress === true || /^(draft|wip):\s*/i.test(title),
    url: d.web_url ?? '',
    source: d.source_branch ?? '',
    target: d.target_branch ?? '',
    author: d.author?.username ?? '',
    pipeline: d.head_pipeline?.status ?? null,
    merge: d.detailed_merge_status ?? d.merge_status ?? null,
    updatedAt: d.updated_at ?? ''
  }
}

/** HTTP 상태 → 오류 코드. GitLab 의 message(문자열·배열)는 detail 로(토큰 없는 서버 말). */
async function failOf(res: { status: number; json(): Promise<unknown> }): Promise<Fail> {
  let detail: string | undefined
  try {
    const b = (await res.json()) as { message?: unknown; error?: unknown }
    const m = b?.message ?? b?.error
    detail = typeof m === 'string' ? m : Array.isArray(m) ? m.join(', ') : m ? JSON.stringify(m) : undefined
  } catch {
    /* 본문 없음 */
  }
  const error = res.status === 401 ? 'token' : res.status === 403 ? 'forbidden' : res.status === 404 ? 'notFound' : res.status === 409 ? 'exists' : 'http'
  return { ok: false, error, detail: detail?.slice(0, 300) ?? `HTTP ${res.status}` }
}

export function createGitLabClient(fetch: FetchLike, baseUrl: string, token: string) {
  const call = async (method: string, path: string, body?: unknown): Promise<{ ok: true; data: unknown } | Fail> => {
    let res
    try {
      res = await fetch(`${baseUrl}/api/v4/${path}`, {
        method,
        headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (e) {
      return { ok: false, error: 'network', detail: e instanceof Error ? e.message : String(e) }
    }
    if (!res.ok) return failOf(res)
    try {
      return { ok: true, data: await res.json() }
    } catch {
      return { ok: false, error: 'http', detail: 'JSON' }
    }
  }
  return {
    async viewer(): Promise<GitLabResult<{ user: string }>> {
      const r = await call('GET', 'user')
      if (!r.ok) return r
      return { ok: true, user: String((r.data as { username?: unknown })?.username ?? '') }
    },
    async listMrs(project: string, state: GitLabMrState): Promise<GitLabResult<{ mrs: GitLabMr[] }>> {
      const st = state === 'all' ? '' : `&state=${state}`
      const r = await call('GET', `projects/${enc(project)}/merge_requests?per_page=${PER_PAGE}&order_by=updated_at&sort=desc${st}`)
      if (!r.ok) return r
      return { ok: true, mrs: (Array.isArray(r.data) ? (r.data as RawMr[]) : []).map(mapMr) }
    },
    async createMr(project: string, mr: { source: string; target: string; title: string; description: string }): Promise<GitLabResult<{ mr: GitLabMr }>> {
      const r = await call('POST', `projects/${enc(project)}/merge_requests`, {
        source_branch: mr.source,
        target_branch: mr.target,
        title: mr.title,
        description: mr.description
      })
      if (!r.ok) return r
      return { ok: true, mr: mapMr(r.data as RawMr) }
    }
  }
}
