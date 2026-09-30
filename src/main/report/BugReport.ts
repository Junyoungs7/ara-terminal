// 오류 신고(#206) — main 쪽 수집·조립·보내기. 계약은 docs/bug-report-api.md, 기획은 docs/plan-bug-report.md.
//
// electron 을 import 하지 않는다: 창·경로·세션은 호출부(registerReportIpc)가 넘긴다 — 그래야 시험이
// 가짜 세션을 넣고 **결과 JSON 전체**를 훑을 수 있다(호스트·경로·제목이 새지 않는지).
//
// 🔴 넣지 않는 것(기획 §2): 셸 히스토리 · AI 대화 · 프로필 · 호스트키 · 터미널 내용.
//    이 파일이 읽는 것은 세션의 `type`, 로그 꼬리, ui 설정의 허용 목록뿐이다 — 새 출처를 더하려면
//    기획 §2 표부터 고친다.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { maskSecrets } from '@shared/maskSecrets'
import type { Session, UiState } from '@shared/types'
import { imageMime, PASTE_BYTES_MAX, PASTE_MAX } from '@shared/bugReport'
import type { ReportAttachmentName, ReportSendReq, ReportSendResult } from '@shared/bugReport'

export const DEVICE_ID_FILE = 'device-id'
export const LOG_TAIL_LINES = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// 닿지 않는 서버를 무한히 기다리지 않는다. 다시 보내지도 않는다(DLP 규칙 — 막히면 알리고 멈춘다).
const POST_TIMEOUT_MS = 30_000

/**
 * 기기 ID — `userData/device-id` 의 uuid 하나. 없거나 깨졌으면 새로 만든다.
 * 🔴 workspace.json 에 두지 않는다(스냅샷·복원과 수명이 다르다). 🔴 화면·로그에 찍지 않는다 — 서버에서
 *    "자기 신고"를 여는 열쇠다(계약 §인증).
 */
export function deviceId(userData: string): string {
  const path = join(userData, DEVICE_ID_FILE)
  try {
    const v = readFileSync(path, 'utf8').trim()
    if (UUID_RE.test(v)) return v
  } catch {
    // 없다 — 아래에서 만든다
  }
  const id = randomUUID()
  if (!existsSync(userData)) mkdirSync(userData, { recursive: true })
  writeFileSync(path, id)
  return id
}

/** `main-error.log` 꼬리 N줄, 마스킹한 것. 파일이 없으면 빈 문자열(오류가 한 번도 없었다). */
export function logTail(path: string, lines = LOG_TAIL_LINES): string {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return ''
  }
  return maskSecrets(text.split('\n').slice(-lines).join('\n'))
}

/**
 * 세션 **모양** — 종류별 개수와 떼어낸 창 수. 🔴 호스트·경로·제목은 **읽지도 않는다**(type 만 센다).
 * 서버는 이 값을 공개 필드(env.sessions)로 목록에 띄운다.
 */
export function sessionShape(sessions: readonly Pick<Session, 'type'>[], windows: number): Record<string, number> {
  const out: Record<string, number> = { ssh: 0, local: 0, rdp: 0, windows }
  for (const s of sessions) out[s.type] = (out[s.type] ?? 0) + 1
  return out
}

// ui 설정 중 **보내도 되는 것**만. 허용 목록이라 새 설정이 생겨도 저절로 실리지 않는다.
// 빠진 것과 이유: sessionLogDir·appLogDir(경로 — 사용자 이름이 든다) · araCallName·araChatNames(사람 이름·대화)
// · aiCompatibleBaseUrl(사내 주소) · groups·workProfiles·aiCliRecent(서버·폴더 이름) · sidebar(쓸모 없음).
const SETTINGS_KEYS = [
  'font',
  'locale',
  'uiScale',
  'scrollback',
  'copyOnSelect',
  'cursorStyle',
  'cursorBlink',
  'bell',
  'termCompletion',
  'mcpEnabled',
  'sessionLog',
  'logRetentionDays',
  'aiProvider',
  'bootSplash'
] as const satisfies readonly (keyof UiState)[]

export function safeSettings(ui: UiState): string {
  const out: Record<string, unknown> = {}
  for (const k of SETTINGS_KEYS) if (ui[k] !== undefined) out[k] = ui[k]
  return JSON.stringify(out, null, 2)
}

export type ReportContext = {
  deviceId: string
  version: string
  os: string
  electron: string
  sessions: Record<string, number>
  /** 보낼 때 main 이 다시 만든다(렌더러가 끼워 넣을 자리가 없다 — ReportSendReq 주석). */
  settings: string
}

const MIME: Record<ReportAttachmentName, string> = {
  'capture.png': 'image/png',
  'main-error.log': 'text/plain',
  'renderer-errors.json': 'application/json',
  'settings.json': 'application/json'
}

/**
 * 요청 본문 + **보낸 바이트**(해시 대조용). 체크된 첨부만 싣는다.
 * 렌더러 오류의 마스킹은 여기서 건다(링버퍼는 원문을 들고 있다). 로그는 미리보기 때 이미 마스킹됐지만
 * 렌더러를 거쳐 돌아온 값이라 한 번 더 건다(멱등이다).
 */
export function buildReport(req: ReportSendReq, ctx: ReportContext): { body: string; sent: Map<string, Buffer> } {
  const sent = new Map<string, Buffer>()
  if (req.capture) sent.set('capture.png', Buffer.from(req.capture, 'base64'))
  if (req.log) sent.set('main-error.log', Buffer.from(maskSecrets(req.log)))
  if (req.rendererErrors?.length) {
    const masked = req.rendererErrors.map((e) => ({ ...e, message: maskSecrets(e.message), stack: maskSecrets(e.stack) }))
    sent.set('renderer-errors.json', Buffer.from(JSON.stringify(masked, null, 2)))
  }
  if (req.settings) sent.set('settings.json', Buffer.from(ctx.settings))
  // #9 붙여 넣은 이미지 — 렌더러가 잰 것을 다시 잰다(매직 바이트 · 5MB · 3장). 이름은 여기서만 붙는다.
  let n = 0
  for (const img of req.images ?? []) {
    const bytes = Buffer.from(img.base64, 'base64')
    const mime = imageMime(bytes)
    if (!mime || bytes.length > PASTE_BYTES_MAX || n >= PASTE_MAX) continue
    sent.set(`paste-${++n}.${mime === 'image/png' ? 'png' : 'jpg'}`, bytes)
  }

  const body = JSON.stringify({
    title: req.title,
    what: req.what,
    happened: req.happened,
    expected: req.expected,
    name: req.name,
    deviceId: ctx.deviceId,
    env: { version: ctx.version, os: ctx.os, electron: ctx.electron, gpu: req.gpu, sessions: ctx.sessions },
    attachments: [...sent].map(([name, bytes]) => ({
      name,
      mime: MIME[name as ReportAttachmentName] ?? imageMime(bytes),
      base64: bytes.toString('base64')
    }))
  })
  return { body, sent }
}

/** 서버가 받은 해시와 보낸 바이트의 sha256 이 다른 첨부(기획 §4). 해시가 아예 없으면 못 받은 것 — 그것도 알린다. */
export function tamperedOf(sent: Map<string, Buffer>, hashes: Record<string, unknown> | undefined): string[] {
  const out: string[] = []
  for (const [name, bytes] of sent) {
    if (hashes?.[name] !== createHash('sha256').update(bytes).digest('hex')) out.push(name)
  }
  return out
}

/** POST 한 번. 🔴 실패해도 다시 보내지 않는다 — 결과를 그대로 돌려주고 사람이 정한다. */
export async function postReport(
  api: string,
  built: { body: string; sent: Map<string, Buffer> },
  fetchImpl: typeof fetch = fetch
): Promise<ReportSendResult> {
  let res: Response
  try {
    res = await fetchImpl(`${api}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: built.body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (res.ok && json && typeof json.id === 'string' && typeof json.number === 'number') {
    return {
      ok: true,
      id: json.id,
      number: json.number,
      tampered: tamperedOf(built.sent, json.hashes as Record<string, unknown> | undefined)
    }
  }
  if (json && typeof json.error === 'string') return { ok: false, reason: 'server', error: json.error }
  return { ok: false, reason: 'http', status: res.status }
}
