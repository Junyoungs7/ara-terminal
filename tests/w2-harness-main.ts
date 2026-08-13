// W2 스크린샷·E2E 하네스가 require 할 실(real) 모듈 번들 엔트리.
// main 배선 자체는 스텁하지 않는다 — 스크립트가 out/main/index.js(실 앱)를 그대로 부팅하고,
// 여기서는 원격 역할을 할 ssh2 서버만 빌려 간다.
export { startPasswordServer } from './ssh-harness'
