# A.R.A

사내 배포용 Windows 터미널(Electron). SSH·RDP·SFTP 접속과 로컬 셸을 한 창에서 다루고,
우측에 Claude Code(또는 API 키)를 붙여 서버 작업을 시킬 수 있다. **사내망 전용** —
자동 업데이트·배포 사이트가 사내 IP(`192.168.100.56`)를 본다.

## 띄우기

```
npm i
npm run dev
```

## 게이트

배포 전에 전부 통과해야 하는 자동 검사(대본은 `docs/release-test.md` 참고). 각각 무엇을 지키는지:

- `npm run typecheck` — `tsc --noEmit`. 타입 오류만 잡는다(런타임 동작은 안 본다)
- `npm test` — vitest 단위 테스트. ⚠️ 아래 함정 1번을 먼저 읽어라
- `npm run scan:magic` — `src/renderer/components`·`src/renderer/interactions`의 HEX/px 리터럴(토큰 우회)과 CSS 중괄호 불균형을 잡는다. 위반 시 exit 1
- `npm run scan:i18n` — 없는 i18n 키를 쓰면 화면에 키 문자열이 그대로 찍힌다. 그걸 빌드 전에 잡는다
- `npm run scan:push` — `src/main`에서 `webContents.send`/`postMessage`를 직접 호출하는 코드를 잡는다. 창으로 나가는 push는 `util/windowPush.ts`의 헬퍼(isDestroyed 가드 포함)만 거쳐야 한다
- `npm run build` — `electron-vite build`. main·preload·renderer 세 번들이 전부 컴파일되는지

## pre-push 훅 (#186)

밀기 직전 로컬에서 빠른 정적 검사만 자동으로 돈다: `typecheck`·`scan:magic`·`scan:i18n`·`scan:push`
(넷을 병렬로 돌려 약 12~14초). 하나라도 빨간불이면 push 가 막힌다. `npm test`(단위 테스트)는
훅에서 뺐다 — 전체 스위트가 47초+ 로 그 자체로 예산을 넘고, `mcp-server.test.ts`가 고정 포트
39217을 써서 dev 가 떠 있으면 깨진다(아래 함정 1번). 릴리스 전엔 사람이 손으로 `npm test`를 돌려라.

훅 파일은 `.githooks/pre-push`에 있고 커밋된다(`.git/hooks/`는 커밋 안 되므로 여기 둔다).
**새로 클론했다면 한 번 켜야 한다**:

```
git config core.hooksPath .githooks
```

급하면 `git push --no-verify`로 건너뛸 수 있다(훅이 막지 않는다).

이 훅이 못 잡는 것: `npm test`(단위 테스트 회귀) · `npm run build`(번들 컴파일 오류) · e2e · 스모크 ·
실기동 화면 확인. 전부 배포 전 `docs/release-test.md` 대본으로 사람이 돌려야 한다.

## 🔴 함정 다섯

모르면 반드시 한 번씩 당한다.

1. **`npm test` 전에 dev를 꺼라.** MCP 서버가 고정 포트 39217을 쥔다. dev를 내린 직후 곧바로
   테스트를 돌리면 `mcp-server.test.ts`가 포트 충돌로 죽을 수 있다(그 파일은 혼자 돌면 통과한다 —
   파일의 결함이 아니라 타이밍이다). `Get-Process electron`·`Get-NetTCPConnection -LocalPort 39217`로
   완전히 사라진 것을 확인하고 돌려라. `vitest.config.ts`가 `singleFork`라 전 파일이 한 프로세스에서
   도는데, 워커가 죽으면 남은 파일이 조용히 안 돌고 요약만 짧아진다 — 파일 수(약 110개)를 세어
   확인해라.
2. **`npm run dist:win`은 성공해도 종료 코드가 0이 아니다.** 마지막 정리 단계(`*.nsis.7z` 삭제)가
   백신/DLP 때문에 EBUSY로 죽는다. 실패로 읽지 말고 `dist/` 산출물의 타임스탬프로 판단해라.
3. **e2e는 기본으로 돌리지 않는다**(오래 걸린다). `tests/e2e/`에 스펙 43개가 있고,
   `npm run e2e:full`로 따로 돌린다(먼저 build).
4. **화면을 재는 하네스는 offscreen이다**(`tests/tip-check.cjs`·`tests/overflow-check.cjs`·
   `tests/doc-spacing-check.cjs`). 창을 띄우지 않는 것이 이 저장소의 규율이다 — 새 하네스를
   추가할 때도 따라라.

5. **`npm run dist:win`이 `cpu-features` 에서 죽으면 그 폴더를 지워라.**
   ```
   rm -rf node_modules/cpu-features && npm run dist:win
   ```
   증상은 gyp/MSBuild 실패인데 컴파일 오류가 아니다 — npm 디버그 로그를 열면 진짜 문장이 나온다:
   `error MSB6003: "CL.exe"을(를) 실행할 수 없습니다. …사용자가 매핑한 구역이 열려 있는 상태인
   파일에서 수행할 수 없습니다.` 즉 **보안 프로그램(오피스키퍼)이 빌드 중간 파일을 물고 있다.**
   같은 뿌리가 함정 2번의 EBUSY 다.

   지워도 되는 이유: `cpu-features`는 ssh2 의 **선택적** 성능 최적화이고
   (`node_modules/ssh2/lib/protocol/constants.js:7-8`이 `try { require('cpu-features')() } catch {}`),
   **이 PC 에서 한 번도 빌드된 적이 없다**(`.node` 산출물 부재). 즉 줄곧 없이 돌아왔다.
   ⚠️ `npm i`를 하면 되살아난다 — 그때 다시 지우면 된다. 근본은 `node_modules`가 DLP 예외로
   빠지는 것이고, 그건 사람이 요청해야 한다.

## 배포

`npm run site:stage` → `npm run site:deploy` 순서. `site:deploy`는 사내 서버에 SSH로 올라가므로
비밀번호가 필요하다 — **환경변수로만** 넘긴다:

```
ARA_DEPLOY_PW='...' npm run site:deploy
```

인자나 파일로 넘기지 마라(비밀번호가 없으면 스크립트가 그렇게 안내하고 그 자리에서 멈춘다).

## 코드 지도

- `src/main` — Electron 메인 프로세스. IPC 등록(`ipc/register*Ipc.ts`), SSH/SFTP/RDP, 세션·워크스페이스, 자동 업데이트
- `src/renderer` — React UI. 터미널(xterm)·컴포넌트·상태 스토어·i18n
- `src/shared` — 메인/렌더러 공용 타입과 로직(IPC 계약, 키맵, 시크릿 마스킹 등)
- `src/preload` — contextBridge로 노출하는 유일한 창구
- `tests` — vitest 단위 테스트 + `tests/e2e`(Playwright) + 스모크/스크린샷용 `.cjs` 하네스
- `site` — 배포 사이트(다운로드 페이지·매뉴얼). `site:stage`가 설치본을 여기 `downloads/`로 옮긴다
- `docs` — 배포 절차(`release-test.md`), 디자인 시스템(`design-system.md`) 등 참고 문서

## 알려진 한계

- **코드 서명이 없다.** 설치 시 SmartScreen 경고가 뜨고, 자동 업데이트도 무서명 바이너리를
  평문 HTTP로 받는다(`electron-builder.yml`의 `publish.url`).
- **CI가 없다.** 위 게이트는 전부 사람이 손으로 돌린다.
- **RDP 커서가 서버 커서를 안 따른다.** 로컬 커서만 보인다(원격 데스크톱 wasm 쪽 제약).
