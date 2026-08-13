// 종료 회귀 하네스가 require 할 실(real) main 모듈 — 세션 매니저와 종료 배수를 그대로 쓴다.
// 하네스가 자체 pty 스텁을 쓰면 정작 고친 코드를 검증하지 못한다(FIX-destroyed 하네스와 같은 이유).
export { MainSessionManager } from '../src/main/sessions/MainSessionManager'
export { drainKilledPtys } from '../src/main/sessions/PtyBackend'
