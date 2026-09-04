/**
 * 자동 업데이트 채널을 **사내 서버를 건드리지 않고** 시험하는 로컬 피드 — `npm run feed`.
 *
 * 왜 있나(2026-09-04): 업데이트 채널이 1.0.0 까지 **한 번도 실제로 돌아 본 적이 없었다.**
 * 검증 안 된 고리가 셋이었다 — 공백이 든 파일명 · URL 인코딩 · Range(blockmap 차등 내려받기).
 * 그때까지 시험할 방법이 "진짜로 배포해 보기" 뿐이었고, 그래서 아무도 안 했다.
 * 이 파일이 그 핑계를 없앤다.
 *
 * 쓰는 법:
 *   node scripts/local-update-feed.mjs <폴더>      # 그 폴더를 /downloads/ 로 서빙
 *   ARA_UPDATE_URL=http://127.0.0.1:8788/downloads/ "<설치경로>\A.R.A.exe"
 *
 * **핵심은 요청 로그다.** electron-updater 가 실제로 무엇을 물어보는지 한 줄씩 찍는다 —
 * latest.yml 을 읽었는지, 파일명을 어떻게 인코딩해 왔는지, Range 를 쓰는지(= blockmap 경로가
 * 도는지), 몇 바이트를 받아 갔는지. 화면만 보면 "됐다/안 됐다" 뿐이지만 이 로그를 보면
 * **어느 고리에서 끊겼는지**가 나온다.
 *
 * 127.0.0.1 에만 바인딩한다 — 이건 시험 도구지 서버가 아니다.
 */
import { createReadStream, statSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const port = Number(process.env.ARA_FEED_PORT || 8788)

if (!existsSync(root)) {
  console.error(`폴더가 없습니다: ${root}`)
  process.exit(1)
}

const TYPES = {
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream'
}

let n = 0

const server = createServer((req, res) => {
  const id = ++n
  // `/downloads/A.R.A%20Setup%201.0.0.exe` → 공백 복원. 이 한 줄이 검증 안 된 고리 둘(공백·인코딩)이다.
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
  const rel = urlPath.replace(/^\/downloads\/?/, '')
  const range = req.headers.range ?? ''
  // **시각을 반드시 찍는다.** 2026-09-04 첫 시험에서 이게 없어 헤맸다 — 요청이 넷 들어왔는데
  // 어느 것이 어느 실행의 것인지 못 갈랐고, 앱이 우리 피드를 본다고 잘못 읽었다
  // (실은 바로가기로 뜬 다른 인스턴스가 사내 서버를 보고 있었다).
  const say = (status, extra = '') =>
    console.log(
      `${new Date().toTimeString().slice(0, 8)} [${String(id).padStart(3, '0')}] ${status} ${urlPath}` +
        `${range ? `  Range: ${range}` : ''}${extra}`
    )

  // 경로 탈출 방지 — 시험 도구라도 남의 디스크를 열어 주지 않는다.
  const file = join(root, normalize(rel))
  if (!file.startsWith(root + sep) && file !== root) {
    res.writeHead(403).end()
    return say(403, '  ← 경로 탈출')
  }
  if (!rel || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end()
    return say(404, '  ← 없는 파일')
  }

  const size = statSync(file).size
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes' }

  // Range — caddy 가 되기 때문에 고른 그 기능이다(python -m http.server 는 못 한다).
  // 여기서 206 이 안 나오면 배포본은 매번 설치본을 통째로 받는다.
  const m = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (m) {
    const start = m[1] === '' ? size - Number(m[2]) : Number(m[1])
    const end = m[1] === '' || m[2] === '' ? size - 1 : Number(m[2])
    if (!(start >= 0 && end < size && start <= end)) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
      return say(416, '  ← 범위 밖')
    }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    say(206, `  ${end - start + 1}B`)
    return void createReadStream(file, { start, end }).pipe(res)
  }

  res.writeHead(200, { ...head, 'Content-Length': size })
  say(200, `  ${size}B`)
  if (req.method === 'HEAD') return void res.end()
  createReadStream(file).pipe(res)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`로컬 업데이트 피드 — ${root}`)
  console.log(`  주소: http://127.0.0.1:${port}/downloads/`)
  console.log('')
  console.log('  앱을 이렇게 띄우세요:')
  console.log(`    $env:ARA_UPDATE_URL='http://127.0.0.1:${port}/downloads/'; & "<설치경로>\\A.R.A.exe"`)
  console.log('')
  console.log('  아래에 요청이 한 줄씩 찍힙니다. latest.yml → .blockmap → .exe 순서면 정상입니다.')
  console.log('  Ctrl+C 로 끕니다.')
})
