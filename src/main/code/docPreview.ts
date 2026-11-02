// 3차 R1-B HTML 미리 보기 — 작업 단위의 .html 을 샌드박스 iframe 에 그리는 전용 프로토콜(ara-doc://<허가 id>/<상대 경로>).
// 출처: stablyai/orca @ec112c6b01 (MIT) src/main/browser/doc-preview-grant-registry.ts(허가 = 문서 폴더, 옆 폴더는 안 읽음)·
// src/main/media/media-preview-protocol.ts(작업 단위 파일 연결로 읽기 — 로컬 디스크·원격 SFTP)·docs editing/viewers.mdx(외부 링크는 확인 후, 내려받기 없음).
// 보안 규칙(Orca 규칙을 아라 틀로):
//  · 스크립트 격리 — 렌더러가 iframe 을 sandbox="allow-scripts"(allow-same-origin 없음 = 불투명 출처)로 띄운다: 앱 창·저장소·IPC 에 못 닿고,
//    팝업·폼 전송·최상위 이동·내려받기가 막힌다.
//  · 원격 리소스 기본 차단 — 응답 CSP 가 ara-doc: · data: · blob: 만 허용(http/https 없음). 탭에서 [원격 리소스 허용]을 켠 허가만 http(s) 를 더한다.
//  · 읽기 범위 — 허가 = 그 문서의 폴더 아래만(Orca: requestBase 를 빼고 문서 폴더만 — 옆 폴더의 비밀을 지킨다). 폴더를 더 넓히는 "묻고 허가"는 뺐다.
//  · 링크 — 미리 보기 프레임이 ara-doc: 밖으로 가려 하면 막고, http(s) 면 렌더러에 물어 바깥 브라우저로(code:docLink).
import { app, protocol, webContents, type WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { isInsidePath } from '@shared/codeFiles'
import { pushSend } from '../util/windowPush'
import { workBackend } from '../work/backend'

export const DOC_SCHEME = 'ara-doc'
/** 미리 보기 한 파일 상한(문서·그림·글꼴). */
const DOC_FILE_MAX_BYTES = 50 * 1024 * 1024
/** 허가는 탭을 열 때마다 새로 — 오래된 것부터 버린다. ponytail: 탭 닫기에 맞춘 회수 대신 개수 상한. */
const GRANT_CAP = 64

// ⚠️ app ready 앞이어야 한다 — 이 모듈은 main/index.ts 의 최상단 import(code/feature)로 먼저 평가된다.
protocol.registerSchemesAsPrivileged([{ scheme: DOC_SCHEME, privileges: { standard: true, secure: true } }])

type Grant = { dir: string; host?: string; remote: boolean }
const grants = new Map<string, Grant>()

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav'
}
export const docMimeOf = (p: string): string => MIME[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** 응답 CSP — 원격(http/https)은 허가가 켠 경우만. connect·form·frame 은 원격을 켜도 ara-doc 안만. */
export function docPreviewCsp(remote: boolean): string {
  const net = remote ? ' https: http:' : ''
  const own = `${DOC_SCHEME}: data: blob:${net}`
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${own}`,
    `style-src 'unsafe-inline' ${own}`,
    `img-src ${own}`,
    `font-src ${own}`,
    `media-src ${own}`,
    `connect-src ${DOC_SCHEME}:${net}`,
    `frame-src ${DOC_SCHEME}:`,
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ')
}

/** 허가 하나 — 문서 폴더(dir) 아래만 읽는다. url = 문서 자신. */
export function mintDocGrant(path: string, host: string | undefined, remote: boolean): string {
  const flavor = workBackend(host).platform === 'win32' ? win32 : posix
  const id = randomBytes(16).toString('hex')
  grants.set(id, { dir: flavor.dirname(path), host, remote })
  while (grants.size > GRANT_CAP) grants.delete(grants.keys().next().value as string)
  return `${DOC_SCHEME}://${id}/${encodeURIComponent(flavor.basename(path))}`
}

/** ara-doc URL → 읽을 절대 경로(허가 폴더 밖·없는 허가면 null). 시험이 부른다. */
export function docPathOf(url: string): { path: string; grant: Grant } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const g = grants.get(u.hostname)
  if (!g || u.protocol !== `${DOC_SCHEME}:`) return null
  const platform = workBackend(g.host).platform
  const flavor = platform === 'win32' ? win32 : posix
  let rel: string
  try {
    rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
  const path = flavor.join(g.dir, ...rel.split('/'))
  return rel && isInsidePath(g.dir, path, platform) ? { path, grant: g } : null
}

export function registerDocPreview(): void {
  protocol.handle(DOC_SCHEME, async (req) => {
    const hit = docPathOf(req.url)
    if (!hit) return new Response('Not found', { status: 404 })
    const r = await workBackend(hit.grant.host).fs.readBytes(hit.path, DOC_FILE_MAX_BYTES)
    if (!r.ok) return new Response(r.tooBig ? 'Too large' : 'Not found', { status: r.tooBig ? 413 : 404 })
    return new Response(r.data as BodyInit, {
      headers: { 'content-type': docMimeOf(hit.path), 'content-security-policy': docPreviewCsp(hit.grant.remote), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
    })
  })
  // 미리 보기 프레임이 ara-doc: 밖으로 가려 하면(링크·meta refresh·location) 막는다. http(s) 면 렌더러가 묻고 바깥 브라우저로 연다.
  const guard = (wc: WebContents): void => {
    wc.on('will-frame-navigate', (e) => {
      if (e.isMainFrame) return
      const from = e.frame?.url ?? ''
      if (!from.startsWith(`${DOC_SCHEME}:`) || e.url.startsWith(`${DOC_SCHEME}:`)) return
      e.preventDefault()
      if (/^https?:\/\//i.test(e.url)) pushSend(wc, 'code:docLink', { url: e.url, grant: new URL(from).hostname })
    })
  }
  // 이미 떠 있는 창(이 등록보다 먼저 만들어진 본창)과 앞으로 생길 창 모두.
  for (const wc of webContents.getAllWebContents()) guard(wc)
  app.on('web-contents-created', (_e, wc) => guard(wc))
}
