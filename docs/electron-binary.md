# 사내망에서 Electron 바이너리 받기 (ME-1)

## 왜

Electron 42 부터 `electron` 패키지의 postinstall 이 바이너리를 받지 않는다. **처음 `electron` 을 실행할 때**(dev·smoke·e2e·`electron tests/*.cjs`) 받는다. `ELECTRON_SKIP_BINARY_DOWNLOAD` 는 더 이상 듣지 않는다(electronjs.org breaking-changes 42.0, `docs/orca-features.md` E-2 3절).
그래서 사내망(DLP·프록시)에서는 `npm ci` 는 통과하고 **첫 실행이 실패**하는 모양으로 드러난다. 패키징(`electron-builder`)도 따로 Electron zip 을 받는다.

## 절차

받는 쪽은 `@electron/get` 이고, 아래 환경변수를 본다.

| 변수 | 뜻 |
|---|---|
| `ELECTRON_MIRROR` | 받을 주소(기본 `https://github.com/electron/electron/releases/download/`). 사내 미러가 있으면 그 주소, 끝에 `/` |
| `ELECTRON_CUSTOM_DIR` | 미러 안의 판 폴더 이름(기본 `v{{ version }}`) |
| `electron_config_cache` | 캐시 폴더. 기본 Windows `%LOCALAPPDATA%\electron\Cache`, macOS `~/Library/Caches/electron` |
| `ELECTRON_BUILDER_CACHE` | electron-builder 의 자체 캐시(패키징 때 쓰는 zip) |

### A. 사내 미러가 있으면

```sh
# PowerShell: $env:ELECTRON_MIRROR = "http://<미러>/electron/"
ELECTRON_MIRROR="http://<미러>/electron/" npm ci
ELECTRON_MIRROR="http://<미러>/electron/" npx install-electron   # 첫 실행 전에 미리 받기
```

미러에는 `v<판>/electron-v<판>-<플랫폼>-<arch>.zip` 과 `SHASUMS256.txt` 가 있어야 한다.

### B. 미러가 없으면 — 캐시 폴더째 옮긴다

1. 받을 수 있는 곳(사외망 등)에서 같은 판으로 `npm ci` 후 `npx install-electron`(또는 `npx electron --version` 한 번)을 돌려 캐시를 채운다.
2. 그 캐시 폴더(위 표의 기본 위치)를 **통째로** 빌드 PC·맥 빌드 머신의 같은 위치로 복사한다. 하위 폴더 이름이 주소 해시라 zip 만 따로 옮기면 못 찾는다.
3. 빌드 PC 에서 `npx electron --version` 이 판을 찍으면 끝.

`npx install-electron` 은 42 릴리스 노트가 안내하는 명령이다. 43 설치 뒤 명령 이름·플래그를 `node_modules/electron/package.json` 의 `bin` 으로 한 번 확인한다(2026-11-01 작성 시점 40 이라 확인 못 했다).

## 막히면

**DLP(오피스키퍼)·프록시에 막히면 재시도하지 말고 준영님에게 보고한다.** 재시도는 차단 기록만 늘린다. 보고에는 어느 명령이 어느 주소에서 실패했는지(오류 원문)를 적는다.
