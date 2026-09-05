// 단일 인스턴스 (#176) — 아이콘을 두 번 눌러도 아라는 하나다.
//
// 왜 판정을 순수 함수로 떼는가: 이건 **막는 코드**다. 잘못 걸리면 두 번째 프로세스가 창도 메시지도
// 없이 그 자리에서 끝나므로 사용자에게는 **"앱이 안 켜진다"** 로만 보인다 — 무엇이 막았는지 화면에
// 나올 자리가 없다. 그 사고는 창 없이 회귀로 잡을 수 있어야 한다(@shared/sessionWin 의
// shouldAskBeforeQuit · visibleWindows.ts 의 anyWindowVisible 과 같은 관행).
// 검사: tests/singleInstance.test.ts

/**
 * 이 실행은 잠금을 **걸어야 하나**.
 *
 * 잠그는 것은 **설치본뿐이다.** 둘이 그 선을 강제한다:
 *
 *  · Electron 의 잠금은 **userData 단위**인데 dev(`electron-vite dev`)와 설치본은 그 자리가 같다
 *    (package.json 의 productName 이 둘 다 'A.R.A' → `%APPDATA%\A.R.A`). 잠그면 설치본을 켜 둔 채로는
 *    dev 가 안 뜨고 반대도 안 된다 — 개발 중엔 둘을 나란히 띄우는 게 일상이다.
 *  · e2e·스모크 하네스는 `out/main/index.js` 를 electron 으로 직접 띄우므로 **역시 packaged 가 아니다.**
 *    그리고 그것들은 앱을 여러 개 **동시에** 띄운다(index.ts 의 MCP 포트 0 주석) — 잠그면 스위트가
 *    통째로 죽는다. userData 를 임시 폴더로 갈라 두긴 했지만(tests/e2e/fixtures.ts 의 `--user-data-dir`)
 *    이 게이트가 그 가정에 매달리지 않게 한다.
 *
 * 정작 두 개가 뜨는 사고는 설치본에서 난다 — 바탕화면 아이콘·작업표시줄을 두 번 누르는 길이다.
 * AutoUpdate.ts 도 같은 이유로 `packaged` 에서 갈린다(개발 중엔 아예 돌지 않는다).
 *
 * `ARA_ALLOW_MULTI=1` — **탈출구를 둔다.** 잠금이 현장에서 어긋나면(사내 로밍 프로필·리다이렉트된
 * AppData 처럼 userData 가 우리 손 밖에 있는 자리) 증상이 "앱이 안 켜진다"인데, 그때 사용자가 스스로
 * 되돌릴 방법이 하나도 없다 — 지우려면 설치를 건드려야 한다. 환경변수 한 줄이면 전화로 켜 드릴 수
 * 있고, 그 값어치가 이 한 줄보다 크다. 값 비교는 ARA_E2E·ARA_AI_FAKE 와 같은 규칙이다('1' 만 본다).
 */
export function shouldLockSingleInstance(o: { packaged: boolean; allowMulti?: string | undefined }): boolean {
  return o.packaged && o.allowMulti !== '1'
}

/** 앞으로 가져올 창을 고를 때 보는 것 — 파괴 여부뿐이다(BrowserWindow 없이 검사하려고). */
export type RaisableWindow = { isDestroyed(): boolean }

/**
 * 두 번째 인스턴스가 왔을 때 **무엇을 앞으로 가져오나.**
 *
 * 본창이 먼저다. 없으면 아무 창이나 — **본창 없이 보조 창만 남은 상태가 실제로 가능하다**:
 * 세션이 없는 본창은 묻지 않고 닫히는데(index.ts 의 close → shouldAskBeforeQuit), 떼어낸 세션 창·
 * 다중 모니터 RDP 창·포트 모니터 창이 하나라도 남아 있으면 `window-all-closed` 가 오지 않아 앱은
 * 그대로 산다. 그 상태에서 아무것도 올리지 않으면 아이콘을 눌러도 **아무 일도 안 일어난다** —
 * 사용자에게는 그것도 "앱이 안 켜진다"다.
 *
 * 파괴 레이스면 그 창을 없는 것으로 친다(anyWindowVisible·araWindowAt 과 같은 관행) — 하필 본창이
 * 그 순간이면 건너뛰고 보조 창으로 떨어진다.
 */
export function windowToRaise<W extends RaisableWindow>(main: W | null, all: readonly W[]): W | null {
  const live = (w: W | null | undefined): boolean => {
    try {
      return !!w && !w.isDestroyed()
    } catch {
      return false
    }
  }
  if (live(main)) return main
  return all.find(live) ?? null
}
