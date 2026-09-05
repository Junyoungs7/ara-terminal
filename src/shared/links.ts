// 사내 배포 사이트 — 다운로드 페이지·자동 업데이트 채널과 같은 호스트(electron-builder.yml 의
// publish.url 참고). 매뉴얼도 같은 캐디 컨테이너가 정적으로 서빙하므로 그 루트에 얹는다.
// 서버가 옮겨 가면 이 한 줄만 고치면 된다 — ARA_UPDATE_URL 처럼 환경변수로 덮을 필요는 없다(설명서
// 링크는 안 열려도 앱 동작에 영향이 없다, 자동 업데이트와 달리).
export const MANUAL_URL = 'http://192.168.100.56:8899/manual.html'
