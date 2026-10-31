# 기능 끼우는 틀 (M0 0-4)

기능 하나 = **main 등록 함수 + preload 다리 + 렌더러 `import()` 진입점 + 기여 목록(설정 섹션·메뉴)**.
Orca 가 다섯 자리(main 도메인·ipc·preload 쌍·store 슬라이스·컴포넌트)에 흩어 두는 것을 이름 규칙 하나로 묶는다.
묶음 13 플러그인 시스템(3차)이 같은 계약을 쓴다 — 외부 플러그인도 이 네 조각을 낸다.

## 폴더 규칙 (`<id>` = 기능 id)

| 조각 | 자리 | 내보내는 것 |
|---|---|---|
| main 등록 함수 | `src/main/<id>/feature.ts` | `register<Id>Feature(deps)` — 이 기능의 IPC(`handle`)를 전부 여기서 건다. 서비스 객체를 돌려준다 |
| preload 다리 | `src/preload/features/<id>.ts` | `<id>Bridge: Pick<EvApi, …>` — `preload/index.ts` 가 `api` 에 펼친다(`...<id>Bridge`) |
| 렌더러 진입점 | `src/renderer/features/<id>/index.ts` | `React.lazy(() => import('./…'))` 컴포넌트. 쓰는 쪽은 `<Suspense>` 로 감싼다. 이 폴더 밖에서 컴포넌트 파일을 직접 import 하지 않는다(하면 진입 청크로 끌려 들어온다) |
| 기여 목록 | `src/shared/<id>…ts` | `FeatureContrib`(`src/shared/featureModule.ts`) — main 메뉴·렌더러 설정이 둘 다 읽으므로 shared |

IPC 채널 계약(`EvApi`·채널 타입)은 지금처럼 `src/shared/ipc.ts` 에 둔다 — 한곳에서 타입이 맞물려야 tsc 가 잡는다.

## 계약

```ts
// src/shared/featureModule.ts
export type FeatureContrib = {
  id: string
  settings: { section: string; labelKey: string }[] // 설정 화면 섹션, labelKey = i18n 키
  menu: { command: string; labelKey: string }[]      // 메뉴바 명령 id
}
```

기여 목록을 실제로 메뉴·설정에 그리는 배선은 아직 없다 — 기여가 있는 첫 기능이 옮겨 올 때 단다(브라우저는 둘 다 비어 있다).

## 실증: 내장 브라우저

- main `src/main/browser/feature.ts` — `browser:*` IPC 6개. `registerForwardIpc` 가 부른다(`index.ts` 는 그대로).
- preload `src/preload/features/browser.ts` — `browser`·`browserTabs`.
- 렌더러 `src/renderer/features/browser/` — 탭 줄(`BrowserWindow.tsx`)이 #browserwin 창을 처음 열 때 불러온다.
- 기여 `BROWSER_FEATURE`(`src/shared/browserWin.ts`) — 빈 목록.
- 빌드: 진입 청크 2,190.71 → 2,188.34 kB, `BrowserWindow-*.js` 3.24 kB 로 갈라짐.
