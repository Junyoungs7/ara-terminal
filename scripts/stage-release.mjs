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
 *
 * 🔴 **2.0 이상은 `site/downloads/v2/` 로 간다**(2026-10-29 준영님 결정 — electron-builder.yml publish.url).
 * 루트 `site/downloads/` 의 1.x 설치본·latest.yml 은 **건드리지 않는다** — 1.x 자동 업데이트 피드라 거기에
 * 2.0 latest.yml 이 놓이면 1.x 전원이 2.0 으로 밀린다. release.js 의 1.x 값(ARA_RELEASE_V1)도 그대로 옮겨 적는다.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const dist = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
// 사이트 기준 폴더(release.js 의 dir · 링크 앞부분). 2.0 이상은 v2 — 1.x 피드와 갈라 둔다.
const dlDir = Number(version.split('.')[0]) >= 2 ? 'downloads/v2/' : 'downloads/'
const out = join(root, 'site', ...dlDir.split('/').filter(Boolean))
const exe = `${pkg.productName} Setup ${version}.exe`

/**
 * changelog.html 이 이번 버전을 담고 있는지 — 경고만 하고 막지는 않는다.
 *
 * 손으로 갱신하는 문서는 낡는다(이 사이트가 실제로 90 커밋만큼 낡아 있던 적이 있다). 그래도
 * 여기서 process.exit 는 안 쓴다: 이 스크립트의 본업은 설치본을 서버가 읽을 폴더로 옮기고
 * sha512 가 맞는 latest.yml 을 쓰는 것이고(위 EBUSY 주석과 같은 결 — 급하면 실제 배포부터
 * 나가야 한다), changelog 문구는 그 배포를 막을 이유가 못 된다. 지금은 경고 자체가 우회로라
 * 따로 --skip 플래그를 안 둔다 — 만들면 그 플래그를 잊는 사람이 이 장치를 무의미하게 만든다.
 */
const changelogPath = join(root, 'site', 'changelog.html')
const changelogText = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : ''
if (!changelogText.includes(version)) {
  console.warn(`⚠️  site/changelog.html 에 버전 ${version} 이 없습니다 — 패치 내역을 적었는지 확인하세요.`)
}

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
 * latest.yml — electron-builder 것을 쓰되 **이 설치본을 가리킬 때만** 쓴다. 아니면 여기서 만든다.
 *
 * 원래는 electron-builder 가 써 준다. 그런데 이 PC 에서는 마지막 정리 단계(중간 산출물
 * `*.nsis.7z` 삭제)가 `EBUSY` 로 죽는다 — 방금 쓴 95MB 파일을 백신·DLP 가 잡고 있는 동안 지우려다
 * 나는 것으로, 설치본과 blockmap 은 **그 전에 이미 다 만들어진다.** 그 한 줄 때문에 배포 전체를
 * 멈추느니, electron-updater 가 실제로 읽는 값(버전·파일명·크기·sha512)을 직접 계산해 쓴다.
 * 형식은 electron-builder 의 generic provider 출력과 같다.
 *
 * 🔴 **존재만 보고 믿으면 안 된다**(2026-09-05 실제로 당했다). EBUSY 로 죽으면 latest.yml 도 다시
 * 안 써지는데, `dist/` 에는 **지난 빌드 것이 그대로 남아 있다.** 그날 잰 값: 설치본은 09-05 16:29
 * 99,728,447 바이트인데 latest.yml 은 09-04 17:01 의 99,724,136 바이트와 **다른 sha512** 를 광고하고
 * 있었다. 그대로 올렸다면 모두의 자동 업데이트가 **95MB 를 다 받은 뒤** 체크섬에서 실패한다 —
 * 앱은 "업데이트 실패"만 말하고 왜인지는 아무 데도 안 나온다.
 *
 * 그래서 셋(버전·크기·sha512)이 실제 파일과 맞을 때만 쓴다. 하나라도 어긋나면 낡은 것이므로 버린다.
 * ⚠️ 이 확인을 "파일이 있나"로 되돌리지 마라. 조용히 틀리는 쪽이라 배포 뒤에야 드러난다.
 */
const sha512 = (file) => createHash('sha512').update(readFileSync(file)).digest('base64')
const target = join(out, exe)
const hash = sha512(target)
// 아래쪽 사람이 읽는 크기(`size` = "95.1 MB")와 이름이 겹치지 않게 — 여기는 바이트 그대로다.
const exeBytes = statSync(target).size

const builderYml = join(dist, 'latest.yml')
const builderText = existsSync(builderYml) ? readFileSync(builderYml, 'utf8') : ''
const builderFresh =
  builderText.includes(`version: ${version}`) && builderText.includes(hash) && builderText.includes(`size: ${exeBytes}`)

if (builderFresh) {
  copyFileSync(builderYml, join(out, 'latest.yml'))
} else {
  writeFileSync(
    join(out, 'latest.yml'),
    [
      `version: ${version}`,
      'files:',
      `  - url: ${exe}`,
      `    sha512: ${hash}`,
      `    size: ${exeBytes}`,
      `path: ${exe}`,
      `sha512: ${hash}`,
      `releaseDate: '${new Date().toISOString()}'`,
      ''
    ].join('\n'),
    'utf8'
  )
  console.log(
    builderText
      ? 'latest.yml 을 직접 만들었습니다(dist 의 것이 이 설치본과 안 맞습니다 — 지난 빌드 것).'
      : 'latest.yml 을 직접 만들었습니다(electron-builder 가 남기지 않았습니다).'
  )
}

const bytes = statSync(join(out, exe)).size
const size = `${(bytes / 1024 / 1024).toFixed(1)} MB`
const date = new Date().toISOString().slice(0, 10)

// 1.x 값은 지난 release.js 에서 그대로 옮긴다 — 2.0 을 올려도 "이전 버전" 칸이 살아 있어야 한다.
const releaseJs = join(root, 'site', 'assets', 'release.js')
const v1Block = (existsSync(releaseJs) ? readFileSync(releaseJs, 'utf8') : '').match(/window\.ARA_RELEASE_V1 = \{[^}]*\}/)?.[0]
if (!v1Block) console.warn('⚠️  release.js 에 ARA_RELEASE_V1(1.x) 이 없습니다 — 사이트의 "이전 버전" 칸이 빈다.')

writeFileSync(
  releaseJs,
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
  os: 'Windows 10 / 11 (64비트)',
  dir: '${dlDir}'
}
${v1Block ? `\n// 이전 버전(1.x) — 2.0 을 스테이징해도 지난 값을 그대로 옮긴다.\n${v1Block}\n` : ''}`,
  'utf8'
)

console.log(`site/${dlDir} 준비 완료 — ${exe} (${size})`)
console.log('사내 웹 서버의 배포 폴더에 site/ 를 통째로 올리면 다운로드와 자동 업데이트가 함께 갱신됩니다.')
