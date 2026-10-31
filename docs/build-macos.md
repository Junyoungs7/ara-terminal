# macOS 빌드 (ME-1 E4)

맥은 준영님 혼자 쓴다. **Apple 인증서·공증 없음, ad-hoc 서명**으로 간다(`agent_talk/orca-bundle-decisions.md` 계획서 8절). 설정은 `electron-builder.yml` 의 `mac:` 절에 있고 이유는 그 주석에 있다.

> 이 절차는 맥에서 돌려 보지 않았다(2026-11-01 작성 시점). 처음 돌릴 때 틀린 곳을 여기 고친다.

## 1. 준비 (맥에서 한 번)

- Node(Windows 빌드 PC 와 같은 메이저), Xcode Command Line Tools(`xcode-select --install` — `codesign` 이 여기 있다).
- 저장소를 받는다. Electron 42 부터 바이너리를 `npm ci` 때가 아니라 **첫 실행 때** 받는다 — 사내망이면 [`electron-binary.md`](electron-binary.md) 를 먼저 본다.

## 2. 빌드

```sh
npm ci
npm run dist:mac
```

- 결과: `dist/` 아래 `ARA-<버전>.dmg`·`ARA-<버전>-mac.zip`(arm64 맥이면 이름에 `-arm64`), 앱 번들은 `dist/mac/` 또는 `dist/mac-arm64/`.
- 빌드 맥의 아키텍처 하나로만 나온다(`arch` 를 안 적었다).
- 서명 단계는 건너뛴다(`identity: null` — 로그에 "skipped macOS code signing").

## 3. 설치 + ad-hoc 서명

1. dmg 를 열어 `ARA.app` 을 `/Applications` 로 끌어 놓는다.
2. 설치한 앱에 ad-hoc 서명과 quarantine 제거:
   ```sh
   bash scripts/sign-adhoc.sh /Applications/ARA.app
   ```
   (스크립트의 기본 경로 `dist/mac/A.R.A.app` 은 옛 이름이다 — 경로를 꼭 넘긴다.)
3. 처음 열 때 Gatekeeper 가 막으면 Finder 에서 우클릭 › 열기.

## 4. 업데이트

**수동 설치 전제다.** 맥 자동 업데이트(Squirrel.Mac)는 서명된 앱만 교체하므로 ad-hoc 으로는 거의 확실히 안 된다. 새 판은 2~3 을 다시 한다. `latest-mac.yml` 은 사내 배포 서버에 올리지 않는다.

## 5. 첫 실행에서 볼 것 (계획서 6절 첫 맥 스모크)

셸 열림(맥은 스폰 실패 폴백이 없다 — `PtyBackend.ts`), Claude CLI 실행, 끌어놓기, 저장 대화상자가 마지막 폴더에서 열리는지.
