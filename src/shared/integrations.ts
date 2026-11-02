// M15 R1 연동 — 사내 GitLab(IN-01) · Slack Socket Mode(IN-02). 둘 다 **기본 꺼짐**(결정 묶음 11 :100, :113).
// 설정은 userData/integrations.json, 토큰은 vault(safeStorage) — 화면·로그로 나가지 않는다(렌더러는 '있다/없다'만 안다).

export type GitLabPrefs = { enabled: boolean; baseUrl: string }
/** channel = 알림을 올릴 채널 id(C…). users = 명령을 받을 Slack user id(U…) — 비면 아무 명령도 안 받는다.
 *  allowRun = IN-02b 시작·이어 지시를 받는다(기본 꺼짐 — 상태·질문·답·취소만). */
export type SlackPrefs = { enabled: boolean; channel: string; users: string[]; notify: boolean; allowRun: boolean }
export type IntegrationsPrefs = { gitlab: GitLabPrefs; slack: SlackPrefs }

export type SlackLink = 'off' | 'connecting' | 'connected' | 'error'
export type IntegrationsState = {
  gitlab: GitLabPrefs & { hasToken: boolean }
  slack: SlackPrefs & { hasAppToken: boolean; hasBotToken: boolean; link: SlackLink; error?: string }
}

/** 토큰 바꾸기: undefined = 그대로, '' = 지우기, 그 밖 = 새 값. */
export type GitLabSave = GitLabPrefs & { token?: string }
export type SlackSave = SlackPrefs & { appToken?: string; botToken?: string }

export type GitLabMr = {
  iid: number
  title: string
  state: string
  draft: boolean
  url: string
  source: string
  target: string
  author: string
  /** head_pipeline.status(없으면 null). */
  pipeline: string | null
  /** detailed_merge_status(없으면 merge_status). */
  merge: string | null
  updatedAt: string
}
export type GitLabMrState = 'opened' | 'merged' | 'closed' | 'all'
/** error = 코드(off·noToken·noRemote·otherHost·token·forbidden·notFound·exists·network·http) — 렌더러가 gitlab.err.<코드>로 옮긴다. */
export type GitLabResult<T> = ({ ok: true } & T) | { ok: false; error: string; detail?: string }

export const DEFAULT_INTEGRATIONS: IntegrationsPrefs = {
  gitlab: { enabled: false, baseUrl: '' },
  slack: { enabled: false, channel: '', users: [], notify: true, allowRun: false }
}

const SLACK_ID = /^[A-Z0-9]{2,20}$/

/** 주소 → `https://host[:port][/경로]`(끝 / 없음). http(s) 가 아니면 ''. */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

export function integrationsPrefsOf(v: unknown): IntegrationsPrefs {
  const o = (v && typeof v === 'object' ? v : {}) as { gitlab?: Partial<GitLabPrefs>; slack?: Partial<SlackPrefs> }
  const g = o.gitlab ?? {}
  const s = o.slack ?? {}
  return {
    gitlab: { enabled: g.enabled === true, baseUrl: normalizeBaseUrl(g.baseUrl) },
    slack: {
      enabled: s.enabled === true,
      channel: typeof s.channel === 'string' && SLACK_ID.test(s.channel.trim()) ? s.channel.trim() : '',
      users: slackUsersOf(s.users),
      notify: s.notify !== false,
      allowRun: s.allowRun === true
    }
  }
}

/** 배열이든 쉼표·공백 글이든 → 중복 없는 Slack user id 목록. 모양이 아닌 것은 버린다. */
export function slackUsersOf(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []
  return [...new Set(parts.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => SLACK_ID.test(x)))]
}

/**
 * git 원격 주소 → { host, path }. `https://host/a/b.git` · `ssh://git@host:2222/a/b.git` · `git@host:a/b.git`.
 * host 는 hostname 만(포트 빼고) — 같은 GitLab 이 https 와 ssh 를 다른 포트로 낸다.
 */
export function parseGitRemote(url: string): { host: string; path: string } | null {
  const s = url.trim()
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(s)
  if (scp) return { host: scp[1]!.toLowerCase(), path: scp[2]! }
  try {
    const u = new URL(s)
    const path = decodeURIComponent(u.pathname).replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
    return u.hostname && path.includes('/') ? { host: u.hostname.toLowerCase(), path } : null
  } catch {
    return null
  }
}

/**
 * 원격 경로 → 이 GitLab 안 프로젝트 경로. GitLab 이 하위 경로(`https://host/gitlab`)에 있으면 https 원격의 앞 경로를 뗀다.
 * 다른 호스트면 null — **토큰을 그 호스트로 보내지 않는다**.
 */
export function projectPathFor(baseUrl: string, remoteUrl: string): string | null {
  const r = parseGitRemote(remoteUrl)
  if (!r || !baseUrl) return null
  const b = new URL(baseUrl)
  if (b.hostname.toLowerCase() !== r.host) return null
  const prefix = b.pathname.replace(/^\/+/, '')
  const path = prefix && r.path.startsWith(prefix + '/') ? r.path.slice(prefix.length + 1) : r.path
  return path.includes('/') ? path : null
}
