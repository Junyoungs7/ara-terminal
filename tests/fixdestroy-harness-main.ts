// FIX-destroyed 실기동 하네스가 require 할 실(real) main 모듈 재노출.
// registerAiIpc 가 이번 조사에서 찾은 유일한 미가드 push 콜사이트였다(W3 AI 스트리밍) — 그 실제
// 코드 + 새 단일 가드(windowPush.ts)를 진짜 Electron 프로세스에서 돌려 회귀를 고정한다.
export { registerAiIpc } from '../src/main/ipc/registerAiIpc'
export { pushSend, pushMessage } from '../src/main/util/windowPush'
