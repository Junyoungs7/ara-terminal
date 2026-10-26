/**
 * 오류 신고 서버(#206)를 사내 서버에 올리고 띄운다 — `npm run reports:deploy`.
 * 모양은 deploy-site.mjs 를 그대로 따른다(ssh2 · sftp 업로드 · docker run).
 *
 *   ARA_DEPLOY_PW='…' ARA_REPORTS_ADMIN_PW='…' npm run reports:deploy
 *
 * 비밀번호 둘 다 **환경변수로만** 받는다(인자는 ps 에 뜨고, 파일은 저장소에 남는다).
 * 🔴 ARA_REPORTS_ADMIN_PW 는 이 스크립트가 모른다 — 넘겨받은 값을 `docker run -e` 로 전달만 한다.
 *    없으면 경고만 하고 계속한다(서버는 뜨고 관리 기능만 잠긴다 — server.mjs 가 빈 비밀번호를 거절한다).
 *    값은 콘솔에 찍지 않는다.
 *
 * 🔴 `ara-site` 컨테이너는 건드리지 않는다 — 그쪽은 자동 업데이트 채널이다. 여기서 지우고 만드는 건
 *    `ara-reports` 하나뿐이다.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ssh2 from 'ssh2'

const { Client } = ssh2

const HOST = process.env.ARA_DEPLOY_HOST || '192.168.100.56'
const USER = process.env.ARA_DEPLOY_USER || 'jun'
const APP = '/data/jun/ARA-reports-app' // 서버 코드(읽기 전용 마운트)
const DATA = '/data/jun/ARA-reports' // 🔴 신고 저장소 — 지우지 않는다
const PORT = process.env.ARA_REPORTS_PORT || '8897'
const NAME = 'ara-reports' // 컨테이너 이름
// 🔴 버전을 박는다 — `node:22-alpine` 처럼 떠다니는 태그는 처음 받은 이미지가 서버에 남아 보안 패치를
//    놓친다(2026-10-26: v22.23.3 로 남아 10-20 보안 릴리스를 못 받음). 올릴 때 https://nodejs.org/dist/index.json
//    에서 security:true 인 최신 LTS 로 바꾼다.
const IMAGE = 'node:24.22.1-alpine'
const LOCAL = join(process.cwd(), 'server', 'reports', 'server.mjs')

if (!process.env.ARA_DEPLOY_PW) {
  console.error("비밀번호가 없습니다. ARA_DEPLOY_PW='…' 를 앞에 붙여 실행하세요(인자·파일 금지).")
  process.exit(1)
}
const ADMIN_PW = process.env.ARA_REPORTS_ADMIN_PW || ''
if (!ADMIN_PW) console.warn('⚠️ ARA_REPORTS_ADMIN_PW 가 없습니다 — 서버는 뜨지만 관리 기능(상태·관리자 코멘트·첨부 열람)이 잠깁니다.')

const conn = new Client()

/** input 이 있으면 원격 명령의 stdin 으로 흘린다(명령줄에 안 싣는다 — 원격 ps 에 뜨지 않게). */
const exec = (cmd, input) =>
  new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      if (input !== undefined) stream.end(input + '\n')
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
    readFileSync(LOCAL) // 없으면 여기서 멈춘다(원격을 건드리기 전에)
    await exec(`mkdir -p '${APP}' '${DATA}'`)
    const sftp = await sftpOf()
    await put(sftp, LOCAL, `${APP}/server.mjs`)
    sftp.end()
    console.log(`server.mjs → ${USER}@${HOST}:${APP}`)

    // 이미지를 먼저 받는다 — 지운 뒤에 받으면 받는 동안 신고 서버가 내려가 있다.
    const pull = await exec(`docker pull -q ${IMAGE}`)
    if (pull.code !== 0) throw new Error('이미지 받기 실패: ' + pull.out)

    // 컨테이너는 지우고 다시 만든다 — 그래도 신고는 남는다.
    // 🔴 ara-site 와 다른 점: ara-site 는 **무상태**(읽기 전용 마운트 하나)라 지워도 잃을 게 없지만,
    //    이 컨테이너는 쓰기를 받는다. 신고는 컨테이너 안이 아니라 호스트의 DATA 볼륨에 쓰이므로
    //    `docker rm -f` 가 지우는 건 프로세스뿐이다. DATA 를 지우거나 -v 를 빼면 신고가 전부 날아간다.
    await exec(`docker rm -f ${NAME} 2>/dev/null; true`)
    // 관리 비밀번호는 stdin → 원격 셸 변수 → `-e 이름`(값 없이) 으로 docker 가 제 환경에서 집어 간다.
    // 명령줄 어디에도 값이 없다. 비어 있으면 빈 값이 가고 server.mjs 가 관리 기능을 잠근다.
    const run = await exec(
      `IFS= read -r ARA_REPORTS_ADMIN_PW; export ARA_REPORTS_ADMIN_PW; ` +
        `docker run -d --name ${NAME} --restart unless-stopped -p ${PORT}:8897 ` +
        `-v ${APP}:/app:ro -v ${DATA}:/data/reports ` +
        `-e ARA_REPORTS_DIR=/data/reports -e ARA_REPORTS_PORT=8897 -e ARA_REPORTS_ADMIN_PW ` +
        `${IMAGE} node /app/server.mjs`,
      ADMIN_PW
    )
    if (run.code !== 0) throw new Error('컨테이너 기동 실패: ' + run.out)

    // 정말 뜨는지 서버 안에서 확인한다(방화벽 밖 문제와 서버 문제를 갈라 보기 위해).
    await new Promise((r) => setTimeout(r, 1500))
    const check = await exec(`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/api/reports`)
    console.log(`서버 안 확인(GET /api/reports): ${check.out}`)
    console.log(`\n배포 완료 → http://${HOST}:${PORT}/api/reports`)
  } catch (e) {
    console.error('배포 실패:', e.message)
    process.exitCode = 1
  } finally {
    conn.end()
  }
})

conn.on('error', (e) => {
  console.error('SSH 연결 실패:', e.message)
  process.exit(1)
})

conn.connect({ host: HOST, port: 22, username: USER, password: process.env.ARA_DEPLOY_PW, readyTimeout: 20000 })
