/**
 * 배포 정보 — **`npm run site:stage` 가 다시 쓴다.** 손으로 고치지 말 것.
 * (scripts/stage-release.mjs 가 dist/ 의 실제 설치본을 보고 값을 채운다)
 *
 * 페이지는 이 값으로 버전·용량·날짜·내려받을 파일 이름을 채운다. fetch 가 아니라 스크립트인
 * 이유: 파일을 직접 열어 봐도(file://) 그대로 보여야 하기 때문이다.
 */
window.ARA_RELEASE = {
  version: '2.0.0',
  date: '2026-10-29',
  file: 'ARA Setup 2.0.0.exe',
  size: '94.3 MB',
  os: 'Windows 10 / 11 (64비트)',
  dir: 'downloads/v2/'
}

// 이전 버전(1.x) — 2.0 을 스테이징해도 지난 값을 그대로 옮긴다.
window.ARA_RELEASE_V1 = {
  version: '1.0.33',
  date: '2026-10-26',
  file: 'ARA Setup 1.0.33.exe',
  size: '94.3 MB',
  os: 'Windows 10 / 11 (64비트)',
  dir: 'downloads/'
}
