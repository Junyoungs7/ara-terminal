/**
 * 배포 사이트를 사내 서버에 올리고 띄운다 — `npm run site:deploy`.
 *
 * 준영님이 정한 자리(2026-08-23):
 *   서버 192.168.100.56 · 사용자 jun · 경로 /data/jun/ARA · 포트 8899
 *   → 다운로드 페이지 http://192.168.100.56:8899/
 *   → 자동 업데이트 채널 http://192.168.100.56:8899/downloads/v2/  (2.0 — electron-builder.yml 의 publish.url)
 *     1.x 채널 /downloads/latest.yml 은 1.0.33 그대로(2.0 을 1.x 자동 업데이트로 밀지 않는다).
 *   site/ 를 통째로(하위 폴더 포함) 올리고 지우지는 않는다 — 서버의 1.x 파일은 남는다.
 *
 * **비밀번호는 환경변수로만 받는다.** 인자로 받으면 프로세스 목록(ps)에 그대로 뜨고, 파일에 적으면
 * 저장소에 남는다. 둘 다 안 된다.
 *
 *   ARA_DEPLOY_PW='…' npm run site:deploy
 *
 * 웹 서버는 **caddy 공식 이미지(버전은 아래 IMAGE)**를 쓴다. 새로 설치할 것도, sudo 도,
 * 방화벽 손질도 필요 없다(도커가 게시한 포트는 이 호스트에서 이미 여럿 쓰이고 있다).
 * caddy 를 고른 이유: 정적 파일 서버인데 **Range 요청을 제대로 받는다** — electron-updater 가
 * 업데이트를 **바뀐 조각만** 받는 경로(blockmap)가 그 위에서 돈다. python -m http.server 는
 * Range 를 모르고, 그러면 매번 92MB 를 통째로 받는다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ssh2 from 'ssh2'

const { Client } = ssh2

const HOST = process.env.ARA_DEPLOY_HOST || '192.168.100.56'
const USER = process.env.ARA_DEPLOY_USER || 'jun'
const ROOT = process.env.ARA_DEPLOY_PATH || '/data/jun/ARA'
const PORT = process.env.ARA_DEPLOY_PORT || '8899'
const NAME = 'ara-site' // 컨테이너 이름
const LOCAL = join(process.cwd(), 'site')

if (!process.env.ARA_DEPLOY_PW) {
  console.error("비밀번호가 없습니다. ARA_DEPLOY_PW='…' 를 앞에 붙여 실행하세요(인자·파일 금지).")
  process.exit(1)
}

/** site/ 아래 올릴 파일 전부. 숨김 파일은 건너뛴다. */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const conn = new Client()

const exec = (cmd) =>
  new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      stream
        .on('close', (code) => resolve({ code, out: out.trim() }))
        .on('data', (d) => (out += d))
        .stderr.on('data', (d) => (out += d))
    })
  })

const sftpOf = () =>
  new Promise((resolve, reject) => conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))))

const put = (sftp, local, remote) =>
  new Promise((resolve, reject) => sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve())))

conn.on('ready', async () => {
  try {
    const files = walk(LOCAL)
    const total = files.reduce((n, f) => n + statSync(f).size, 0)
    console.log(`올릴 파일 ${files.length}개 · ${(total / 1024 / 1024).toFixed(1)} MB → ${USER}@${HOST}:${ROOT}`)

    // 폴더를 먼저 만든다(mkdir -p 를 원격 셸에 맡긴다 — sftp mkdir 은 중간 경로를 못 만든다).
    const dirs = [...new Set(files.map((f) => join(ROOT, relative(LOCAL, f)).replace(/\\/g, '/')))].map((p) =>
      p.slice(0, p.lastIndexOf('/'))
    )
    await exec(`mkdir -p ${[...new Set(dirs)].map((d) => `'${d}'`).join(' ')}`)

    const sftp = await sftpOf()
    let done = 0
    for (const f of files) {
      const rel = relative(LOCAL, f).replace(/\\/g, '/')
      await put(sftp, f, `${ROOT}/${rel}`)
      done += statSync(f).size
      console.log(`  ${rel}  (${((done / total) * 100).toFixed(0)}%)`)
    }
    sftp.end()

    // 🔴 버전을 박는다 — 떠다니는 `caddy:2-alpine` 은 처음 받은 이미지가 남아 보안 패치를 놓친다
    //    (2026-10-26, deploy-reports.mjs 와 같은 이유). 올릴 때 github.com/caddyserver/caddy/releases 최신으로.
    //    `caddy:2-alpine` 태그 자체는 서버의 다른 프로젝트(vgt-work)도 쓰므로 지우지 않는다.
    const IMAGE = 'caddy:2.11.7-alpine'
    // 이미지를 먼저 받는다 — 지운 뒤에 받으면 받는 동안 업데이트 채널이 내려가 있다.
    const pull = await exec(`docker pull -q ${IMAGE}`)
    if (pull.code !== 0) throw new Error('이미지 받기 실패: ' + pull.out)

    // 컨테이너는 매번 지우고 다시 만든다 — 상태가 없다(읽기 전용 마운트 하나가 전부).
    await exec(`docker rm -f ${NAME} 2>/dev/null; true`)
    const run = await exec(
      `docker run -d --name ${NAME} --restart unless-stopped -p ${PORT}:80 ` +
        // 이 이미지에는 ENTRYPOINT 가 없다(CMD 만 있다) — 실행할 명령을 통째로 준다.
        `-v ${ROOT}:/srv:ro ${IMAGE} caddy file-server --root /srv --listen :80`
    )
    if (run.code !== 0) throw new Error('컨테이너 기동 실패: ' + run.out)

    // 정말 뜨는지 서버 안에서 확인한다(방화벽 밖 문제와 서버 문제를 갈라 보기 위해).
    await new Promise((r) => setTimeout(r, 1500))
    const check = await exec(
      `curl -sS -o /dev/null -w '%{http_code} ' http://127.0.0.1:${PORT}/ ; ` +
        `curl -sS -o /dev/null -w '%{http_code} ' http://127.0.0.1:${PORT}/manual.html ; ` +
        `curl -sS -o /dev/null -w '%{http_code} ' http://127.0.0.1:${PORT}/downloads/latest.yml ; ` +
        `curl -sS -o /dev/null -w '%{http_code} ' http://127.0.0.1:${PORT}/downloads/v2/latest.yml ; ` +
        `curl -sS -r 0-99 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${PORT}/${releaseFile()}'`
    )
    console.log(`서버 안 확인(index · manual · 1.x latest.yml · v2 latest.yml · Range): ${check.out}`)
    console.log(`\n배포 완료 → http://${HOST}:${PORT}/`)
    console.log(`업데이트 채널 → http://${HOST}:${PORT}/downloads/v2/ (1.x: /downloads/)`)
  } catch (e) {
    console.error('배포 실패:', e.message)
    process.exitCode = 1
  } finally {
    conn.end()
  }
})

/** release.js 첫 블록(지금 판)이 가리키는 설치본 경로(사이트가 실제로 내려주는 파일, URL 인코딩). */
function releaseFile() {
  const js = readFileSync(join(LOCAL, 'assets', 'release.js'), 'utf8')
  const dir = js.match(/dir:\s*'([^']+)'/)?.[1] ?? 'downloads/'
  return dir + encodeURIComponent(js.match(/file:\s*'([^']+)'/)?.[1] ?? '')
}

conn.on('error', (e) => {
  console.error('SSH 연결 실패:', e.message)
  process.exit(1)
})

conn.connect({ host: HOST, port: 22, username: USER, password: process.env.ARA_DEPLOY_PW, readyTimeout: 20000 })
