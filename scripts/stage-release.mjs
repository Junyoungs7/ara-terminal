/**
 * 배포 사이트에 이번 판(release)을 올려놓는다 — `npm run site:stage`.
 *
 * `dist/` 에 만들어진 설치본을 `site/downloads/` 로 옮기고, 페이지가 읽는
 * `site/assets/release.js`(버전·용량·날짜·파일명)를 다시 쓴다. 다운로드 페이지와 자동 업데이트
 * 채널이 **같은 폴더**를 보므로(electron-builder.yml 의 publish.url) 이 한 번으로 둘 다 갱신된다.
 *
 * 옮기는 것 셋:
 *   · `A.R.A Setup <버전>.exe`  — 사람이 받는 설치본
 *   · `…exe.blockmap`           — 업데이트가 **바뀐 조각만** 받게 해 주는 색인(없으면 통째로 받는다)
 *   · `latest.yml`              — electron-updater 가 "새 버전이 있나"를 판단하는 파일
 *
 * latest.yml 은 electron-builder 가 남기면 그것을 쓰고, 없으면 **여기서 만든다**(아래 주석 참고).
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const dist = join(root, 'dist')
const out = join(root, 'site', 'downloads')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const exe = `${pkg.productName} Setup ${version}.exe`

const need = [exe, `${exe}.blockmap`]
const missing = need.filter((f) => !existsSync(join(dist, f)))
if (missing.length) {
  console.error(`dist/ 에 없는 파일: ${missing.join(', ')}`)
  console.error('먼저 `npm run dist:win` 을 돌리세요.')
  process.exit(1)
}

mkdirSync(out, { recursive: true })
for (const f of need) copyFileSync(join(dist, f), join(out, f))

/**
 * latest.yml — 없으면 **여기서 만든다.**
 *
 * 원래는 electron-builder 가 써 준다. 그런데 이 PC 에서는 마지막 정리 단계(중간 산출물
 * `*.nsis.7z` 삭제)가 `EBUSY` 로 죽는다 — 방금 쓴 95MB 파일을 백신·DLP 가 잡고 있는 동안 지우려다
 * 나는 것으로, 설치본과 blockmap 은 **그 전에 이미 다 만들어진다.** 그 한 줄 때문에 배포 전체를
 * 멈추느니, electron-updater 가 실제로 읽는 값(버전·파일명·크기·sha512)을 직접 계산해 쓴다.
 * 형식은 electron-builder 의 generic provider 출력과 같다.
 */
const sha512 = (file) => createHash('sha512').update(readFileSync(file)).digest('base64')
if (existsSync(join(dist, 'latest.yml'))) {
  copyFileSync(join(dist, 'latest.yml'), join(out, 'latest.yml'))
} else {
  const target = join(out, exe)
  const hash = sha512(target)
  writeFileSync(
    join(out, 'latest.yml'),
    [
      `version: ${version}`,
      'files:',
      `  - url: ${exe}`,
      `    sha512: ${hash}`,
      `    size: ${statSync(target).size}`,
      `path: ${exe}`,
      `sha512: ${hash}`,
      `releaseDate: '${new Date().toISOString()}'`,
      ''
    ].join('\n'),
    'utf8'
  )
  console.log('latest.yml 을 직접 만들었습니다(electron-builder 가 남기지 않았습니다).')
}

const bytes = statSync(join(out, exe)).size
const size = `${(bytes / 1024 / 1024).toFixed(1)} MB`
const date = new Date().toISOString().slice(0, 10)

writeFileSync(
  join(root, 'site', 'assets', 'release.js'),
  `/**
 * 배포 정보 — **\`npm run site:stage\` 가 다시 쓴다.** 손으로 고치지 말 것.
 * (scripts/stage-release.mjs 가 dist/ 의 실제 설치본을 보고 값을 채운다)
 *
 * 페이지는 이 값으로 버전·용량·날짜·내려받을 파일 이름을 채운다. fetch 가 아니라 스크립트인
 * 이유: 파일을 직접 열어 봐도(file://) 그대로 보여야 하기 때문이다.
 */
window.ARA_RELEASE = {
  version: '${version}',
  date: '${date}',
  file: '${exe}',
  size: '${size}',
  os: 'Windows 10 / 11 (64비트)'
}
`,
  'utf8'
)

console.log(`site/downloads/ 준비 완료 — ${exe} (${size})`)
console.log('사내 웹 서버의 배포 폴더에 site/ 를 통째로 올리면 다운로드와 자동 업데이트가 함께 갱신됩니다.')
