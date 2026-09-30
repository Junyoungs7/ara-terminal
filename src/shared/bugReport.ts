// 오류 신고(#206) — main 과 렌더러가 같이 쓰는 모양. 서버와의 계약은 docs/bug-report-api.md 가 정본이다.

/** 서버가 받는 첨부 이름 — 계약의 허용 목록 그대로(그 밖은 서버가 400). */
export const REPORT_ATTACHMENTS = ['capture.png', 'main-error.log', 'renderer-errors.json', 'settings.json'] as const
export type ReportAttachmentName = (typeof REPORT_ATTACHMENTS)[number]

/**
 * 오류 신고 #9 — 사용자가 붙여 넣은(끌어다 놓은) 이미지. 사용자가 고른 것이라 **그대로** 보낸다.
 * 서버 이름은 main 이 정한다(`paste-1.png`~`paste-3.jpg`) — 렌더러가 이름을 고를 자리가 없다.
 */
export const PASTE_MAX = 3
export const PASTE_BYTES_MAX = 5 * 1024 * 1024
export type PastedImage = { mime: 'image/png' | 'image/jpeg'; base64: string }

/** 매직 바이트로만 가른다(파일 이름·type 은 믿지 않는다). 서버 server.mjs 의 imageMime 과 같은 규칙. */
export function imageMime(b: Uint8Array): PastedImage['mime'] | null {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length >= PNG.length && PNG.every((v, i) => b[i] === v)) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  return null
}

/** 렌더러 오류 한 건(링버퍼 원소). 마스킹은 **보낼 때** main 이 건다. */
export type RendererError = { at: number; message: string; stack: string }

/**
 * `report:prepare` 의 답 — 신고 창이 **보내기 전에 보여 줄 것**.
 * capture 는 PNG base64(찍지 못했으면 null). log 는 이미 마스킹된 꼬리다.
 */
export type ReportPrepared = { capture: string | null; log: string; settings: string }

/**
 * `report:send` 요청. 첨부는 **체크된 것만** 싣는다(없으면 안 보낸다).
 * capture·log 는 미리보기로 받은 것을 그대로 돌려준다 — 보여 준 것과 보내는 것이 같아야 한다.
 * settings 는 켬/끔만 받는다: 내용은 main 이 허용 목록으로 다시 만든다(렌더러가 끼워 넣을 자리가 없다).
 * 🔴 기기 ID 는 여기 없다 — main 만 알고 main 이 싣는다.
 */
export type ReportSendReq = {
  title: string
  what: string
  happened: string
  expected: string
  name: string
  gpu: string
  capture?: string
  log?: string
  rendererErrors?: RendererError[]
  settings?: boolean
  /** 붙여 넣은 이미지(#9). main 이 매직 바이트·크기·개수를 다시 재고 이름을 붙인다. */
  images?: PastedImage[]
}

/**
 * 결과. 실패는 **자동으로 다시 보내지 않는다**(DLP 규칙 — 막히면 알리고 멈춘다).
 * server: 서버가 준 `error` 문장(그대로 보여 준다). network: 닿지 못함. http: 문장 없는 거절.
 * tampered: 서버가 받은 해시가 보낸 것과 다른 첨부 이름(사내 보안 프로그램이 바꿨을 수 있다).
 */
export type ReportSendResult =
  | { ok: true; id: string; number: number; tampered: string[] }
  | { ok: false; reason: 'server'; error: string }
  | { ok: false; reason: 'network' }
  | { ok: false; reason: 'http'; status: number }

// ── R16 [내 신고] — 신고한 PC 가 관리자 댓글·상태 변경을 받아 본다 ─────────────────────────
// 🔴 기기 ID 는 여기 어디에도 없다 — main 이 헤더에 싣고, 렌더러는 신고 id 로만 말한다.

/** 실패 모양 — ReportSendResult 의 실패 셋과 같다(화면이 같은 문장으로 그린다). */
export type ReportFail = Exclude<ReportSendResult, { ok: true }>

/** 서버 `GET /api/mine` 한 줄 + fresh(관리자 댓글·상태·고친 판이 마지막으로 본 뒤 바뀌었다). */
export type MyReportItem = {
  id: string
  number: number
  title: string
  status: string
  fixedIn: string | null
  updatedAt: number
  lastAdminCommentAt: number | null
  comments: number
  fresh: boolean
}

/** 토스트로 한 번 알릴 것. 같은 변화는 두 번 오지 않는다(main 이 기억한다). */
export type MyReportNews = { id: string; number: number; kind: 'comment' | 'status'; status: string; fixedIn: string | null }

/** `report:mine`. 이 PC 가 보낸 신고가 없으면 서버에 묻지 않고 빈 목록이다. 닿지 못하면 ok:false(조용히). */
export type MyReportsResult = { ok: true; items: MyReportItem[]; news: MyReportNews[] } | { ok: false }

export type ReportComment = { at: number; author: 'admin' | 'reporter'; body: string }

/** `report:detail` — 서버 상세 중 화면이 쓰는 것만. 첨부·env 는 싣지 않는다. */
export type ReportDetail = {
  id: string
  number: number
  title: string
  what: string
  happened: string
  expected: string
  status: string
  fixedIn: string | null
  createdAt: number
  comments: ReportComment[]
}

export type ReportDetailResult = { ok: true; report: ReportDetail } | ReportFail
export type ReportReplyResult = { ok: true; comment: ReportComment } | ReportFail
