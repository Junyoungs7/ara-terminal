/**
 * 오류 신고 서버 `ara-reports` (#206) — 계약은 docs/bug-report-api.md 하나다.
 *
 * 🔴 의존성 0(node:http · node:fs · node:crypto 뿐) — 서버에서 `npm install` 을 하지 않는다.
 * 저장: ARA_REPORTS_DIR(기본 /data/reports)/<id>/report.json + 첨부 파일. 기동할 때 전부 읽어
 * 메모리에 두고, 바꿀 때마다 디스크에 먼저 쓴다(임시 파일 → rename).
 *
 * 🔴 기기 ID 는 사실상 열쇠다 — report.json 에만 있고, 어떤 응답에도 로그에도 나가지 않는다.
 *    공개 모양은 publicList · publicDetail 두 곳에서만 만든다(거기에 deviceId 를 적지 않는다).
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PORT = Number(process.env.ARA_REPORTS_PORT ?? 8897)
const DIR = process.env.ARA_REPORTS_DIR || '/data/reports'
const ADMIN_PW = process.env.ARA_REPORTS_ADMIN_PW || ''
const ORIGINS = new Set(['http://192.168.100.56:8899', process.env.ARA_REPORTS_ORIGIN].filter(Boolean))

const BODY_MAX = 12 * 1024 * 1024
const STATUSES = ['open', 'investigating', 'fixed', 'closed', 'wontrepro', 'intended', 'duplicate']
// 첨부 이름은 여기서만 나온다 — 파일명이 곧 디스크 경로라 허용 목록 밖은 받지 않는다(경로 조작 차단).
// mime 도 이름에 묶는다: 요청의 mime 을 믿으면 text/html 로 저장해 이 출처에서 스크립트를 띄울 수 있다.
const ATTACH = {
  'capture.png': 'image/png',
  'main-error.log': 'text/plain',
  'renderer-errors.json': 'application/json',
  'settings.json': 'application/json'
}
const ID_RE = /^r-\d{8}-\d{4,}$/
const RATE_MAX = 5
const RATE_WINDOW = 60_000

if (!ADMIN_PW) console.warn('ARA_REPORTS_ADMIN_PW 가 비어 있습니다 — 관리 기능(상태 변경·관리자 코멘트·첨부 열람)이 잠깁니다.')

/** id → 저장된 신고 전체(deviceId 포함 — 밖으로 내보낼 땐 반드시 public* 를 거친다). */
const reports = new Map()
fs.mkdirSync(DIR, { recursive: true })
for (const id of fs.readdirSync(DIR)) {
  if (!ID_RE.test(id)) continue // 쓰다 만 임시 폴더(.tmp-…)는 건너뛴다
  try {
    reports.set(id, JSON.parse(fs.readFileSync(path.join(DIR, id, 'report.json'), 'utf8')))
  } catch (e) {
    console.error(`신고 ${id} 를 읽지 못했습니다: ${e.message}`)
  }
}
// 번호는 기존 신고를 세어 이어 간다(지운 게 있어도 겹치지 않게 최댓값 기준).
let lastNumber = Math.max(0, ...[...reports.values()].map((r) => r.number))

/** deviceId → 최근 1분 안의 신고 시각들. 재시작하면 풀린다 — 그래도 된다. */
const recent = new Map()

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

const saveReport = (r) => writeAtomic(path.join(DIR, r.id, 'report.json'), JSON.stringify(r, null, 2))

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function isAdmin(req) {
  if (!ADMIN_PW) return false // 🔴 빈 비밀번호로 열리는 문은 없다
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  return !!m && safeEqual(m[1], ADMIN_PW)
}

const isReporter = (req, r) => {
  const d = req.headers['x-ara-device']
  return typeof d === 'string' && d !== '' && safeEqual(d, r.deviceId)
}

const publicList = (r) => ({
  id: r.id,
  number: r.number,
  title: r.title,
  status: r.status,
  version: r.env?.version ?? null,
  name: r.name,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  comments: r.comments.length,
  fixedIn: r.fixedIn
})

const publicDetail = (r) => ({
  id: r.id,
  number: r.number,
  title: r.title,
  what: r.what,
  happened: r.happened,
  expected: r.expected,
  name: r.name,
  env: r.env,
  status: r.status,
  fixedIn: r.fixedIn,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  comments: r.comments,
  attachments: r.attachments.map(({ name, mime, size }) => ({ name, mime, size }))
})

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function readJson(req, max) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) return reject(new HttpError(413, '보낸 내용이 너무 큽니다(12MB 상한).'))
    const chunks = []
    let size = 0
    // 넘치면 답은 바로 하고 나머지는 흘려보낸다(소켓을 끊으면 413 이 상대에게 닿지 않는다).
    req.on('data', (c) => {
      size += c.length
      if (size > max) reject(new HttpError(413, '보낸 내용이 너무 큽니다(12MB 상한).'))
      else chunks.push(c)
    })
    req.on('end', () => {
      if (size > max) return
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error()
        resolve(v)
      } catch {
        reject(new HttpError(400, '요청 본문이 올바른 JSON 객체가 아닙니다.'))
      }
    })
    req.on('error', reject)
  })
}

/** 문자열 필드 검사. 없으면 '' — required 면 1자 이상. */
function text(v, label, max, required = false) {
  if (v === undefined || v === null) v = ''
  if (typeof v !== 'string') throw new HttpError(400, `${label}은(는) 문자열이어야 합니다.`)
  if (required && v.trim() === '') throw new HttpError(400, `${label}을(를) 입력해 주세요.`)
  if (v.length > max) throw new HttpError(400, `${label}은(는) ${max}자를 넘을 수 없습니다.`)
  return v
}

/** env 는 공개 필드라 아는 칸만 옮긴다(아무거나 받아 목록에 띄우지 않는다). */
function cleanEnv(env) {
  if (env === undefined || env === null) return {}
  if (typeof env !== 'object' || Array.isArray(env)) throw new HttpError(400, 'env 는 객체여야 합니다.')
  const out = {}
  for (const k of ['version', 'os', 'electron', 'gpu']) if (env[k] !== undefined) out[k] = text(env[k], `env.${k}`, 300)
  if (env.sessions !== undefined) {
    if (!env.sessions || typeof env.sessions !== 'object' || Array.isArray(env.sessions))
      throw new HttpError(400, 'env.sessions 는 객체여야 합니다.')
    out.sessions = {}
    for (const [k, n] of Object.entries(env.sessions).slice(0, 20)) {
      if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'env.sessions 의 값은 0 이상의 정수여야 합니다.')
      out.sessions[text(k, 'env.sessions 의 이름', 30)] = n
    }
  }
  return out
}

function decodeAttachments(list) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new HttpError(400, 'attachments 는 배열이어야 합니다.')
  const seen = new Set()
  return list.map((a) => {
    const name = a?.name
    if (typeof name !== 'string' || !Object.hasOwn(ATTACH, name)) throw new HttpError(400, '받을 수 없는 첨부 이름입니다.')
    if (seen.has(name)) throw new HttpError(400, `첨부 ${name} 이(가) 두 번 들어 있습니다.`)
    seen.add(name)
    if (a.mime !== ATTACH[name]) throw new HttpError(400, `첨부 ${name} 의 형식은 ${ATTACH[name]} 이어야 합니다.`)
    if (typeof a.base64 !== 'string') throw new HttpError(400, `첨부 ${name} 의 내용이 없습니다.`)
    const bytes = Buffer.from(a.base64, 'base64')
    // Buffer.from 은 틀린 글자를 조용히 버린다 — 되돌려 인코딩해 같아야 온전한 base64 다.
    if (bytes.toString('base64') !== a.base64) throw new HttpError(400, `첨부 ${name} 의 base64 를 읽을 수 없습니다.`)
    return { name, mime: ATTACH[name], bytes }
  })
}

function rateLimited(deviceId, now) {
  const times = (recent.get(deviceId) ?? []).filter((t) => now - t < RATE_WINDOW)
  recent.set(deviceId, times)
  return times.length >= RATE_MAX
}

async function createReport(req, res) {
  const b = await readJson(req, BODY_MAX)
  const deviceId = text(b.deviceId, '기기 ID', 200, true)
  const now = Date.now()
  if (rateLimited(deviceId, now)) throw new HttpError(429, '신고가 너무 잦습니다. 1분 뒤에 다시 보내 주세요.')

  const fields = {
    title: text(b.title, '제목', 200, true),
    what: text(b.what, '무엇을 했나', 5000),
    happened: text(b.happened, '무엇이 일어났나', 5000, true),
    expected: text(b.expected, '기대한 것', 5000),
    name: text(b.name, '이름', 50),
    env: cleanEnv(b.env)
  }
  const files = decodeAttachments(b.attachments)

  const number = ++lastNumber
  const id = `r-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${String(number).padStart(4, '0')}`
  const hashes = {}
  const attachments = files.map(({ name, mime, bytes }) => {
    hashes[name] = crypto.createHash('sha256').update(bytes).digest('hex')
    return { name, mime, size: bytes.length, sha256: hashes[name] }
  })
  const r = { id, number, ...fields, deviceId, status: 'open', fixedIn: null, createdAt: now, updatedAt: now, comments: [], attachments }

  // 폴더째 임시 이름으로 다 쓴 뒤 rename — 쓰다 죽어도 반쪽 신고가 목록에 뜨지 않는다.
  const tmp = path.join(DIR, `.tmp-${id}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp)
  for (const f of files) fs.writeFileSync(path.join(tmp, f.name), f.bytes)
  fs.writeFileSync(path.join(tmp, 'report.json'), JSON.stringify(r, null, 2))
  fs.renameSync(tmp, path.join(DIR, id))

  reports.set(id, r)
  recent.get(deviceId).push(now)
  send(res, 201, { id, number, hashes })
}

function listReports(res, url) {
  const status = url.searchParams.get('status')
  if (status !== null && !STATUSES.includes(status)) throw new HttpError(400, '알 수 없는 상태입니다.')
  const list = [...reports.values()]
    .filter((r) => status === null || r.status === status)
    .sort((a, b) => b.number - a.number)
    .map(publicList)
  send(res, 200, list)
}

function getFile(req, res, r, name) {
  if (!isAdmin(req) && !isReporter(req, r)) throw new HttpError(403, '이 첨부를 볼 권한이 없습니다.')
  const a = r.attachments.find((x) => x.name === name) // 저장된 이름은 모두 허용 목록에서 왔다
  if (!a) throw new HttpError(404, '그런 첨부가 없습니다.')
  const bytes = fs.readFileSync(path.join(DIR, r.id, a.name))
  res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff' })
  res.end(bytes)
}

async function addComment(req, res, r) {
  // 작성자는 서버가 정한다 — 요청의 author 는 읽지도 않는다.
  const author = isAdmin(req) ? 'admin' : isReporter(req, r) ? 'reporter' : null
  if (!author) throw new HttpError(403, '이 신고에 코멘트를 달 권한이 없습니다.')
  const b = await readJson(req, 64 * 1024)
  const comment = { at: Date.now(), author, body: text(b.body, '코멘트', 5000, true) }
  const next = { ...r, comments: [...r.comments, comment], updatedAt: comment.at }
  saveReport(next) // 디스크가 먼저 — 실패하면 메모리도 그대로
  reports.set(r.id, next)
  send(res, 201, { comment })
}

async function patchReport(req, res, r) {
  if (!isAdmin(req)) throw new HttpError(403, '관리자만 바꿀 수 있습니다.')
  const b = await readJson(req, 64 * 1024)
  const next = { ...r, updatedAt: Date.now() }
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw new HttpError(400, '알 수 없는 상태입니다.')
    next.status = b.status
  }
  if (b.fixedIn !== undefined) {
    if (b.fixedIn !== null && !(typeof b.fixedIn === 'string' && /^\d+\.\d+\.\d+$/.test(b.fixedIn)))
      throw new HttpError(400, '고친 판은 1.0.13 같은 모양이어야 합니다.')
    next.fixedIn = b.fixedIn
  }
  saveReport(next)
  reports.set(r.id, next)
  send(res, 200, { report: publicDetail(next) })
}

function send(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) })
  res.end(json)
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x')
  const parts = url.pathname.split('/').filter(Boolean) // ['api','reports',id?,sub?,name?]
  if (parts[0] !== 'api' || parts[1] !== 'reports' || parts.length > 5) throw new HttpError(404, '없는 주소입니다.')

  if (parts.length === 2) {
    if (req.method === 'POST') return createReport(req, res)
    if (req.method === 'GET') return listReports(res, url)
    throw new HttpError(405, '허용되지 않는 요청입니다.')
  }

  // id 는 메모리 Map 에서만 찾는다 — 경로에 그대로 쓰지 않는다.
  const r = ID_RE.test(parts[2]) ? reports.get(parts[2]) : undefined
  if (!r) throw new HttpError(404, '그런 신고가 없습니다.')

  if (parts.length === 3) {
    if (req.method === 'GET') return send(res, 200, publicDetail(r))
    if (req.method === 'PATCH') return patchReport(req, res, r)
  } else if (parts.length === 4 && parts[3] === 'comments' && req.method === 'POST') {
    return addComment(req, res, r)
  } else if (parts.length === 5 && parts[3] === 'files' && req.method === 'GET') {
    return getFile(req, res, r, parts[4])
  }
  throw new HttpError(405, '허용되지 않는 요청입니다.')
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-ARA-Device',
      'Access-Control-Max-Age': '600'
    })
    return res.end()
  }
  try {
    await route(req, res)
  } catch (e) {
    if (res.headersSent) return res.destroy()
    if (e instanceof HttpError) return send(res, e.status, { error: e.message })
    // 🔴 요청 내용·헤더는 찍지 않는다(기기 ID·비밀번호가 거기 있다) — 주소와 오류만.
    console.error(`500 ${req.method} ${req.url?.split('?')[0]}: ${e?.message}`)
    send(res, 500, { error: '서버 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.' })
  }
})

server.listen(PORT, () => console.log(`ara-reports listening on ${server.address().port} (신고 ${reports.size}건)`))
