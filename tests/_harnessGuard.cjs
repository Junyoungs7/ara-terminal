// Electron 하네스 공통 안전망. 모든 `tests/*.cjs` 하네스가 맨 위에서 한 번 require 한다.
//
// 왜 있나 (2026-08-11 실측):
//  ① 리스너가 없으면 Electron 기본 동작이 살아나 **모달** 에러 창("A JavaScript error occurred in
//     the main process")을 띄운다. 그 모달이 프로세스를 붙잡아 `app.exit()` 조차 통과하지 못한다 —
//     스모크가 266개 전부 PASS 하고도 종료하지 못하던 정체가 이것이었다. CI 도 사람도 거기서 멈춘다.
//     **하네스는 어떤 경우에도 사람의 클릭을 기다리면 안 된다.**
//  ② 그 창의 내용은 `TypeError: Object has been destroyed` 였고, 발생 지점은 아래 safeWc 가 고치는
//     그 접근자였다. 파괴된 BrowserWindow 는 `.webContents` **게터 접근 자체가** 던진다 —
//     `win` 의 null 검사와 `win.webContents.isDestroyed()` 만으로는 못 막는다(커밋 c014eea 가
//     `src/main/index.ts` 에서 고친 패턴인데 하네스 35개에 옛 모양이 복사돼 있었다).
//
// 삼키지 않는다: 스택을 stderr 에 찍고 즉시 비정상 종료한다 — 창 대신 빨간 로그로.
// 테스트가 예외를 조용히 넘기면 안 된다.
let app = null
try {
  ;({ app } = require('electron'))
} catch {
  /* node 로 실행된 부모 프로세스 — electron 모듈이 아니라 실행 파일 경로가 온다 */
}

for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`HARNESS ${ev}:\n${stack}\n`)
    if (app && typeof app.exit === 'function') app.exit(1)
    else process.exit(1)
  })
}

// 창을 향한 안전한 webContents 접근자. `getWin` 은 현재 창을 돌려주는 함수(창은 재생성될 수 있다).
// 앱의 `src/main/index.ts:101` 과 같은 가드 — 파괴 중 레이스에서는 게터 접근도 던지므로 try 로 감싼다.
function safeWc(getWin) {
  return () => {
    try {
      const win = getWin()
      return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : null
    } catch {
      return null
    }
  }
}

module.exports = { safeWc }
