# Orca 기능 전수 목록 v4 — 이식 분류·우선순위·Electron 맞추기

> **v4 · 2026-10-31** · 대상 `stablyai/orca` @ `7a7f46f8a3` (v1.4.245, MIT) · `D:\orca`
> v4 에서 바뀐 점: 준영님과 묶음별로 정한 결정([`agent_talk/orca-bundle-decisions.md`](../agent_talk/orca-bundle-decisions.md) — 묶음 0~13, 원칙 "AI 기능은 Orca 를 따라간다", 방향 "개발 통합 툴")을 반영해 표 77행을 고쳤다(분류 이동 30행). 묶음 0(기반)을 3절로 새로 넣었고, 대응표에 1차 18항목(AI-11~19 · DM-01~05 · FD-01~04)을 더했다(24 → 42항목). 모바일(C절)은 Claude 원격 제어 1차 + Orca 스토어 앱 연결 3차로 고쳐 썼다.
> v3 에서 바뀐 점: 준영님 추가 결정 5~12(0절)를 반영해 67행을 고쳤다(분류 이동 53행). 원격·모바일·데몬은 이식으로, 터미널 일반 기능·macOS 대응은 새 분류 `터미널 개선`으로 옮겼다. 턴 끝 판정은 1차 확정, 브라우저는 Electron 43·ai-browser 뒤로, File.path 는 위험이 아니라 먼저 할 일로 고쳤다. macOS 대응 재료(E-3)를 넣고 대응표에 TM-01(점프 호스트)을 더했다.
> 아래는 v2 설명이다. v1(같은 날)을 덮어쓴 판이다. 바뀐 점: ① 전체 이력으로 신규·변경을 다시 판정했다(`git fetch --unshallow`, 히스토리 03-16~). ② 아라 현황을 코드로 다시 확인했다. ③ 분류·우선순위 열을 넣었다. ④ 이식 대응표 [`orca-port-map.json`](orca-port-map.json)을 만들었다. ⑤ Electron 맞추기 재료(E절)를 넣었다.
> 방법: 읽기 전용 정적 분석이다. Orca 에서 한 git 쓰기는 unshallow fetch 하나뿐이다(checkout·merge 안 함, 작업 트리는 `7a7f46f8a3` 그대로). 빌드·설치·실행은 하지 않았다.
> 이전 분석: [`orca-analysis.md`](orca-analysis.md) (기준 `94e75866`, 2026-08-28)

## 0. 준영님 결정 (2026-10-31) — 이 판의 분류 기준

1. **터미널과 AI 를 나눈다.** 터미널은 서버 접속, AI 는 별도 작업 공간이다. Orca 기능은 AI 작업 공간으로 들어간다.
2. **음성 얼굴과 아라 채팅은 지금처럼 아라 전체의 전역 기능으로 둔다.** Orca 의 같은 기능은 이식하지 않거나 연결만 한다.
3. **Electron 을 Orca 와 맞춰 올린다**(31 → 43). E절에 재료가 있다.
4. **Orca 업데이트는 매주 월요일 모니터링한다.** `orca-port-map.json` 의 `orcaPaths` diff 를 본다(F절).

### 추가 결정 (2026-10-31, v3)

5. **AI 작업 공간은 "서버에 영향 없음" 제약을 받지 않는다.** 지금까지는 "아라는 서버에 아무 영향을 주지 않는다"는 원칙 때문에 Orca 처럼 데몬을 띄우지 않았다. 새 AI 작업 공간은 이 제약 없이 간다. 로컬 상주 데몬, 원격 서버에 orcad·관리형 서버 설치, `orca serve` 같은 상주 프로세스를 모두 허용한다.
   - **터미널(서버 접속) 쪽은 기존 원칙 그대로다.** 서버에 아무것도 깔지 않고 아무 영향도 주지 않는다. 제약이 풀린 것은 AI 작업 공간뿐이다.
   - 이 제약을 이유로 든 v2 판정("원격 데몬 안 함", "§8 원격 설치 금지", "운영 서버에 상주 프로세스 설치", "데몬 전제라 제외")은 모두 다시 판정했다. 남은 주의점은 "운영 서버에 설치할 때 호스트별 사용자 동의·제거 방법"이라는 운영 메모다. 차단 사유가 아니다.
6. **보류했던 원격·모바일·데몬은 진행한다.** 해당 행은 `AI 작업 공간으로 이식`으로 옮기고 1·2·3차를 매겼다. WSL 행도 같이 진행한다(WSL 사내 허용 여부는 메모).
   - 모바일은 Orca 스토어 앱·Orca 클라우드(릴레이·푸시·계정)를 빌리지 않는다. **자체 경로**로 간다. Orca `mobile/` 포크로 사내 앱을 만들고, LAN 직결 또는 자체 릴레이를 쓴다(C절). **v4 에서 바뀜**: 묶음 9 결정으로 Orca 스토어 앱 연결 3차가 본 경로이고 자체 포크는 대안이다(아래 묶음별 결정, C절).
   - Orca 클라우드에만 묶인 기능은 "자체 릴레이/자체 푸시로 대체"로 이식 판정했다. 대체가 불가능한 것만 사내 부적합으로 남겼다.
7. **"아라에 없는 터미널 일반 기능"은 별도 `터미널 개선` 트랙으로 뺀다.** 점프 호스트·OSC 52·Reset Terminal·인라인 이미지·Kerberos·셸 선택·테마처럼 v2 에서 "터미널 개선 후보"로 보류한 행이 여기로 간다. 내장 브라우저 개선과 앱 안정성(렌더러 복구·멈춤 감시 등)처럼 지금 아라 앱에 넣을 일반 기능도 같이 넣었다. 우선순위도 매겼다.
8. **경계 기능(세션 복원·우측 사이드바·파일 탐색기 등)은 터미널과 공유한다.** AI 작업 공간에 따로 만들지 않고 한 구현을 양쪽에서 쓴다. 해당 행 메모에 "공유(터미널과 같은 구현)"를 적었다.
9. **파일 끌어놓기·붙여넣기(File.path 제거)는 위험이 아니라 할 일이다.** `webUtils.getPathForFile(file)` 을 preload 로 노출하고 `pasteFiles.ts:76`·`AraChatPanel.tsx:418` 을 고친다. 지금 Electron 31 에서 먼저 바꿀 수 있다(E-2 3절).
10. **턴 끝 판정(AI-05)은 1차로 확정한다.** 화면에 '추정' 상태를 따로 보인다.
11. **브라우저 계열은 Electron 업그레이드 뒤에 한다.** 그리고 `D:\AI\ai-browser`(다른 에이전트가 만드는 사용자+AI 공용 브라우저)가 정상 동작하면 그것을 이식하면서 진행한다. 브라우저 행의 우선순위 이유에 이 순서를 적었다.
12. **아라는 macOS 에서도 제대로 동작해야 한다.** macOS 관련 행(로컬 네트워크 복구, Dock 배지, Ghostty 가져오기 등)은 이식·터미널 개선으로 판정했다. "사내 Windows 라서"를 이유로 든 판정·메모도 다시 봤다. 맥 대응 재료는 E-3 에 있다.

### 묶음별 결정 (2026-10-31, v4)

정본은 [`agent_talk/orca-bundle-decisions.md`](../agent_talk/orca-bundle-decisions.md) 다. 여기는 표를 읽는 데 필요한 줄기만 적는다. 표의 우선순위 칸에 `묶음 N` 으로 근거를 달았다.

- **1·2·3차는 개발 순서다.** 셋 다 만든다. "빼기"만 안 만든다(우선순위 `—`).
- **원칙 — AI 기능은 Orca 를 따라간다.** 아라에 이미 있거나 일부 있어도 Orca 쪽이 낫다면 Orca 것을 쓴다. 그래서 v3 의 "아라 것 유지·넓히기"와 "기본값을 뒤집어서 가져온다"를 다시 봤다. 상태 표시 점·첨부·채팅 이름·에이전트 복원·MCP 서버 등록은 Orca 것으로 바꿨다. 권한 기본값(Yolo)과 `.worktreeinclude`(`.env` 복사)는 Orca 기본값 그대로 간다.
- **방향 — 아라는 개발 통합 툴이다.** 터미널·AI 말고도 기능이 계속 붙는다. 그래서 확장성(기능을 끼우는 틀)과 성능(빠릿빠릿·가볍게, 메모리·CPU 관리)을 1차 맨 앞의 **묶음 0(기반)** 으로 둔다(3절).
- 이 판에서 크게 움직인 것:
  - **1차로 당김**: 채팅 화면 8행(묶음 7), 로컬 데몬·orcad·관리형 서버·SSH 워크트리·실행 위치(묶음 3·8), 상태 표시 점(Orca 것), 자원 관리자·멈춤 감시·진단 프로브·렌더러 복구(기반).
  - **2차로 당김**: 자동화 4행·스킬 관리 화면·MCP 등록(묶음 10), 머지 충돌 3-way(묶음 5), Claude·Codex 계정 여러 개·Gemini 사용량(묶음 6), Slack 연결(사내 Slack 앱)·AI 공간 첫 안내(묶음 13), 워크트리 수동 재우기(묶음 3).
  - **넣기로 바꿈(3차)**: 플러그인·저작 CLI(사내 승인만), Computer Use(기본 꺼짐), 브라우저 5행(DevTools·사이트 권한·다운로드·쿠키·확장 — ai-browser 와 함께), 펫, 셋업 가이드, 설치 폴더 ACL, 네트워크·프록시, 관리 데이터 계정.
  - **빼기로 바꿈**: 이모지 이름(묶음 1), Jupyter(묶음 4), Jira(묶음 11).
  - **모바일(묶음 9)**: Claude 원격 제어 자동 켜기가 1차, Orca 스토어 앱 연결이 3차(사내 Wi-Fi 직결 실측 전제)다. 자체 포크는 대안으로 내렸다(C절).
  - **브라우저**: ai-browser 가 설치돼 있으면 에이전트가 MCP 로 그것을 쓴다. ai-browser 쪽에 MCP 서버를 만들어야 한다.
  - **Git 호스트(묶음 11)**: GitLab 연동은 2차다. 기본은 꺼져 있고, 켜도 MR·푸시는 사용자가 누를 때만 한다.
- 묶음 14(설정·메뉴·상단 정리)는 아직 분석 중이라 이 판에 넣지 않았다.

### 분류 열의 여섯 값

| 분류 | 뜻 |
|---|---|
| **AI 작업 공간으로 이식** | 새 AI 작업 공간에 가져온다. 원격·데몬·모바일(Orca 앱 연결)도 여기다(결정 5·6, 묶음 9) |
| **터미널(서버) 쪽에 이미 있음·유지** | 아라가 이미 하는 일이다. 아라 것을 그대로 둔다 |
| **터미널 개선** | 터미널(서버) 쪽, 곧 지금의 아라 앱에 새로 넣을 것이다. 터미널·SSH 일반 기능, macOS 대응, 내장 브라우저 개선, 앱 안정성이 여기 든다(결정 7·12). v4 의 기반 1차 3행(멈춤 감시·진단 프로브·렌더러 복구)도 앱 전체에 들어가므로 분류는 여기 두고, 우선순위 칸에 `기반`을 적었다 |
| **전역 기능과 겹침** | 음성·아라 채팅과 겹친다. 이식하지 않거나 연결만 한다 |
| **사내 부적합** | 클라우드·Orca 계정·외부 SaaS 에 의존하고, 자체 대체가 불가능하다 |
| **보류** | 필요 없음·빼기. Linux 전용·개발자 전용 기능, 모바일 에뮬레이터, JIS ¥, Caffeinate(A 의 "컴퓨터 깨어있기"와 중복), 기능 소개 벽, Windows 관리자 모드, 그리고 v4 에서 빼기로 정한 이모지 이름·Jupyter·Jira 다. macOS 전용은 여기 두지 않는다(결정 12). v3 의 예외(플러그인 2행·Computer Use·다운로드·사이트 권한·프록시)는 v4 에서 모두 넣기로 바뀌어 여기서 나갔다 |

## 1. 요약 수치 (v4)

수치는 모두 표 행을 스크립트로 세어 낸 값이다(A·B 는 9칸, C-6 은 8칸 행을 세고 분류·우선순위 칸의 첫 낱말로 묶는다). 행 구성(276행)과 아래 신규·변경·기존 수는 v3 와 같다. v4 는 분류·우선순위·메모만 고쳤다.

| 묶음 | 기능 | 신규 | 변경(대폭)·변경 | 기존 |
|---|---:|---:|---:|---:|
| A. AI | 99 | **27** | 23 | 49 |
| B. 워크스페이스·터미널·원격·에디터·리뷰·연동·브라우저·앱 셸 | 155 | **23** | 67 | 65 |
| C. 모바일 | 22 | **6** | 8 | 8 |
| **합계** | **276** | **56** | 98 | 122 |

v2 는 B 를 154행으로 적었지만 스크립트로 다시 세면 155행이다(빠진 1행은 변경·없음·보류·— 행이었다). v3 는 155 로 고쳤다.

v1 대비 신규는 35에서 56이 됐다. 다만 v1 의 "35"는 v1 요약표 계산이 틀린 값이었다. 모바일 표의 "예" 9행을 0으로 셌으므로 v1 실제 값은 44였다. 이번에 바뀐 내용은 다음과 같다.
- AI 는 12 → 27 이다. 채팅 UI 세부(모델 선택·슬래시 명령·첨부·채팅/터미널 선택·이어하기·채팅 권한), 서브에이전트 자식 줄, 턴 끝 판정, 워크트리 재우기, 컨텍스트 사용량이 신규로 올라갔다.
- B 는 23 → 23 이다. 3개가 올라가고 3개가 내려갔다. 얕은 클론의 시작점(8-27)과 기준일(8-28)이 하루 차이라 폴더 단위 판정은 거의 같았다.
- 모바일은 9 → 6 이다. 받아쓰기·작업·계정 전환은 8-28 이전부터 있었다.

| 분류 | A | B | C | 합 |
|---|---:|---:|---:|---:|
| AI 작업 공간으로 이식 | 77 | 77 | 20 | **174** |
| 터미널(서버) 쪽에 이미 있음·유지 | 7 | 34 | 0 | **41** |
| 터미널 개선 | 0 | 22 | 0 | **22** |
| 전역 기능과 겹침(음성·아라 채팅) | 3 | 1 | 1 | **5** |
| 사내 부적합(클라우드·계정, 대체 불가) | 11 | 11 | 1 | **23** |
| 보류(필요 없음·빼기) | 1 | 10 | 0 | **11** |
| **합** | 99 | 155 | 22 | **276** |

v3 → v4 에서 바뀐 행은 77개다(A 32 · B 35 · C 10). 그중 분류가 바뀐 행이 30개다.
- A 14: 부적합 → 이식 5(Claude·Codex 계정, 관리 데이터 계정, Gemini 사용량, Slack), 유지 → 이식 4(상태 표시 점, 에이전트 복원, MCP 등록, 자원 관리자), 전역 겹침 → 이식 3(첨부, 채팅 이름, 펫), 보류 → 이식 2(플러그인, 저작 CLI).
- B 15: 보류 → 터미널 개선 4(DevTools, 사이트 권한, 다운로드, 설치 폴더 ACL), 보류 → 이식 3(Computer Use, 셋업 가이드, 네트워크·프록시), 부적합 → 터미널 개선 2(쿠키, 크롬 확장), 부적합 → 이식 2(플러그인, 펫), 전역 겹침 → 이식 1(온보딩), 이식 → 보류 3(이모지, Jupyter, Jira — 빼기).
- C 1: 부적합 → 이식 1(에이전트 계정 전환).
나머지 47행은 분류는 그대로 두고 우선순위·메모만 고쳤다.

| 우선순위 | A | B | C | 합 | 그중 터미널 개선 | 그중 기반(묶음 0) |
|---|---:|---:|---:|---:|---:|---:|
| 1차 | 26 | 24 | 0 | **50행 → 대응표 42항목** | 4 (점프 호스트 + 기반 3) | 4 |
| 2차 | 26 | 26 | 0 | 52 | 2 | 0 |
| 3차 | 26 | 56 | 20 | 102 | 16 | 0 |
| — (안 만듦) | 21 | 49 | 2 | 72 | 0 | 0 |

1차 50행 중 2행(B 의 활동 피드·대시보드)은 A §13 과 같은 기능이라 대응표 한 항목(AI-08·AI-09)을 함께 쓴다. 1차 표 행과 대응표 항목의 짝은 2절에 있다. 대응표에 없는 1차 일(아라 쪽 일)은 3절과 C절에 있다.

**아라 현황**(A+B 254행): 있음 21 · 부분 67 · 없음 165 · 대체 1. v1 의 "부분" 70행을 코드로 다시 열어 봤고, 판정이 바뀐 행은 19개다(A 5 + B 14, 표에 ✎ 표시). 대표 사례는 다음과 같다.
- 에이전트 대시보드: 없음 → 부분. `aiWorkbench.ts:215` 가 이미 상태별로 묶는다.
- 완료 알림: 있음 → 부분. 질문·권한 대기만 알리고 완료 알림은 없다.
- Quick Open·전체 검색: 부분 → 없음.
- 내장 브라우저: 있음 → 부분. 주소창·앞으로·찾기가 없다.
- 다운로드: 부분 → 없음. `BrowserService.ts:37` 이 일부러 막아 둔 것이다.

## 2. 1차 이식 목록 — 대응표 42항목 ([`orca-port-map.json`](orca-port-map.json))

모든 `orcaPaths`(203개)가 `7a7f46f8a3` 에 실제로 있는지 `git ls-tree` 로 확인했다. 누락은 0건이다. v4 에서 18항목(경로 51개)을 더했다: 상태 표시 점(AI-11), 채팅 화면 8항목(AI-12~19), 데몬·원격 5항목(DM-01~05), 기반 4항목(FD-01~04). 모두 `orcaRef` `7a7f46f8a3`, `status` `planned` 다. Orca 원본이 없는 아라 쪽 1차 일(성능 예산·지연 로드·프로세스 분리·기능 끼우는 틀·에이전트별 자원 상한·Claude 원격 제어 자동 켜기)은 대응표에 넣지 않았다(3절·C절).

| id | 기능 | 경로 수 | | id | 기능 | 경로 수 |
|---|---|---:|---|---|---|---:|
| AI-01 | 에이전트 고르기·설치 감지 | 8 | | WS-01 | 워크트리 = 작업 단위 | 10 |
| AI-02 | 에이전트 실행 설정(인자·환경·권한 모드) | 7 | | WS-02 | 새 워크스페이스 만들기 | 2 |
| AI-03 | 에이전트 실행·첫 프롬프트 전달 | 5 | | WS-03 | 백그라운드 생성·진행 표시 | 2 |
| AI-04 | 에이전트 상태 훅(여러 CLI) | 13 | | WS-04 | 분기 지점 고르기 | 3 |
| AI-05 | 턴 끝 판정(훅 없는 CLI, '추정' 표시) | 1 | | WS-05 | 워크스페이스 사이드바(그룹·필터·핀) | 1 |
| AI-06 | 서브에이전트 자식 줄 | 6 | | WS-06 | 파일 빠른 열기 | 12 |
| AI-07 | 지난 에이전트 세션 목록·재개 | 12 | | WS-07 | 코드 에디터(Monaco) | 6 |
| AI-08 | 에이전트 대시보드(상태별 보드) | 8 | | WS-08 | 변경 감지 안전 저장 | 5 |
| AI-09 | 활동 피드 | 3 | | WS-09 | 워크트리 전체 검색 | 7 |
| AI-10 | 사용량·한도 표시 | 13 | | WS-10 | Diff 뷰어 | 4 |
| AI-11 | 상태 표시 점(Orca 글리프 채택) | 7 | | WS-11 | AI diff 주석(줄 코멘트 → 에이전트) | 4 |
| AI-12 | 채팅 UI(구조화 채팅) | 4 | | WS-12 | 소스 컨트롤 패널 | 8 |
| AI-13 | 터미널 에이전트를 채팅으로 보기 | 1 | | WS-13 | 푸시 안전장치·amend | 4 |
| AI-14 | 에이전트별 채팅/터미널 기본 선택 | 2 | | TM-01 | 점프 호스트·프록시·멀티플렉싱(터미널 개선) | 8 |
| AI-15 | 모델·추론강도·모드 선택 | 2 | | DM-01 | 로컬 터미널 데몬 | 2 |
| AI-16 | 슬래시 명령·스킬 목록 | 2 | | DM-02 | orcad(호스트 서버 데몬) | 1 |
| AI-17 | 파일·이미지 첨부, 초안 보존 | 2 | | DM-03 | 관리형 서버 자동 설치·업데이트 | 2 |
| AI-18 | 채팅 권한 설정 | 2 | | DM-04 | SSH 워크트리 | 6 |
| AI-19 | 채팅 이름 자동 생성 | 2 | | DM-05 | 실행 위치 선택(Run on) | 2 |
| | | | | FD-01 | 자원 관리자(기반) | 6 |
| | | | | FD-02 | 멈춤 감시(기반) | 1 |
| | | | | FD-03 | 진단 프로브(기반) | 1 |
| | | | | FD-04 | 렌더러 복구·안전 그래픽 모드(기반) | 6 |

## 3. 묶음 0 — 기반(성능·확장성) · 1차 맨 앞

아라는 개발 통합 툴이라 기능이 계속 붙는다. 그래서 기능보다 먼저 "가볍게 돌고, 기능을 끼울 자리가 있는" 바탕을 깐다. 표의 기반 행은 우선순위 칸에 `기반 — 묶음 0` 을 적었다.

| 항목 | 내용 | Orca 근거 | 대응표 |
|---|---|---|---|
| 성능 예산 | 지금 아라의 기준선(켜는 시간 · 유휴 메모리/CPU · 작업 공간 여는 시간)을 Electron 을 올리기 **전에** 잰다. 넘으면 시험이 실패한다. 목표 수치는 따로 두지 않는다 — 기준선보다 느려지지 않게 한다 | — (아라 쪽 일) | 없음 |
| 쓸 때만 불러오기 | AI 공간 · Monaco · 브라우저를 지연 로드한다 | — (아라 쪽 일) | 없음 |
| 무거운 일은 따로 | 무거운 일은 데몬(DM-01)·보조 프로세스로 보내 메인·렌더러를 가볍게 둔다 | 참고: `src/packages/process-host`, `src/main/worker-thread-child-process`(E-1) | 없음(구조 원칙) |
| 기능을 끼우는 틀 | 모듈 경계. 묶음 13 의 플러그인 시스템(3차)과 구조를 맞춘다 | 참고: E-1 모듈 경계 | 없음(구조 원칙) |
| 자원 관리자 | 프로세스·PTY 별 CPU/메모리(A §13, 3차 → 1차) | `src/main/memory/`, `store/slices/memory.ts`, `status-bar/ResourcePty*` | FD-01 |
| 에이전트별 자원 상한 | 에이전트·터미널마다 메모리/CPU 상한. Orca 의 Linux cgroup 아이디어를 Windows Job Object·macOS 방식으로 옮긴다(묶음 13 → 0). 자원 관리자에 붙인다 | Orca 는 Linux cgroup 만 있다(B §3 "Linux 터미널 메모리 상한", 보류) | 없음 |
| 멈춤 감시 | 메인 스레드 멈춤 감지·다음 실행 때 보고(B §12, 터미널 개선 3차 → 1차) | `src/main/hang-watchdog/` | FD-02 |
| 진단 프로브 | 이벤트 루프 지연·처리량 측정(B §12, 3차 → 1차) | `src/main/diagnostics/` | FD-03 |
| 렌더러 복구 | 렌더러 크래시 자동 재로드, GPU 크래시 반복 시 안전 모드(B §12, 2차 → 1차) | `R/error-boundaries/`, `src/main/window/renderer-recovery-*`, `src/main/crash-reporting/gpu-fallback-*` | FD-04 |

### 이식 관점 상위 판단 (v4)

1. **순서는 기반 → 작업 단위 → 실행·상태 → 화면이다.** 묶음 0(성능 기준선·지연 로드·자원 관리)을 먼저 깔고, 뼈대인 "워크트리 = 작업 단위"(WS-01~05)를 세운다. 그 위에 에이전트 실행(AI-01~03)·상태(AI-04~06·08·11)·채팅(AI-12~19)이 얹히고, 결과를 보는 화면(WS-07·10~13)이 붙는다. 로컬 데몬(DM-01)은 앞쪽에 둔다. 업데이트·재시작에도 에이전트가 살아 있어야 나머지 화면이 의미가 있다.
2. **AI 쪽은 Orca 를 따라간다(원칙).** 아라에 이미 있는 것(훅 상태·작업대·아라 채팅·사용량 조회)도 Orca 구조로 옮긴다. 아라 채팅은 Orca 채팅 엔진 위의 한 인스턴스가 되고, 음성·얼굴·승인·부트스트랩은 그 위에 얹는 층으로 남는다(묶음 7). 사용량은 `claude -p "/usage"` 대신 Orca 방식(statusLine `rate_limits` + `api/oauth/usage`)으로 바꾼다(묶음 6).
3. **새 의존이 생긴다.** 에디터·diff 는 Monaco, 검색은 ripgrep 바이너리, 데몬은 상주 프로세스가 필요하다. Electron 을 올리는 일과 시점을 맞추고, 올리기 전에 성능 기준선을 잰다(3절).
4. **사내 부적합 23행은 만들지 않는다.** Orca 계정·아티팩트 공유·Cloud VM·Cloud 커넥터·GitHub 계열·Bitbucket·Gitea·Azure DevOps·Linear·신규 프로바이더 묶음·Codex 리셋 크레딧·사용량 공유 카드·미지원 에이전트 계정 등이다. 쿠키 기반 타사 사용량은 "여러 프로바이더 사용량" 행에서 Gemini 만 남기고 뺐다. v3 에서 부적합이던 계정 여러 개(Claude·Codex)와 Slack(사내 Slack 앱, Socket Mode)은 2차로 옮겼다.
5. **기본값도 Orca 그대로 가져온다(원칙).** 권한 기본값 Yolo, `.worktreeinclude`(`.env` 복사)가 그렇다. 꺼 두는 것은 결정에 적힌 것뿐이다: OSC 52(기본 꺼짐, 설정에서 켜기), GitLab 연동(기본 꺼짐), Computer Use(기본 꺼짐·켤 때 확인·아라 창 제외).
6. **데몬·원격은 1차다**(묶음 3·8). 로컬 데몬·orcad·관리형 서버 자동 설치·SSH 워크트리·실행 위치 선택이 1차, VS Code 로 열기가 2차, `orca serve`·원격 바인딩 키 경고·WSL·네트워크·프록시가 3차다. 서버에 설치할 때는 호스트별 사용자 동의를 받고 제거 방법을 준다. 터미널(서버 접속) 쪽은 지금처럼 서버에 아무것도 깔지 않는다.
7. **터미널 개선 트랙은 22행이다**(결정 7·12). 1차는 점프 호스트(TM-01)와 기반 3행(멈춤 감시·진단 프로브·렌더러 복구), 2차는 Reset Terminal·macOS 로컬 네트워크 복구다. 브라우저 계열 8행은 Electron 43·ai-browser 다음 3차다.

### 결정이 필요한 것

남은 것만 적는다.

1. **펫·설정 안 셋업 가이드의 차수.** 묶음 13 "넣기"에 차수가 없어 3차로 두었다(A §13 펫 오버레이, B §13 셋업 가이드·별 요청·펫).
2. **밖(LTE)에서 Orca 앱 연결 경로.** Orca 릴레이(Orca 계정 필요)와 사내 VPN 중 미정이다(묶음 9). 3차 착수 전에 정하면 된다.
3. **`orca` CLI 행을 원칙으로 다시 볼지.** A §10 의 `유지` 6행(CLI 등록·worktree·terminal·file 명령·내장 브라우저 자동화·명령 제안)은 "MCP 로 대체"라는 v2 판정 그대로다. 결정 기록에 언급이 없어 바꾸지 않았다.
4. **묶음 14(설정·메뉴·상단 정리)** — 분석 중이다(`agent_talk/menu-settings-task.md`).

---

# A. AI 영역 기능 목록


- **8-28 이후 판정**: 전체 이력(unshallow) 기준. `firstadd.cjs`(파일 최초 추가일) + `git log --oneline 94e75866..7a7f46f8a3 -- <경로> | wc -l`.
  - **신규** = 기능 핵심 파일/폴더 최초 추가가 2026-08-28 이후 / **변경(대폭)** = 그 전부터 있었고 8-28 이후 커밋 대략 30+ 또는 사용자에게 보이는 동작이 바뀜 / **기존** = 그 외.
  - Orca 이력은 2026-03 부터 있다(지난 판의 "08-27 import 시작" 전제는 얕은 클론 탓이었다).
- **아라 현황**: D:\AI\OFA master(a0a024e) 코드를 직접 열어 확인. `있음` / `부분` / `없음` + 근거 파일:줄.
- **분류**(하나만): `이식` = AI 작업 공간으로 이식 / `유지` = 터미널(서버) 쪽에 이미 있음·유지 / `전역 겹침` = 음성 얼굴·아라 채팅과 겹침(이식 안 하거나 연결만) / `부적합` = 사내 부적합(클라우드·계정·외부 SaaS, 자체 대체 불가) / `터미널 개선` = 터미널(서버) 쪽에 새로 넣을 것 / `보류` = 필요 없음(0절 분류표). v2 의 "보류 = 모바일·원격 데몬"은 결정 5·6 으로 없어졌다.
- **우선순위**: `1차`(외부 의존 없음·가치 큼) / `2차` / `3차` / `—`(이식 안 함). 1차 항목은 `portmap-ai.json` 의 AI-xx 와 짝지었다.
- 경로 접두: `m/` = `src/main/`, `r/` = `src/renderer/src/components/`, `s/` = `src/shared/`, `d/` = `docs/site/content/docs/`, `sl/` = `src/renderer/src/store/slices/`. 아라 쪽은 저장소 루트 기준 전체 경로.

## 1. 지원 에이전트 · 실행

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 에이전트 고르기(피커) 원클릭 실행 | 40여 CLI 를 목록에서 골라 워크트리 폴더에서 띄움, 미설치면 설치 안내 | `r/agent/AgentCombobox.tsx`, `d/agents/supported.mdx` | 기존 04-21, 21커밋 | 부분 — claude/codex/gemini/custom 4종 표(`src/shared/aiCli.ts:23`), 최근 쓴 CLI(`src/renderer/store/aiCliRecent.ts`) | 이식 | 1차(AI-01) 작업 공간의 입구 | M | 사내 허용 CLI 만 표에 등록 |
| 신규 프로바이더 묶음 | Kiro·Qwen Code·OMP·Muse·ZCode·DeepSeek Harness·jcode·Qoder·CodeBuddy·opencode2 훅/상태 연동 | `m/kiro`, `m/qwen-code`, `m/omp`, `m/muse`, `m/zcode`, `m/dsh`, `m/jcode`, `m/qoder`, `m/codebuddy`, `m/opencode2` | 신규 09-19~10-12 | 없음 | 부적합 | —(대부분 중국·해외 SaaS 모델) | S(개당) | 사내 허용 확인된 것만 개별 검토 |
| 설치된 에이전트 감지·활성/비활성 | PATH 탐지, 버전 프로브, 메뉴에 보일 CLI 선택 | `r/settings/AgentDetectionCatalog.tsx`, `m/agent-cli-version-probe.ts`, `s/agent-detection.ts` | 기존 08-24(버전 프로브만 신규 10-07) | 부분 — MCP `which.cli` 도구만(`src/main/mcp/tools.ts:653`), 화면 감지 없음 | 이식 | 1차(AI-01) 피커와 한 묶음 | S | 문제없음 |
| 에이전트별 실행 인자·환경 편집 | 행 펼쳐 실행 인자/환경변수 덮어쓰기, 호스트별 저장 | `r/settings/AgentLaunchDefaultsEditor.tsx`, `HostAgentLaunchSettings.tsx` | 기존 08-24, 9커밋(호스트별은 10-11 추가) | 부분 — CLI별 플래그 토글만(`src/shared/aiCli.ts` AiCliFlag·AI_CLIS) | 이식 | 1차(AI-02) 외부 의존 없음 | S | 문제없음 |
| 권한 모드 일괄 전환(Yolo/수동) | 미커스텀 에이전트 전체를 확인 건너뛰기 ↔ 수동 승인으로 | `r/settings/AgentPermissionsSetting.tsx`, `AgentPermissionModeMenu.tsx` | 신규 10-19 | 부분 — 세션 단위 `skipPerms`(`src/shared/aiSession.ts:24`), 전역 일괄 없음(의도) | 이식 | 1차(AI-02) 실행 설정과 한 화면 | S | 기본값은 다 허용(Yolo) — Orca 그대로(묶음 2) |
| 폴더 신뢰 사전기록 | Cursor/Codex/Qoder 첫 실행 "이 폴더 신뢰?" 를 미리 기록 | `m/agent-trust-presets.ts`, `m/agent-workspace-trust.ts` | 기존 05-05(신뢰 가드 09-29 추가) | 없음 | 이식 | 3차(대상 CLI 가 사내에 거의 없음) | S | 에이전트 설정파일을 앱이 씀 — 고지 필요 |
| 실행과 첫 프롬프트 전달(launch intent) | 워크트리 생성+에이전트+초기 프롬프트를 한 번에, TUI 준비 후 주입 | `m/agent-launch/`, `m/ipc/pty/ipc/spawn-agent-launch.ts` | 신규 09-15, 59커밋 | 부분 — 한 줄 주입(`aiCli.ts` buildLaunch), 실행 계획(`src/renderer/store/aiSessions.ts:70` planAiLaunch). TUI 준비 대기 없음 | 이식 | 1차(AI-03) 프롬프트 유실 방지 | M | 문제없음 |
| 재시작 칩 | 에이전트 종료 시 같은 폴더·계정으로 원클릭 재실행 | `d/model/agents-sessions.mdx` | 기존 | 부분 — 작업대의 '쉬는 중' 줄을 누르면 그 자리에서 다시 띄움(`src/renderer/store/aiWorkbench.ts:22` WorkbenchStatus idle) | 이식 | 2차(작업대가 대부분 대신함) | S | 문제없음 |
| 다른 에이전트로 넘기기(핸드오프) | 이전 대화를 요약 프롬프트로 다른 에이전트 세션에 넘김 | `r/agent-session-continuation/` | 기존 07-22, 9커밋 | 없음 | 이식 | 3차(공급사 간 이동은 사내 제약) | M | 같은 공급사 안에서만 |
| Claude 에이전트 팀 | 팀원별 네이티브 창, 실험 토글 | `s/claude-agent-teams*` | 기존 06-08, 0커밋 | 없음 | 이식 | 3차(Anthropic 실험 기능 의존) | L | 실험 기능 |
| 서브에이전트 자식 줄 | Claude/Codex 의 Task 서브에이전트를 부모 아래 펼침 줄로 | `m/claude/claude-subagent-*.ts`, `s/codex-subagent-identity.ts`, `s/agent-child-row-model.ts` | 신규 09-08(Claude), 10-23(Codex) | 없음 — 작업대의 자식 줄은 워크트리 분리 세션뿐(`src/shared/aiSession.ts:116` childrenOf) | 이식 | 1차(AI-06) 로컬 훅 데이터만 | M | 문제없음 |
| Codex WSL 실행 | Windows 에서 WSL 안 Codex 로 실행·계정 라우팅 | `m/codex-cli/` | 기존 04-11, 10커밋 | 없음 | 이식 | 3차(WSL 계열 — 원격·데몬과 함께 진행) | M | WSL 사내 허용 여부 확인 |
| 컴퓨터 깨어있기 | 항상/에이전트 작업 중에만/끔 — 절전 방지 | `m/agent-awake-service.ts`, `r/settings/AgentAwakeSetting.tsx` | 기존 05-15, 5커밋 | 없음 | 이식 | 2차(작고 독립적) | S | 사내 전원정책과 충돌 가능 |
| 프롬프트 캐시 타이머 | Claude 프롬프트 캐시 만료까지 카운트다운 | `r/settings/AgentCacheTimerSection.tsx` | 기존 06-18 | 없음 | 이식 | 3차(가치 낮음) | S | 문제없음 |
| 에이전트가 정한 탭 제목 | 에이전트가 정한 제목을 탭명으로 | `s/agent-generated-tab-title-rules.ts` | 신규 10-22(규칙 파일 기준) | 부분 — 셸 OSC 제목이 탭명을 덮음(`src/renderer/store/sessions.ts:66` 주석) | 이식 | 2차 | S | 문제없음 |

## 2. 상태 감지 · 훅 · 알림

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 에이전트 상태 훅(작업 중/대기/완료) | CLI별 훅 설치 → 로컬 HTTP 로 상태 보고, endpoint 파일로 재연결 | `m/agent-hooks/`, `m/ipc/agent-hooks.ts`, `sl/agent-status/`, `d/agents/hooks-memory.mdx` | 변경(대폭) 251커밋 | 부분 — Claude 만: 로컬 설치(`src/main/agent/claudeHooks.ts:177`), 원격(`src/main/agent/remoteHooks.ts:66`), 수신(`src/main/agent/AgentHookServer.ts:66`). codex·gemini 훅 없음 | 이식 | 1차(AI-04) 모든 감독 화면의 바탕 | M(CLI당 S) | 원격 훅은 서버 AcceptEnv 또는 tty 파일 폴백 |
| 상태 훅 켜기/끄기 | 설정에서 관리 훅 제거·복원, 재시작 불필요 | `s/agent-status-hooks-setting.ts`, `r/settings/agent-status-hooks-copy.ts` | 기존 05-23 | 부분 — 설정에 훅 상태·포트 표시만, 끄기 없음(`src/renderer/components/SettingsDrawer.tsx:559` AgentHookRow) | 이식 | 1차(AI-04) 훅과 한 묶음 | S | 남의 훅 보존(병합) 규칙 유지 |
| 상태 표시 점(글리프) | 스피너/대기 ?/완료 체크/오류/회색 — 탭·사이드바 공통 | `d/model/agents-sessions.mdx` | 기존 | 있음 — 아라 `StateDot.tsx` 는 **연결 상태만**(on/connecting/lost, `store/sessionState.ts`). AI 상태 점은 작업대 `AiBenchTree.tsx`(`.bench-dot`, `src/shared/agentStatus.ts:22` — `unverifiable` 포함) | 이식 | 1차(AI-11) 상태 훅과 한 묶음 — 아라 것 대신 Orca 것(묶음 2·원칙) | S | `AiBenchTree` 의 상태 점을 대체(`StateDot` 은 연결 점이라 남긴다). 턴 끝 '추정'(AI-05) 표시도 같이 맞춘다 |
| 턴 끝 판정(훅 없는 CLI) | 훅 없는 CLI 는 TUI 가 멎은 것으로 완료 추정 | `m/agent-turn-idle-verdict.ts` | 신규 10-22 | 없음 — 의도적으로 추정 안 함: 못 들으면 `unverifiable`(`src/renderer/store/aiSessions.ts` 머리 주석 F1a) | 이식 | 1차(AI-05) 확정(결정 10) — 화면에 '추정' 상태를 따로 보인다. codex·gemini 상태용 | S | 문제없음 |
| 에이전트 완료 알림 | 시스템 알림+사운드+칩, 카테고리별 사운드, Dock 배지 | `m/notifications/`, `m/ipc/notifications.ts`, `r/notifications/` | 변경(대폭) — 알림 엔진 `m/notifications` 09-10 신설 | 부분 — **대기(질문·권한)만** 알림, 완료·사운드 없음(`src/renderer/store/aiQuietWatch.ts:14,66`) | 이식 | 2차(기본은 있음) | S | 문제없음 |
| 질문/승인 카드 | 에이전트 질문을 카드로 렌더, 제출로 응답 | `m/acp/acp-permission-requests.ts`, `d/agents/native-chat.mdx` | 변경(대폭) — 채팅 UI 일부, ACP 승인은 10-05 | 부분 — 아라 자체 MCP 도구용 카드(`src/main/mcp/askUser.ts`, `approval.ts`, `src/renderer/components/AraChatPanel.tsx:201`) | 이식 | 2차(채팅 UI 와 함께) | M | 문제없음 |
| Hermes/Pi/Droid 등 훅 연동 | CLI별 훅 설정파일 패치·복원 | `m/hermes`, `m/pi`, `m/droid`, `m/mimo` | 변경(대폭) pi 93커밋 | 없음 | 부적합 | —(해외 SaaS) | S(개당) | 해외 SaaS |

## 3. 채팅 UI(에이전트 CLI 세션을 채팅으로) · ACP

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 채팅 UI(구조화 채팅) | 터미널 대신 대화+입력칸으로 에이전트 CLI 를 구동 | `r/native-chat/`, `m/native-chat/`, `m/ipc/native-chat.ts` | 변경(대폭) 740+587커밋(06-28 최초) | 부분 — 아라 채팅(전역)이 Claude CLI stream-json 으로 같은 일을 함(`src/main/ai/engine/ClaudeCliEngine.ts`, `src/renderer/components/AraChatPanel.tsx`). 작업대 세션을 채팅으로 보는 화면은 없음 | 이식 | 1차(AI-12) 묶음 7 — 1차로 당김 | L | 아라 채팅(전역)도 이 엔진으로 옮긴다: 아라 채팅은 그 위의 한 인스턴스(아라 폴더·페르소나), 음성·얼굴·승인(`approval.ts`)·부트스트랩은 위에 얹는 층. 순서: Orca 채팅 1차 → 아라 채팅 전환(2.1 음성 연결부 확인). Claude 세션은 원격 제어가 되는 방식으로 띄운다(묶음 9) |
| ACP 호스트 | ACP 지원 에이전트를 JSON-RPC 로 직접 구동 | `m/acp/` | 신규 10-05, 129커밋 | 없음 | 이식 | 3차(대상 에이전트가 사내 미허용 다수) | L | 외부 에이전트 의존 |
| 터미널 에이전트를 채팅으로 보기 | 실행 중 터미널 에이전트를 대화 기록으로 ↔ 터미널(`Ctrl+Shift+J`) | `src/renderer/src/store/terminals/terminal-chat-pane-layout-owner.ts` | 신규 10-17 | 없음 | 이식 | 1차(AI-13) 채팅 UI 와 한 묶음 | M | 문제없음 |
| 에이전트별 채팅/터미널 기본 선택 | 에이전트마다 채팅/터미널로 열지 지정 | `r/settings/AgentChatChoiceControls.tsx`, `native-chat-provider-choice.ts` | 신규 10-21 | 없음 | 이식 | 1차(AI-14) 채팅 UI 와 한 묶음 | S | 문제없음 |
| 채팅 ↔ 터미널 이어하기 | 대화 복사본으로 반대쪽 새 탭 | `m/acp/acp-conversation-copy.ts` | 신규 10-14 | 없음 | 이식 | 3차 | M | 문제없음 |
| 모델·추론강도·모드 선택 | 설치된 CLI 에서 모델 목록을 읽어 선택 | `m/claude/claude-model-catalog-probe.ts`, `m/acp/acp-model-catalog-probe.ts` | 신규 09-24 | 부분 — 아라 채팅만 모델 선택(`src/main/ai/AraChat.ts:134`, `src/shared/aiModels.ts`) | 이식 | 1차(AI-15) 채팅 UI 와 한 묶음 | S | 문제없음 |
| 슬래시 명령·스킬 목록 | `/` 로 에이전트별 명령·스킬 목록 | `m/claude/claude-slash-command-catalog.ts`, `m/acp/acp-at-rest-commands.ts` | 신규 09-06 | 없음 | 이식 | 1차(AI-16) 채팅 UI 와 한 묶음 | S | 문제없음 |
| 파일·이미지 첨부, 초안 보존 | 첨부·미전송 초안 유지 | `m/native-chat/agent-session-attachments/`, `m/acp/acp-prompt-content.ts` | 신규 10-07 | 부분 — 아라 채팅에 이미지 붙여넣기/드롭 → 파일 저장 후 경로 전달(`src/renderer/components/AraChatPanel.tsx:56`) | 이식 | 1차(AI-17) 아라 채팅 쪽 구현 대신 Orca 것(원칙) | S | DLP: 첨부 경로 확인 |
| 인라인 시각물 | 채팅에 에이전트가 만든 HTML/이미지 인라인 표시 | `r/settings/NativeChatInlineVisualsSetting.tsx` | 신규 10-08 | 없음 | 이식 | 3차 | M | 문제없음 |
| 채팅 이름 자동 생성 | 대화 이름을 AI 로 생성 | `r/settings/ChatNamingSetting.tsx`, `m/text-generation/conversation-name-generation-request.ts` | 신규 10-06 | 부분 — 첫 줄을 제목으로(`src/main/ai/araChats.ts:51` titleOf) | 이식 | 1차(AI-19) 아라 채팅 방식 대신 Orca 것(원칙) | S | 대화 일부가 모델로 전송 |
| 채팅 권한 설정 | 채팅 세션의 도구 승인 정책 | `r/settings/ChatPermissionSetting.tsx`, `s/agent-chat-permission-mode.ts` | 신규 10-12 | 부분 — MCP 승인 게이트(`src/main/mcp/approval.ts`) | 이식 | 1차(AI-18) 채팅 UI 와 함께 | S | Orca 것을 쓰고, 아라 MCP 승인 게이트(`approval.ts`)는 아라 채팅 층에 남긴다 |
| Antigravity 채팅 런타임·로그인 | 채팅용 런타임 다운로드, 로그인 | `m/antigravity/antigravity-chat-sign-in.ts` | 신규 10-18 | 없음 | 부적합 | —(외부 다운로드·계정) | M | 망분리 불가 |
| 원격 Orca 서버 채팅 | 페어링된 서버의 세션을 채팅으로 | `d/agents/native-chat.mdx` | 기존(채팅 UI 일부, 별도 판정 불가) | 없음 | 이식 | 3차(orcad·원격 서버 다음) | L | 운영 서버에 설치할 때 호스트별 사용자 동의·제거 방법 |

## 4. 세션 기록 · 재개 · 잠재우기

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 지난 에이전트 세션 목록 | 18종 CLI 의 디스크 대화 기록 스캔 → 우측 패널 목록 | `m/ai-vault/`, `m/ipc/ai-vault.ts`, `r/right-sidebar/AiVaultPanel.tsx` | 변경(대폭) 177커밋(06-10 최초) | 부분 — 아라 채팅 목록(`src/main/ai/araChats.ts:110`)과 저장된 작업대 목록(`src/renderer/store/aiWorkbench.ts`)뿐, CLI 대화 기록 스캔 없음 | 이식 | 1차(AI-07) 로컬 파일만 | M | 로컬 파일만 읽음 — 적합 |
| 범위·필터·정렬·묶기 | 작업공간/프로젝트/전체, 에이전트 토글, 빈 세션 숨김 | `m/ai-vault/session-scope-*.ts`, `d/agents/session-history.mdx` | 기존(세부 미확인, ai-vault 안) | 없음 | 이식 | 2차 | S | 문제없음 |
| 원클릭 재개 / 재개 명령 복사 | `claude --resume` 등 CLI별 재개 명령을 새 터미널에서 | `s/ai-vault-resume-command.ts`, `m/ipc/ai-vault-resume.ts` | 기존 08-02, 12커밋 | 부분 — Claude 세션 id 로 `--resume`(`src/shared/aiSession.ts:31`) | 이식 | 1차(AI-07) 목록과 한 묶음 | S | 문제없음 |
| 세션 상세·첫 프롬프트 복사 | 첫 프롬프트, 최근 턴, 로그 위치·폴더 열기 | `r/right-sidebar/AiVaultSessionDetails.tsx` | 기존(세부 미확인) | 부분 — 아라 채팅 메시지 읽기(`src/main/ai/araChats.ts:164`) | 이식 | 1차(AI-07) | S | 문제없음 |
| 세션 전문 검색 | 모든 세션 내용을 SQLite 로 색인·검색 | `m/ai-vault-search/`, `m/ipc/ai-vault-search.ts` | 신규 09-10, 62커밋 | 없음 | 이식 | 2차(L. 목록 이식 후) | L | 대화 속 비밀이 색인에 남음 — 마스킹 필요 |
| 세션 삭제 | 세션 기록 파일 삭제 | `m/ai-vault/session-delete.ts`, `m/ipc/ai-vault-delete.ts` | 기존 08-08 | 없음 | 이식 | 2차 | S | 문제없음 |
| 에이전트 잠재우기(하이버네이션) | 완료+안 보임+무입력 N분이면 PTY 종료, 돌아오면 자동 재개 | `src/renderer/src/store/terminals/terminal-pane-hibernation.ts`, `d/agents/hibernation.mdx` | 기존 08-24, 12커밋 | 없음 | 이식 | 3차(사내 사용량이 적어 체감 낮음) | M | 문제없음 |
| 워크트리 수동 재우기 | 워크트리 단위로 재우고 재개 표시 보존 | `m/ipc/worktrees/sleep/`, `m/runtime/workspaces/workspace-sleep-runtime.ts` | 신규 10-21~22 | 없음 | 이식 | 2차(묶음 1 재우기·보관과 같이) | M | 문제없음 |
| 앱 재시작·업데이트 후 에이전트 복원 | 재개 기록으로 같은 세션 재실행 | `m/agent-auth-restart-preservation.ts`, `m/update-restart-preservation.ts` | 기존 06-17(업데이트 복원 10-12 추가) | 부분 — 작업대 목록은 복원되고 Claude 는 `--resume` 로 이어 붙음(`src/shared/aiSession.ts:51` restoreVerdict). PTY 는 앱과 함께 죽음 | 이식 | 2차(Orca 것 — 원칙) | L | 공유(터미널과 같은 구현). PTY 생존은 로컬 데몬(B §3, 1차 DM-01)이 맡는다 |

## 5. 사용량 · 한도 · 통계

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 상태바 사용량·초기화 시각 | 5시간/일/주 사용률, 80% 경고 칩 | `m/rate-limits/`, `m/claude-usage/`, `m/codex-usage/`, `sl/rate-limits.ts` | 변경(대폭) 81커밋(status-bar 166) | 부분 — 아라 채팅 머리 아래 5시간·주간 % 와 초기화까지 남은 시간(`src/renderer/store/araUsage.ts:55`, `AraChatPanel.tsx:506`). 조회는 `claude -p "/usage"`(`src/main/ai/AraChat.ts:60`). 상태바·Codex 없음 | 이식 | 1차(AI-10) Claude·Codex 구독(CLI) 사용량 | M | Orca 방식으로 바꾼다: Claude 는 statusLine `rate_limits` + `~/.claude/.credentials.json` 토큰으로 `api/oauth/usage`, Codex 는 `chatgpt.com/backend-api/wham/usage`. 아라의 `claude -p "/usage"` 실행은 없앤다(묶음 6) |
| 사용량 팝오버(로스터) | 추적 중 모든 프로바이더를 가장 빡빡한 한도순으로 | `r/status-bar/UsageRosterPanel.tsx` | 기존 07-20, 4커밋 | 없음 | 이식 | 1차(AI-10) 상태바와 한 묶음 | S | 문제없음 |
| 여러 프로바이더 사용량 | Gemini·OpenCode·Kimi·MiniMax(쿠키)·Grok·Cursor·Muse·ZCode | `m/opencode-usage`, `m/muse-usage`, `m/minimax`, `r/settings/ZcodePlanAccountsSection.tsx` | 기존(muse-usage 09-22, zcode 10-02 신규) | 없음 | 이식 | 2차(Gemini 만 — Orca 기본 묶음 밖이라 추가. 나머지는 묶음 6 빼기) | M | 쿠키 붙여넣기 방식은 가져오지 않는다 |
| % 사용 / % 남음 표기 | 표시 방향 선택 | `r/settings/appearance-usage-percentage-search.ts` | 기존 07-11 | 없음 | 이식 | 2차 | S | 문제없음 |
| Codex 리셋 크레딧 사용 | 적립된 한도 리셋 크레딧 소비 | `m/rate-limits/codex-credit-balance.ts` | 신규 10-05 | 없음 | 부적합 | —(개인 계정 기능) | S | 사내 계정 하나라 무의미 |
| 통계 페이지(토큰·비용) | 로컬 기록 스캔 → 일별 차트·세션표·추정 비용 | `r/stats/`, `m/usage/`, `m/stats/`, `sl/stats.ts` | 기존 04-09, 16커밋(m/usage 24) | 부분 — 이번 대화의 토큰·추정 비용만(`src/renderer/store/araUsage.ts:10,30`), 입력 예산(`src/main/ai/budget.ts:52`) | 이식 | 2차 | M | 로컬 스캔 — 적합. 단가표는 비공식 |
| 사용량 공유 카드 | 사용량을 이미지 카드로 공유 | `r/stats/ShareUsageCard.tsx` | 기존 | 없음 | 부적합 | —(SNS 공유) | S | 사내 불필요 |
| 컨텍스트 사용량 표시 | 세션 컨텍스트 창 소모율 | `s/agent-session-context-usage.ts`, `m/claude/claude-context-usage.ts` | 신규 09-24 | 부분 — 아라 채팅의 `ctx` 칸(`src/renderer/store/araUsage.ts:46,53`). 작업대 세션엔 없음 | 이식 | 2차 | S | 문제없음 |

## 6. 계정 전환

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| Claude 계정 여러 개·원클릭 전환 | 상태바에서 활성 계정 교체, 계정별 사용량 | `m/claude-accounts/` | 변경(대폭) 54커밋 | 없음 | 이식 | 2차(묶음 6) | M | 계정별 사용량 포함 |
| Codex 계정 여러 개·격리 홈 | 계정별 `CODEX_HOME` | `m/codex-accounts/` | 변경(대폭) 72커밋 | 없음 | 이식 | 2차(묶음 6) | M | 계정별 `CODEX_HOME` |
| Cursor/Grok/Antigravity/ZCode 계정 | 프로바이더별 계정 섹션 | `m/cursor-accounts`, `m/grok-accounts`, `r/settings/{Cursor,Grok,Antigravity,ZcodePlan}AccountsSection.tsx` | 신규(cursor 09-25, antigravity·zcode 10-02) / grok 기존 | 없음 | 부적합 | — | S | 상동 |
| 관리 데이터 계정(일반화) | 임의 에이전트의 자격증명 캡처·프로필별 실행 환경 | `m/managed-data-accounts/` | 신규 10-03 | 없음 | 이식 | 3차(묶음 6) | M | 자격증명 사본 보관 — 보안 검토 |
| 헤드리스 계정 추가 | 서버에서 `claude login` 후 등록 | `d/cli/reference.mdx` §Account | 기존 | 없음 | 이식 | 3차(원격 서버 계열) | S | 원격 서버에 사내 계정으로 로그인. 운영 서버에 설치할 때 호스트별 사용자 동의·제거 방법 |

## 7. 자동화(예약 실행)

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 예약 자동화 만들기·관리 | 프롬프트+에이전트+대상+트리거(cron·RRULE·타임존) | `m/automations/`, `r/automations/`, `m/ipc/automations.ts` | 변경(대폭) 55+97커밋 | 없음 | 이식 | 2차(묶음 10 — 3차에서 당김) | L | 사내 승인·감사 필요 |
| 사전 점검(Precheck) | 셸 명령 성공 시에만 진행 | `m/automations/precheck-runner.ts` | 기존 05-29 | 없음 | 이식 | 2차(자동화와 함께) | S | 문제없음 |
| 세션 재사용 / 추가 인자 | 이전 자동화 터미널 이어쓰기, 모델·effort·`--add-dir` 만 허용 | `src/cli/index-automation-extra-agent-args.test.ts` | 신규 10-08(추가 인자) | 없음 | 이식 | 2차(자동화와 함께) | S | 권한 옵션 차단 설계 — 참고할 만함 |
| 실행 이력·지금 실행·재실행 | 이력 페이징, 수동 실행, 재실행 | `src/cli/automation-runs-paging.ts` | 기존(페이징 파일만 10-15) | 없음 | 이식 | 2차(자동화와 함께) | M | 문제없음 |
| 여러 호스트 자동화 표·필터 | 호스트·상태·결과·에이전트 필터 | `r/automations/` | 변경(대폭) 97커밋 | 없음 | 이식 | 3차(자동화·원격 서버 다음) | M | 원격 호스트 허용(결정 5) |

## 8. 오케스트레이션(에이전트끼리)

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| Run/Task/Dispatch 모델 | 코디네이터 Run, 태스크 DAG, 디스패치 생명주기(실험) | `m/runtime/orchestration/`, `d/cli/orchestration.mdx` | 변경(대폭) 167커밋 | 없음 | 이식 | 3차(실험 단계·L) | L | 로컬 런타임 — 적합 |
| 감독 워커 | 워커를 새 자식 워크트리에 띄우고 모델 지정, 완료 후 정리 | `src/cli/orchestration-*.ts` | 변경(대폭)(05-04 최초, 파일 절반 신규) | 부분 — 세션 분리(워크트리)는 UI(`src/renderer/components/Shell.tsx:759`)와 MCP `git.worktree.add`(`src/main/mcp/tools.ts:653`)로 있음, 감독 없음 | 이식 | 3차 | L | 문제없음 |
| 메일함·그룹 주소·heartbeat | `@all/@idle` 그룹 메시지, `worker_done` | `d/cli/orchestration.mdx` | 기존 | 없음 | 이식 | 3차 | M | 문제없음 |
| 묻기 / 결정 게이트 | 워커→코디네이터 질문, 게이트로 태스크 차단 | `d/cli/orchestration.mdx` | 기존 | 부분 — MCP `ask_user`(사람에게 질문, `src/main/mcp/askUser.ts`) | 이식 | 3차 | M | 문제없음 |
| 터미널 안 task_ 링크 | 태스크 ID 클릭 시 담당 터미널로 | `d/cli/orchestration.mdx` | 기존 | 없음 | 이식 | 3차 | S | 문제없음 |
| 원격 연합 워커(`--on`) | 다른 호스트에 워커 배치 | `m/runtime/rpc/methods/orchestration/federation/` | 변경(대폭) — rpc 29파일 09-06 신설(db 쪽은 08-16) | 없음 | 이식 | 3차(오케스트레이션·orcad 다음) | L | 원격 호스트 허용(결정 5). 운영 서버에 설치할 때 호스트별 사용자 동의·제거 방법 |
| 워크트리 진행 메모·상태 | 에이전트가 `orca worktree set --comment` 로 진행 기록 | `d/cli/worktree-checkpoints.mdx` | 기존 | 없음 | 이식 | 3차 | S | 문제없음 |

## 9. 스킬 · 플러그인 · MCP

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 번들 스킬 설치 | 에이전트 스킬 폴더에 가이드 설치, 버전 맞춤 | `m/skills/`, `src/cli/bundled-skill-guides.ts` | 변경(대폭) 74커밋(가이드 81) | 없음 | 이식 | 2차(아라 MCP 사용법 스킬 배포에 유용) | S | `orca skills install` 은 오프라인 가능 |
| 스킬 업데이트 계획·검토 | 변경/보존 계획을 보여주고 승인한 대로만 씀 | `m/skills/`, `d/cli/skills.mdx` | 변경(대폭)(skills 안) | 없음 | 이식 | 2차 | M | 오프라인 — 적합 |
| 스킬 페이지(스캔·삭제) | 설치된 스킬 탐색, 일괄 삭제 | `r/skills/` | 변경(대폭) 46커밋 | 없음 | 이식 | 2차(묶음 10 — 3차에서 당김) | M | 문제없음 |
| 스킬 공유 링크 | 스킬 묶음을 Orca 계정으로 비공개 링크 발행 | `r/settings/ShareSkillsSettingsPane.tsx`, `s/agent-skill-sharing-gate.ts` | 기존 08-16 | 없음 | 부적합 | —(Orca 클라우드 업로드) | M | 사내 부적합 |
| 플러그인 시스템(알파) | 마켓플레이스(git) → 동의 후 활성, 패널·명령·언어팩 | `m/plugins/`, `r/plugins/` | 변경(대폭) 55커밋(화면 폴더는 10-28 신규) | 없음 | 이식 | 3차(묶음 13 — 사내 승인 플러그인만. 묶음 0 "기능 끼우는 틀"과 구조를 맞춘다) | L | 반입 통제: 사내 승인 플러그인만 |
| MCP 서버 등록 | 설정에서 MCP 엔드포인트 등록 | `d/settings.mdx` §Integrations | 기존 | 있음(다른 방향) — 아라 자체 MCP 서버·승인·감사로그(`src/main/mcp/McpServer.ts`, `approval.ts`, `auditLog.ts`) | 이식 | 2차(Orca 것 — 묶음 10) | S | 아라 자체 MCP 서버·승인·감사로그는 그대로 둔다 |

## 10. `orca` CLI

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| CLI 등록·상태 | PATH 등록, `orca status` | `d/cli/overview.mdx` | 기존 | 대체 — 아라 MCP(`src/main/mcp/tools.ts`) | 유지 | —(MCP 로 대체, 안 가져옴) | S | — |
| worktree 명령 | ps/create/current/set/rm | `src/cli/handlers/` | 변경(대폭) src/cli 342커밋 | 부분 — MCP `git.worktree.add/remove`(`src/main/mcp/tools.ts:653`), 화면의 세션 분리(`Shell.tsx:759`) | 유지 | — | M | 문제없음 |
| terminal 명령 | list/read/send/wait/create/split/close | `src/cli/handlers/` | 변경(대폭)(src/cli 안) | 부분 — 아라 MCP 터미널 도구(`src/main/mcp/tools.ts`) | 유지 | — | M | 문제없음 |
| file 명령 | 파일·diff 를 탭으로 | `d/cli/overview.mdx` | 기존 | 없음 | 유지 | 3차(MCP 도구 하나로 충분) | S | 문제없음 |
| 내장 브라우저 자동화 | goto/snapshot/click/fill/screenshot | `src/cli/browser-*.ts` | 기존 | 부분 — `BrowserService`·`src/renderer/components/BrowserWindow.tsx` | 유지 | — | M | ai-browser(`D:\AI\ai-browser`)가 설치돼 있으면 에이전트가 MCP 로 그것을 쓰고, 없으면 지금처럼 내장 브라우저. ai-browser 쪽 MCP 서버가 아직 없다(그 세션에 요청) |
| 데스크톱 컴퓨터 조작 | 접근성 트리로 데스크톱 앱 조작 | `m/computer/` | 기존 05-11, 24커밋 | 없음 | 이식 | 3차(묶음 13 — 기본 꺼짐, 켤 때 확인) | L | 자기 창 제외 조건 필수 |
| 에뮬레이터 제어 | iOS Simulator / Android adb | `m/emulator/` | 기존 06-08, 29커밋 | 없음 | 보류 | —(모바일, 사내 업무 무관) | M | — |
| Linear/Jira 명령 | 티켓 읽기·쓰기 | `src/cli/linear-*`, `jira-*`, `m/jira` | 기존 | 없음 | 부적합 | —(묶음 11 빼기) | M | 외부 SaaS |
| 아티팩트 공유 | HTML/MD 를 공개 링크로 발행 | `m/artifacts/` | 기존 08-07, 13커밋 | 없음 | 부적합 | —(공개 업로드) | S | 사내 금지 대상 |
| 명령 제안·오류 복구 문구 | 오타 시 명령 추천 | `src/cli/command-suggestion.ts` | 기존 07-10 | 없음 | 유지 | —(CLI 없음) | S | — |
| 플러그인 저작 CLI | 플러그인 스캐폴드·검사 | `src/cli/plugin-authoring/` | 신규 10-30 | 없음 | 이식 | 3차(플러그인 시스템과 함께 — 묶음 13) | M | 사내 승인 플러그인만 |

## 11. 음성 받아쓰기

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 음성 받아쓰기(토글/누르고 있기) | 단축키로 듣기 → 입력칸에 글자 | `m/speech/`, `r/dictation/`, `sl/dictation.ts` | 기존 05-14, 20커밋 | 없음(받아쓰기) — 음성 얼굴은 아라 전역 기능 | 전역 겹침 | —(음성은 전역 기능 쪽에서) | M | 마이크 권한·녹음 정책 |
| 온디바이스 음성인식 모델 받기 | Parakeet/Zipformer(한국어 포함)/SenseVoice/Whisper | `m/speech/model-catalog.ts` | 기존 | 없음 | 전역 겹침 | —(필요하면 음성 쪽에서 참고) | M | 모델 다운로드 → 사내 미러 |
| 클라우드 음성인식(OpenAI) | GPT-4o 전사, API 키 | `m/speech/openai-transcription-client.ts` | 기존 06-07 | 없음 | 부적합 | —(음성 외부 전송) | S | 부적합 |
| 마이크 장치 선택 | 입력 장치 지정, 없으면 기본값 | `r/settings/VoiceMicrophoneSetting.tsx` | 기존 08-03 | 없음 | 전역 겹침 | — | S | 문제없음 |

## 12. 글 생성(AI 보조)

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 커밋 메시지·PR 본문·브랜치명 생성 | 로컬 에이전트 CLI 로 생성, 저장소별 에이전트·모델 지정 | `m/text-generation/`, `r/settings/SourceControlActionAgentPicker.tsx` | 변경(대폭) 49커밋(에이전트 고르기 10-26 추가) | 없음 | 이식 | 2차(아라 채팅의 Claude CLI 엔진 재사용 가능) | M | diff 가 모델로 전송 — 허용 모델만 |
| 브랜치 자동 개명 | 작업 시작 후 내용 기반 이름으로 | `d/settings.mdx` §Git | 기존 | 없음 | 이식 | 3차 | S | 상동 |
| Jira 이슈 요약 | 티켓 요약 생성 | `m/text-generation/jira-*.ts` | 신규 10-14 | 없음 | 부적합 | —(묶음 11 빼기) | S | — |

## 13. 활동 · 대시보드 · 기타 감독 화면

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 활동 피드 | 모든 워크트리의 완료·차단·응답 미리보기 피드, 안 읽음 배지 | `r/activity/`, `sl/ui/ui-slice-activity-actions.ts`, `d/activity.mdx` | 변경(대폭) 72커밋 | 없음 | 이식 | 1차(AI-09) 훅 데이터 재사용 | M | 문제없음 |
| 에이전트 대시보드(상태별 보드) | 나를 기다림/작업 중/완료/쉼, 검색·필터, 팝아웃 | `r/dashboard/`, `r/dashboard-popout/` | 변경(대폭) 78+49커밋 | 부분 — 사이드바 [AI] 작업대가 대기/작업 중/완료/확인 불가/쉬는 중으로 묶음(`src/renderer/store/aiWorkbench.ts:215`, `src/renderer/components/AiBenchTree.tsx`). 보드·팝아웃·필터 없음 | 이식 | 1차(AI-08) 작업 공간의 본문 화면 | M | 문제없음 |
| 펫 오버레이 | 에이전트 상태에 반응하는 캐릭터(실험) | `r/pet/` | 기존 05-01, 12커밋 | 없음 — 음성 얼굴이 비슷한 자리 | 이식 | 3차(묶음 13 넣기 — 차수가 없어 3차로 둠) | S | 묶음 2 의 빼기를 묶음 13 이 뒤집었다. 아라 얼굴과 자리가 겹치는 점은 설계 때 |
| 자원 관리자(메모리) | 프로세스·PTY 별 CPU/메모리 — 에이전트 기억 아님 | `m/memory/`, `sl/memory.ts` | 기존 04-26, 19커밋 | 부분 — 서버 측 `src/renderer/components/SysMonitorPanel.tsx` | 이식 | 1차(FD-01, 기반 — 묶음 0) | M | 에이전트·터미널별 메모리/CPU 상한(Windows Job Object·macOS)을 여기에 붙인다(묶음 13 → 0) |
| 에이전트 메모리 파일(CLAUDE.md 등) | 별도 기능 없음 — 파일 편집만 | `d/agents/hooks-memory.mdx` | 기존 | 있음(동등) — 편집기(`src/renderer/components/EditorWindow.tsx`) | 유지 | — | S | 문제없음 |
| Slack 커넥터(외부 대화) | Slack 에서 시작한 대화로 에이전트 실행, Orca Cloud 경유 | `m/connector-cloud/`, `m/external-conversations/` | 신규 10-22~26 | 없음 | 이식 | 2차(묶음 13 — 사내 Slack 앱을 Orca 커넥터 이음새에) | L | Socket Mode(나가는 연결만)를 `src/cli/specs/connector.ts`(시작·이어 지시·승인/질문 응답·취소·턴 결과)에 붙인다. Orca Cloud 안 씀. Slack 관리자 승인 필요, 출력이 Slack 에 남는다 |

## 집계

- 행 수 99(지난 판과 같은 행 구성).
- 8-28 이후: **신규 27** / 변경(대폭) 23 / 기존 49.
- 분류(v4): 이식 77 / 유지 7 / 전역 겹침 3 / 부적합 11 / 보류 1.
- 우선순위(v4): 1차 26행(portmap AI-01~19 · FD-01) / 2차 26 / 3차 26 / — 21.

## 변경 요약(지난 판 대비)

- **v4**(묶음별 결정): 32행을 고쳤다(분류 이동 14). 채팅 화면 8행을 1차로 당겼고(묶음 7), 상태 표시 점·첨부·채팅 이름·에이전트 복원·MCP 등록은 원칙("AI 기능은 Orca 를 따라간다")에 따라 Orca 것으로 바꿨다. 자원 관리자는 기반 1차(묶음 0)다. 계정 여러 개·Gemini 사용량·관리 데이터 계정(묶음 6), 자동화 4행·스킬 관리 화면(묶음 10), Slack(사내 Slack 앱, 묶음 13)을 넣었고 플러그인 2행·펫도 넣기로 바꿨다(묶음 13). 사용량 조회는 Orca 방식으로 바꾼다(묶음 6). 남은 보류는 에뮬레이터 제어 1행이다.
- **v3**: 보류 5행(Codex WSL·원격 Orca 서버 채팅·헤드리스 계정·여러 호스트 자동화·원격 연합 워커)을 이식 3차로 옮겼다(결정 5·6). 턴 끝 판정은 1차 확정(결정 10). 에이전트 복원 메모에 "공유", 내장 브라우저 자동화 메모에 ai-browser 를 적었다. 남은 보류 3행은 플러그인 2행(반입 통제)과 에뮬레이터 제어(업무 무관)다.
- 아래는 v2 기록이다.

- **신규 12 → 27.** 얕은 클론 때는 그날 생긴 폴더를 모두 "기존"으로 봤다. 전체 이력으로 보니 채팅 UI 세부(모델 선택 09-24·슬래시 09-06·첨부 10-07·채팅/터미널 선택 10-21·이어하기 10-14·채팅 권한 10-12·채팅으로 보기 10-17·Antigravity 로그인 10-18), 서브에이전트 자식 줄(09-08), 턴 끝 판정(10-22), 워크트리 재우기(10-21), Codex 크레딧(10-05), 컨텍스트 사용량(09-24), Jira 요약(10-14), 탭 제목 규칙(10-22) 등이 8-28 이후에 생겼다.
- 반대로 지난 판 "변경(대폭)" 중 **핸드오프(9커밋)**는 기존으로 내렸다. "기존"으로 보던 **채팅 UI 본체**는 06-28 최초라 변경(대폭) 그대로다.
- **아라 판정 정정 5건**(판정 자체가 바뀐 것):
  1. 에이전트 대시보드 없음 → **부분**: 사이드바 [AI] 작업대가 이미 상태별 묶음을 한다(`aiWorkbench.ts:215`).
  2. 재시작 칩 없음 → **부분**: 작업대의 '쉬는 중' 줄을 누르면 다시 뜬다.
  3. 상태 훅 켜기/끄기 없음 → **부분**: 설정에 상태 표시는 있다(`SettingsDrawer.tsx:559`). 끄기는 없다.
  4. 턴 끝 판정 부분 → **없음**: F1a 이후 아라는 침묵으로 추정하지 않고 `unverifiable` 로 둔다(`aiQuietWatch.ts:14`).
  5. 에이전트 완료 알림 있음 → **부분**: 알림은 `waiting`(질문·권한)에만 뜨고 완료·사운드는 없다.
- 근거만 고친 행: 사용량(아라는 `claude -p "/usage"` 로 조회, `AraChat.ts:60`), 컨텍스트(`araUsage.ts` ctx 칸), 첨부(이미지 붙여넣기는 이미 됨, `AraChatPanel.tsx:56`), 지난 세션 목록(작업대 목록도 있음), worktree(UI 세션 분리 `Shell.tsx:759`).

## 불확실한 점

- "신규" 판정은 **파일 추가 기록** 기준이다. 이름을 바꾸거나 옮긴 파일은 추가로 잡힌다. 예를 들어 `sl/agent-status/`(10-25)는 옮겨진 것으로 보여 판정에 쓰지 않았다. 탭 제목 규칙(10-22)과 턴 끝 판정(10-22)도 같은 위험이 있다. 그 전에 다른 이름으로 비슷한 로직이 있었는지 확인하지 않았다.
- 채팅 UI 세부 기능(모델·슬래시·첨부)은 "그 기능의 대표 파일 최초 추가일"로 신규를 붙였다. 06-28 부터 있던 `native-chat` 안에 더 이른 형태가 있었을 수 있다.
- `AgentCacheTimerSection.tsx` 는 adds.txt 에 없어서 `git log` 로 날짜(06-18)를 확인했다. 다른 행에도 같은 누락이 있을 수 있다.
- 범위·필터, 세션 상세 행은 ai-vault 폴더 안의 세부라 "기존(세부 미확인)"으로 두었다.
- 1차의 "턴 끝 판정"은 아라의 원칙("모르면 모른다고 한다")과 부딪친다. 준영님이 1차로 확정했고(결정 10) '추정' 상태를 따로 보인다. 화면에서 '추정'과 확인된 '완료'가 어떻게 구별될지는 설계 때 정한다.
- 사용량(AI-10)의 Orca 구현은 `api.anthropic.com/api/oauth/usage` 를 직접 부른다. 아라는 `/usage` 슬래시 명령을 쓴다. v3 는 아라 방식을 유지한다는 가정이었지만, v4 는 묶음 6 결정대로 Orca 방식(statusLine `rate_limits` + CLI 로그인 토큰으로 `api/oauth/usage`, Codex 는 `wham/usage`)으로 바꾼다.
- portmap 경로 76개는 모두 `git ls-tree 7a7f46f8a3` 로 존재를 확인했다. 다만 Orca 의 `src/shared` 는 평평한 파일 묶음(`agent-status-child-work-*.ts` 수십 개 등)이라 대표 파일만 넣었다. 모니터링이 형제 파일 변화를 놓칠 수 있으니 glob pathspec(`:(glob)src/shared/agent-status-*`)을 쓰는 것도 검토할 만하다.

---

# B. 워크스페이스·터미널·원격·에디터·리뷰·연동·브라우저·앱 셸 기능 목록


- 대상: D:\orca HEAD `7a7f46f8a3`(2026-10-31). 읽기 전용(빌드·실행 안 함). 아라: D:\AI\OFA master `a0a024e`(2.0.0)
- 제외: AI 에이전트 자체(native-chat·계정·사용량·AI Vault·hibernation)·모바일·`orca` CLI → 다른 담당
- 경로 약어: `D/` = `docs/site/content/docs/`, `M/` = `src/main/`, `R/` = `src/renderer/src/components/`. 아라 경로는 `D:\AI\OFA\src\` 기준
- **8-28 이후**(전체 이력 기준 — 저장소 첫 커밋 2026-03-16): `firstadd.cjs` 로 핵심 경로 최초 추가일 + `git log 94e75866..7a7f46f8a3 -- <경로> | wc -l`
  - **신규** = 핵심 파일/폴더 최초 추가가 8-28 이후 · **변경(대폭)** = 8-28 이전부터 있었고 30커밋 이상이거나 눈에 보이는 동작이 바뀜 · **변경** = 동작 추가가 있지만 작음 · **기존** = 그 외
- **아라 현황**: 코드를 열어 확인. `있음` / `부분 — 있는 것 / 빠진 것` / `없음`. ✎ = 지난 판에서 판정을 고친 행
- **분류**(하나만): `AI 작업 공간으로 이식` / `터미널(서버) 쪽에 이미 있음·유지` / `터미널 개선`(터미널(서버) 쪽에 새로 넣을 것) / `전역 기능과 겹침`(음성·아라 채팅 — 이식 안 하거나 연결만) / `사내 부적합`(클라우드·계정·외부 SaaS, 자체 대체 불가) / `보류`(필요 없음)
  - v3: 아라에 없는 **터미널·브라우저·앱 안정성 일반 기능**과 macOS 대응은 `터미널 개선`으로 뺐다(결정 7·12). 원격·데몬·WSL 은 `AI 작업 공간으로 이식`이다(결정 5·6)
- **우선순위**: `1차`(외부 의존 없음·가치 큼) / `2차` / `3차` / `—`(이식 안 함)
- **난이도**: 아라에 이식할 때. S(며칠) / M(1~3주) / L(한 달 이상 또는 구조 변경)

---

## 1. 워크트리·워크스페이스

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 워크트리 = 작업 단위 | 작업마다 `git worktree` 로 따로 체크아웃·브랜치·터미널을 묶고, 지우면 폴더와 브랜치를 함께 지운다 | `M/git/`, `M/ipc/worktrees/`, `R/worktree-creation/`, `store/slices/worktrees/` | 변경(대폭) — `M/git` 195커밋, `M/ipc/worktrees` 134커밋 | 부분 — `git worktree add/remove` 만(`shared/gitWorktree.ts:27`, `main/util/localGit.ts:6`, 원격 `renderer/components/Shell.tsx:769`), AI 벤치 "세션 분리"로만 진입 / 목록·전환·삭제 UI, 워크트리별 탭 묶음 없음 | AI 작업 공간으로 이식 | 1차(AI 작업 공간의 뼈대, git 만 쓴다) | L | 사내 GitLab 저장소에 그대로 쓴다. 워크트리 없이 열린 폴더에서 바로 돌리는 선택지도 둔다(무거운 저장소용, 묶음 1) |
| 새 워크스페이스 만들기 | 프로젝트·실행 위치·에이전트 선택, 브랜치명·부모 워크스페이스, 작업 링크 | `R/NewWorkspaceComposerCard.tsx`, `R/new-workspace/` | 변경(대폭) — 63커밋, 103파일 중 48개 신규(기준 브랜치 피커 9-18, 생성 중 채팅 열기 10-31) | 없음 — 이름 한 칸 입력 대화상자뿐(`Shell.tsx:780` splitBench) | AI 작업 공간으로 이식 | 1차(작업 생성 입구. 외부 작업 링크만 빼면 의존 없음) | M | GH/Linear 링크 칸은 뺀다 |
| 백그라운드 생성·진행 표시 | 창을 바로 닫고 fetch/`worktree add` 는 뒤에서, 사이드바에 진행 행 | `R/worktree-creation/` | 기존 — 6-08 최초, 4커밋(체크아웃 진행률 10-15) | 없음 | AI 작업 공간으로 이식 | 1차(만들기와 한 묶음) | S | 큰 사내 저장소에서 체감이 크다 |
| 분기 지점 고르기(Start-from) | 기준 ref·로컬 브랜치·커밋·원격 브랜치에서 분기 | `R/new-workspace/ComposerBaseRefPicker.tsx` | 기존 | 없음 — 현재 HEAD 에서만 분기(`main/util/localGit.ts`) | AI 작업 공간으로 이식 | 1차(만들기와 한 묶음) | S | — |
| 공유 경로·`.worktreeinclude` | gitignore 된 `node_modules`·`.env` 를 새 워크트리에 링크/복사 | `D/model/orca-yaml.mdx`, `M/ipc/worktree-include-copy-budget.ts` | 기존 | 없음 | AI 작업 공간으로 이식 | 2차(Orca 기본값 그대로 — 묶음 5·원칙) | S | `.env` 복사 포함 Orca 기본값 |
| 저장소 설정 `orca.yaml` | setup/archive 스크립트·기본 탭·공유 폴더를 저장소에 체크인 | `D/model/orca-yaml.mdx` | 기존 | 없음 | AI 작업 공간으로 이식 | 3차(저장소 스크립트 자동 실행 → 신뢰 경계 설계 먼저) | M | — |
| 이모지 워크스페이스 이름 | `:rocket:` 단축코드 자동완성 | `R/workspace-emoji/` | 기존 — 1커밋 | 없음 | 보류 | —(묶음 1 빼기) | S | — |
| 브랜치 자동 이름 | 이름·이슈에서 브랜치명을 만들고, 에이전트가 일을 시작하면 기본 이름을 바꾼다 | `D/model/worktrees.mdx#naming-the-branch` | 기존 | 부분 — `ara/<이름>` 고정(`shared/gitWorktree.ts:34` branchFor) / 자동 이름·바꾸기 없음 | AI 작업 공간으로 이식 | 2차 | S | — |
| 워크스페이스 사이드바(그룹·필터·핀) | 프로젝트별 그룹, 호스트/프로젝트 필터, 숨김 토글, 핀, 인라인 이름 변경, 정렬 | `R/sidebar/` | 변경(대폭) — 527커밋 | 부분 — 서버 접속 트리·그룹(`ConnTree.tsx`, `store/groups.ts`), AI 세션 트리(`AiBenchTree.tsx`) / 워크스페이스 목록·필터·핀 없음 | AI 작업 공간으로 이식 | 1차(AI 작업 공간의 목록 화면) | M | — |
| 중첩(자식) 워크스페이스 | 부모 아래 "N children", 자손까지 재우기/삭제 | `D/model/worktrees.mdx#sidebar-layout` | 기존 | 없음 | AI 작업 공간으로 이식 | 3차 | M | — |
| 재우기(Sleep)·보관 | 안 쓰는 워크스페이스의 패널을 닫고 숨긴다 | `R/sidebar/`, `feat(sidebar): main runs workspace sleep`(10-22) | 변경 — 8-28 에 이미 있었고 main 이 맡도록 바뀜 | 없음 | AI 작업 공간으로 이식 | 2차 | S | — |
| 프로젝트 그룹·폴더 워크스페이스 | 하위 저장소 여럿인 상위 폴더를 한 그룹으로, 폴더 수준 워크스페이스 | `M/project-groups/`, `R/right-sidebar/FolderWorkspace*.tsx` | 기존 — 5-27 최초, 12커밋 | 부분 — 작업 프로필(서버+폴더 북마크, `store/workProfiles.ts:1`, `WorkProfileModal.tsx`) / 저장소 묶음 없음 | AI 작업 공간으로 이식 | 2차 | M | — |
| 외부 워크트리 감지 | 손이나 Claude Code 가 만든 워크트리를 "숨은 워크트리"로 보여 준다 | `D/model/worktrees.mdx#using-plain-git` | 기존 | 없음 | AI 작업 공간으로 이식 | 2차(사내에서도 Claude Code 워크트리가 흔하다) | S | — |
| 워크스페이스 정리(Resource Manager) | 로컬·원격 워크스페이스 검색·정렬·일괄 삭제, git 증거로 위험 표시 | `R/workspace-cleanup/` | 변경 — 26커밋 | 없음 | AI 작업 공간으로 이식 | 3차 | M | — |
| 보존 브랜치 검토 | 일괄 삭제 때 git 이 거부한 미병합 브랜치를 토스트로 | `D/model/worktrees.mdx#preserved-branches` | 기존 | 없음 | AI 작업 공간으로 이식 | 2차(삭제 UI와 함께) | S | — |
| 워크스페이스 디스크 사용량 | 워크트리별 디스크 사용량 스캔·정리 패널 | `R/workspace-space/` | 기존 — 6커밋 | ✎ 없음 — `DiskTable.tsx` 는 서버 디스크 표라 별개 | AI 작업 공간으로 이식 | 3차 | S | — |
| Sparse checkout 프리셋 | 폴더를 골라 sparse 프리셋 저장, 워크트리 생성에 적용 | `R/sparse/` | 기존 — 5커밋 | 없음 | AI 작업 공간으로 이식 | 3차 | M | 대형 모노레포가 있을 때만 |
| 워크트리 체크포인트 | 카드에 자유 메모와 상태(todo/진행/리뷰/완료), 에이전트가 갱신 | `D/cli/worktree-checkpoints.mdx` | 기존 | 없음 | AI 작업 공간으로 이식 | 2차 | S | — |
| 워크트리 삭제 단축키 | 마우스 올린 워크스페이스를 단축키로 삭제(확인) | Settings→Shortcuts | 기존 | 없음 | AI 작업 공간으로 이식 | 2차(삭제 UI와 함께) | S | — |

## 2. 탭·팬·분할·세션 복원·탐색

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 탭 그룹·드래그 분할 | 탭을 가장자리로 끌어 좌우/상하 중첩 분할, 터미널·diff·브라우저 혼합 | `R/tab-group/`, `R/tab-bar/` | 변경(대폭) — tab-bar 215커밋, tab-group 76커밋 | 있음 — `PaneGrid.tsx`·`TermTabbar.tsx`·`store/layout.ts`·`store/tabDetach.ts`(최대 4칸 그리드) | 터미널(서버) 쪽에 이미 있음·유지 | —(AI 작업 공간은 이 틀을 재사용) | — | — |
| 분할 비율 유지 | 창 크기가 바뀌어도 분할선 위치를 워크트리별로 유지 | `D/model/tabs-panes-splits.mdx#pinned-boundaries` | 기존 | 부분 — 비율 저장(`store/layout.ts:41` colRatio/rowRatio) / 워크트리 단위 아님 | 터미널(서버) 쪽에 이미 있음·유지 | — | S | — |
| 탭 전환 단축키 체계 | 유형별 다음/이전, `Ctrl+Tab` 최근 탭, 좌/우 탭 닫기 | `D/model/tabs-panes-splits.mdx#switching-tabs` | 기존 | 부분 — 다음/이전·번호 이동(`shared/keymap.ts` tab.next/prev/byNumber) / 최근 순·유형별·좌우 닫기 없음 | 터미널(서버) 쪽에 이미 있음·유지 | 3차 | S | — |
| 세션 복원 | 다시 켜면 워크트리·분할·스크롤백·포커스 탭 복원, 데몬이 있으면 프로세스도 생존 | `M/persistence/` | 변경(대폭) — 388커밋 | 부분 — 레이아웃·탭 순서·SSH 재접속(`store/restore.ts:29`, `MainArea.tsx:363`) / 스크롤백·프로세스 생존 없음 | AI 작업 공간으로 이식 | 2차(워크트리·탭 복원. 프로세스 생존은 로컬 데몬과 함께) | M | 공유(터미널과 같은 구현) |
| 완전 종료(Quit Completely) | 모든 세션을 끝내고 종료 vs 세션을 살려 둔 채 종료 | `M/menu/`, `feat(quit)`(#32153) | ✎ 신규 — 10-27 최초 | 없음 — 데몬이 없어 지금은 구분 의미 없음 | AI 작업 공간으로 이식 | 3차(로컬 데몬과 한 묶음) | S | — |
| 파일 빠른 열기(Quick Open, Cmd-P) | 워크트리 범위 파일 검색, 최근성+점수 순위, 번들 ripgrep | `R/QuickOpen.tsx`, `R/quick-open-*.ts`, `M/ripgrep/` | 변경 — ripgrep 신규(9-24, 17커밋) | ✎ 없음 — F1 통합 검색(`store/palette.ts:57`)은 세션·액션·명령·프로필만, 파일 검색 없음 | AI 작업 공간으로 이식 | 1차(AI 결과 파일을 찾는 기본 동선) | M | ripgrep 바이너리 동봉은 배포 승인 항목 |
| 새 탭 옴니박스 | `+` 에서 탭·파일·URL·에이전트를 한 칸으로 검색 | `D/model/quick-open.mdx#new-tab-omnibox` | 기존 | 없음 | AI 작업 공간으로 이식 | 3차 | S | 검색엔진 기본값은 사내 포털로 |
| 워크트리 점프(Cmd-J) | 워크트리·열린 탭·최근 채팅·프로젝트·PR/MR 번호로 이동, 없으면 생성 | `R/WorktreeJumpPalette.tsx`, `R/cmd-j/` | 변경(대폭) — cmd-j 53커밋 | 부분 — F1 통합 검색(`store/palette.ts:57`) 세션·작업 프로필 / 워크트리 점프 없음 | AI 작업 공간으로 이식 | 2차 | M | — |
| 탭 호버 카드·탭 색/이름/고정 | 탭 미리보기 카드, 이름 변경·색·핀 | `R/tab-bar/TabHoverCard.tsx`, `feat(layout)`(10-16) | ✎ 신규 — 호버 카드 10-09 최초 | 부분 — 탭 이름 변경만(`TermTabbar.tsx:399`) | 터미널(서버) 쪽에 이미 있음·유지 | 3차 | S | — |

## 3. 터미널

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| xterm 터미널(WebGL) | xterm.js, WebGL 렌더, kitty 키보드 프로토콜 | `R/terminal-pane/` | 변경(대폭) — 680커밋 | 있음 — `renderer/terminal/TerminalPane.tsx`, `webglChoice.ts` | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |
| 스크롤백 검색 | 찾기, 대소문자·정규식, 매치 개수 | `R/TerminalSearch.tsx` | 기존 — 4커밋 | 있음 — `TerminalSearch.tsx` | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |
| 링크 클릭 팝오버 | 링크를 누르면 Orca 브라우저/시스템 브라우저/파일 열기/다운로드 중 고른다 | `R/link-actions/` | ✎ 변경 — 폴더는 9-06 신규지만 전신 `terminal-pane/TerminalLinkActionPopover`(8-09)가 있었다 | 부분 — Ctrl+클릭 자동 라우팅(원격 localhost → 포워딩 후 내장 브라우저, `shared/linkTarget.ts:9`) / 고르는 팝오버 없음 | 터미널(서버) 쪽에 이미 있음·유지 | 3차 | S | — |
| OSC 52 TUI 클립보드 | tmux·Neovim 이 SSH 너머에서 시스템 클립보드에 쓴다 | `D/terminal.mdx#tui-clipboard-osc-52` | 기존 | 없음 — OSC 핸들러 등록 없음(`TerminalPane.tsx:3-7` 애드온만) | 터미널 개선 | 3차 | S | ⚠️ 원격이 로컬 클립보드에 쓴다 → 기본 꺼짐, 설정에서 켜기(묶음 12) |
| 인라인 이미지 | sixel/iTerm 이미지를 터미널 안에 | `feat(terminal): inline images`(9-18) | 신규 — `addon-image` 9-18 최초 | 없음 | 터미널 개선 | 3차 | S | — |
| 출력 맥락 복사(Copy Context) | 우클릭 → 팬의 최근 출력을 길이 제한해 복사 | `D/terminal.mdx#copy-terminal-context` | 기존 | 부분 — AI 질문 때 활성 터미널 최근 출력을 비밀 가림 후 첨부(`AiPanel.tsx:80`, i18n `ai.ctx.title`) / 우클릭 복사 없음 | 전역 기능과 겹침 | —(아라 채팅이 이미 한다) | S | — |
| 터미널 초기화(Reset Terminal) | 남은 입력 모드(마우스·bracketed paste)를 호스트·팬 양쪽에서 초기화 | `feat(terminal): add Reset Terminal`(9-28) | 신규 — 9-28 최초 | 없음 | 터미널 개선 | 2차(vi/tmux 뒤 마우스 모드 잔류에 유용) | S | — |
| 테마 라이브러리·대비 하한 | 내장/사용자 테마, 최소 대비 | Settings→Terminal | 변경 — `minimumContrastRatio` 8-28 에 있었음 | 부분 — 단일 ANSI 테마(`TerminalPane.tsx:40` ansiTheme)·커서 모양(`cursorThemes.ts`) / 테마 선택·대비 없음 | 터미널 개선 | 3차 | S | — |
| Ghostty·Warp 설정 가져오기 | Ghostty 테마·폰트, Warp YAML 테마 가져오기 | `M/ghostty/`, `M/warp-themes/` | 기존 — 2·5커밋 | 없음 | 터미널 개선 | 3차(macOS 사용자에게 가치) | S | — |
| 셸 선택·인자 | 로그인/사용자 셸·인자, Windows PowerShell/CMD/WSL, `+` 메뉴로 셸별 탭 | `D/terminal.mdx#windows-shell` | 변경 | 부분 — 로컬은 pwsh → cmd 폴백 고정(`main/sessions/PtyBackend.ts:193·206`) / 셸 선택·인자 없음 | 터미널 개선 | 3차 | S | macOS 는 이미 `$SHELL`→zsh(`main/sessions/PtyBackend.ts:27`). 셸 선택은 양쪽 공통 일 |
| Windows 관리자 모드 | 권한 상태 표시, "관리자로 재시작" | `D/terminal.mdx#windows-administrator-mode` | 기존 | 없음 | 보류 | — | M | 사내 PC 권한 정책 |
| JIS ¥→\ 변환 | 일본어 키보드 Yen 키 | Settings→Terminal | 기존 | 없음 | 보류 | —(불필요) | S | — |
| 떠 있는 터미널(Floating) | 워크트리와 무관한 전역 셸 패널(단축키), 터미널·브라우저·마크다운 | `R/floating-terminal/` | 변경(대폭) — 48커밋 | ✎ 부분 — 세션을 독립 창으로 떼기(`SessionWindow.tsx`, `store/tabDetach.ts`) / 단축키 전역 패널 없음 | 터미널(서버) 쪽에 이미 있음·유지 | — | M | — |
| 빠른 명령(Quick Commands) | 자주 쓰는 명령·프롬프트 저장, 탭바에서 실행/삽입 | `R/terminal-quick-commands/` | 기존 — 6커밋 | 있음 — `renderer/data/commandBook.ts`(명령어 북) | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |
| 로컬 터미널 데몬 | 앱 종료·크래시·업데이트에도 PTY·에이전트 생존, 재부착 | `M/daemon/`, `M/pty/` | 변경(대폭) — daemon 343커밋 | 없음 — 로드맵 F24 | AI 작업 공간으로 이식 | 1차(DM-01) 업데이트·재시작에도 에이전트 생존 — 묶음 3 에서 당김 | L | 로컬 상주 프로세스 허용(결정 5). 종료·제거 방법을 사용자에게 보인다 |
| orcad(호스트 서버 데몬) | 원격·WSL·`orca serve` 공통 런타임 서버 | `M/orcad/` | 변경(대폭) — 8-22 최초, 245커밋 | 없음 | AI 작업 공간으로 이식 | 1차(DM-02) 원격 서버 작업의 바탕 — 묶음 8 | L | 운영 서버에 설치할 때 호스트별 사용자 동의·제거 방법 |
| 리소스 관리(PTY·프로세스) | CPU·메모리·세션, PTY 목록, 안전 종료, 데몬 재시작 | `R/status-bar/ResourcePty*.tsx` | 변경 — 호스트 프로세스 목록(10-10) | 부분 — 서버 쪽 CPU·메모리·프로세스(`SysMonitorPanel.tsx`, `ProcessTable.tsx`) / 로컬 PTY 목록 없음 | 터미널(서버) 쪽에 이미 있음·유지 | — | M | — |
| Linux 터미널 메모리 상한 | 터미널별 cgroup 메모리·스왑 제한 | `feat(linux)`(10-15) | 신규 — `cgroup` 9-21 최초 | 없음 | 보류 | —(Linux 전용 — 아라 대상은 Windows·macOS) | M | 그대로는 빼기. 아이디어는 묶음 0 에이전트별 상한(Windows Job Object·macOS)으로 |
| 원격 바인딩 전 키 경고 | 원격 터미널이 붙기 전 친 키가 안 갔음을 알림 | `feat(terminal)`(10-28) | 신규 — 10-28 | 없음 | AI 작업 공간으로 이식 | 3차(orcad 원격 바인딩과 함께) | S | — |
| 독립 터미널 셸 | 팬 밖에서 같은 정책을 쓰는 독립 터미널 | `R/standalone-terminal/` | 신규 — 10-21 최초 | 있음 — 아라는 원래 독립 SSH 터미널 | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |

## 4. 원격 — SSH·WSL·서버·VM·포트·네트워크

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| SSH 대상 관리 | Host/User/Port/키, `~/.ssh/config` 가져오기, Test→Save | `M/ssh/`, `R/settings/SshPane.tsx` | 변경(대폭) — 403커밋 | ✎ 부분 — 접속 모달·트리(`ConnectionModal.tsx`, `ConnTree.tsx`, `store/sshConnect.ts`) / `~/.ssh/config` 가져오기 없음(grep 0) | 터미널(서버) 쪽에 이미 있음·유지 | 3차(config 가져오기만) | S | — |
| 대용량 호스트 피커 | 1만 대 넘는 호스트 config 도 버티는 검색형 목록 | `R/host-picker/` | 신규 — 10-20 최초 | 부분 — F1 통합 검색의 프로필 그룹(`store/palette.ts:61`) / 접속 트리 자체 검색 없음 | 터미널(서버) 쪽에 이미 있음·유지 | 2차(터미널 개선 — 서버 수백 대면 유용) | S | — |
| 호스트 키 검증 | known_hosts·저장 키로 검증, 바뀌면 비밀번호 전에 거부 | `D/ssh.mdx#host-key-verification` | 기존 | 있음 — `main/sessions/ssh/hostkey.ts` | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |
| 고급 연결(점프·프록시·멀티플렉싱) | ProxyJump·ProxyCommand, OpenSSH ControlMaster 재사용, 시작 시 재연결 | `D/ssh.mdx#advanced-connection-options`, `feat(ssh)`(10-26) | 변경 — 시작 시 재연결 10-26 | ✎ 없음 — ssh2 직결, keepalive 만(`main/sessions/ssh/SshBackend.ts:106`), 점프 호스트 grep 0 | 터미널 개선 | 1차(TM-01) 사내 베스천 경유가 흔하다 | M | 터미널 개선 트랙의 첫 과제 |
| Kerberos·FIDO2 키 | GSSAPI·`-sk` 키는 시스템 OpenSSH 로 전환 | `D/ssh.mdx#kerberos--gssapi` | 기존 | 없음 | 터미널 개선 | 3차 | M | 사내 AD 환경이면 |
| 패스프레이즈 보관 | 세션 동안 메모리, TTL 연장 옵트인 | `D/ssh.mdx#passphrases` | 기존 | 있음 — `main/secrets/`(DPAPI) | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |
| SSH 상태 칩 | 초록/노랑/빨강, 연결 중엔 저장 목록 먼저 | `R/status-bar/SshStatusSegment.tsx` | 기존 | 있음 — `StateDot.tsx`, `store/remoteState.ts` | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |
| SSH 워크트리 | 원격에서 `git worktree` 를 만들고 에이전트 실행 | `D/ssh.mdx#use-a-target` | 기존 | 부분 — 원격 `git worktree add`(`shared/remoteCatalog.ts`, `Shell.tsx:769`) / 원격 목록·에이전트 연결 없음 | AI 작업 공간으로 이식 | 1차(DM-04) 묶음 8 — 서버에 붙어서 할 일이 많다 | L | SSH 명령으로 시작, orcad 를 깔면 그 위로 |
| 관리형 서버 자동 설치 | 첫 연결 때 Node+orcad 를 원격에 설치·업데이트·복구 | `M/managed-server/`, `R/managed-runtime/` | ✎ 신규 — 10-19 최초(34/34 파일), 92커밋 | 없음 | AI 작업 공간으로 이식 | 1차(DM-03) orcad 와 함께 — 묶음 8 | L | 운영 서버에 설치할 때 호스트별 사용자 동의·제거 방법(차단 사유 아님) |
| 평범한 SSH 터미널·SFTP | 원격 런타임을 못 띄울 때 일반 SSH 셸·SFTP 로 | `R/plain-ssh-terminal/` | 신규 — 10-21 최초 | 있음 — 아라의 기본 모델(`main/sessions`, `main/sftp`) | 터미널(서버) 쪽에 이미 있음·유지 | — | — | 아라 방식이 이 폴백과 같다 |
| 원격 파일·폴더 다운로드 | 탐색기 우클릭 → 다운로드(재귀) | `D/ssh.mdx#downloading…` | 기존 | 있음 — `ExplorerWindow.tsx`, `store/explorerTransfer.ts` | 터미널(서버) 쪽에 이미 있음·유지 | — | — | DLP 감사 로그 고려 |
| 드래그-드롭 업로드 | 트리·터미널에 떨구면 원격에 올리고 경로 붙여넣기 | `D/editing/file-explorer.mdx#external-drag-drop` | 기존 | 있음 — `store/dropZone.ts`, `uploadBus.ts`, `pasteFiles.ts` | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |
| VS Code 등으로 열기 | 워크트리(원격 포함)를 VS Code/Cursor/Zed 로 넘김 | `D/ssh.mdx#open-a-remote-workspace…` | 기존(프리셋 10-28) | 없음 | AI 작업 공간으로 이식 | 2차 | S | VS Code 는 사내 표준 |
| 포트 포워딩 | 원격 포트 감지 → 1클릭 포워드, 실패 이유 표시 | `M/ports/`, `R/right-sidebar/PortsPanel.tsx` | 변경 — 18커밋 | 있음 — `main/forward/PortForward.ts`, `PortMonitor.tsx`(아라가 더 강함) | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |
| macOS 로컬 네트워크 복구 | macOS 15 권한 상실 감지 | `D/ssh.mdx#macos…` | 기존 | 없음 | 터미널 개선 | 2차(macOS 지원 — macOS 15 에서 LAN SSH 가 권한 상실로 막힌다) | S | 아라는 macOS 도 지원한다(결정 12) |
| WSL 셸·경로 변환 | `\\wsl.localhost` 저장소는 `wsl.exe` 로, 경로 변환 | `M/wsl/` | 변경(대폭) — 200커밋 | 없음(grep 0) | AI 작업 공간으로 이식 | 3차(WSL 계열 — 원격·데몬과 함께) | M | WSL 사내 허용 여부 확인 |
| WSL 배포판 = 호스트 | WSL 안에 orcad 를 두고 호스트로, 원격 kill switch 정책 | `M/wsl/`, `feat(wsl) C1~C9`(10-12~13) | 신규 — WSL-via-orcad 10-12 최초 | 없음 | AI 작업 공간으로 이식 | 3차(orcad 다음) | L | WSL 사내 허용 여부 확인. 원격 kill switch 정책 수신은 끄거나 사내로 |
| WSL 프로젝트 이동 | Windows 프로젝트를 WSL 로 옮기는 마법사 | `R/wsl-move/` | 신규 — 10-28(기본 꺼짐) | 없음 | AI 작업 공간으로 이식 | 3차(WSL 계열) | L | WSL 사내 허용 여부 확인 |
| WSL 드라이브 프로젝트 → Git for Windows | `/mnt/c` 프로젝트는 Windows git 으로 | `R/wsl-drive-project/` | 신규 — 10-28 | 없음 | AI 작업 공간으로 이식 | 3차(WSL 계열) | M | WSL 사내 허용 여부 확인 |
| 원격 Orca 서버·`orca serve` | 다른 PC 의 Orca 를 서버로 페어링(액세스 링크), 헤드리스·서비스 설치, 서버 업데이트 상태 | `M/server/`, `M/runtime/`, `R/status-bar/RemoteServerUpdateStatusSegment.tsx` | 변경(대폭) — runtime 1882커밋 | 없음 | AI 작업 공간으로 이식 | 3차(orcad 다음) | L | Tailscale 대신 사내 LAN·VPN. 운영 서버에 설치할 때 호스트별 사용자 동의·제거 방법 |
| Cloud VM | 워크스페이스마다 VM/샌드박스/Docker | `M/ephemeral-vm/`, `R/settings/EphemeralVmsPane.tsx` | ✎ 변경 — 설정 팬 6-30 최초, 폴더 정리 10-22 | 없음 | 사내 부적합 | — | L | 외부 클라우드 의존. 로컬 Docker 레시피만 검토 대상 |
| 실행 위치 선택(Run on) | 로컬/SSH/서버/VM 중 실행 위치 | `R/settings/RuntimeEnvironmentsPane.tsx`, `R/host-picker/` | 변경 — 7커밋 | 없음 | AI 작업 공간으로 이식 | 1차(DM-05) 묶음 8 | M | VM 은 빼고 로컬/SSH/서버 |
| 네트워크·프록시 | Electron 세션 프록시·자격증명, DNS 진단 | `M/network/` | 기존 — 9커밋 | ✎ 없음 — 프록시 설정 grep 0 | AI 작업 공간으로 이식 | 3차(묶음 8) | S | 프록시 인증 환경이면 필수 |
| Cloud 커넥터(Slack/Discord) | Orca Cloud 경유로 Slack·Discord 에서 에이전트 시작 | `M/connector-cloud/` | 신규 — 10-26 최초 | 없음 | 사내 부적합 | — | L | 🔴 외부 SaaS |

## 5. 에디터·뷰어·파일 탐색기

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 코드 에디터(Monaco) | VS Code 편집기, 자동 저장, 멀티커서, 찾기, 정의로 이동 | `R/editor/` | 변경(대폭) — 439커밋 | 부분 — textarea 편집기(`EditorWindow.tsx:4` "일부러 문법 강조 없음"), 로컬·SFTP 저장(`main/editor/textIO.ts`) | AI 작업 공간으로 이식 | 1차(diff·리뷰의 바탕) | M | Monaco 번들 수 MB |
| 언어 하이라이트 확장 | Groovy/Jenkinsfile·CUDA·Typst·Quarto 등 | `feat(editor)`(9-26~10-28) | 신규 — Jenkinsfile 10-28 등 | 없음 | AI 작업 공간으로 이식 | 2차(Monaco 다음) | S | Jenkinsfile 은 사내 CI 와 맞다 |
| 변경 보기 모드 | 편집 탭 안에서 HEAD 대비 diff 로 전환 | `R/editor/ChangesModeView.tsx` | 기존 — 1커밋 | 없음 | AI 작업 공간으로 이식 | 2차 | M | — |
| 줄바꿈·미니맵·편집기 폰트·프리뷰 탭 | `Alt+Z`, 미니맵, 편집기 전용 폰트, 프리뷰 탭 끄기 | Settings→General | 기존 | 부분 — 터미널 폰트·UI 배율만(`store/font.ts`, `SettingsDrawer.tsx:1315`) / 편집기 옵션 없음 | AI 작업 공간으로 이식 | 2차 | S | — |
| 변경 감지 안전 저장 | 디스크 파일이 바뀌었으면 덮어쓰기 거부, 원격 큰 파일 분할 저장 | `M/ipc/filesystem/local-disk-write-precondition.ts`, `R/editor/ExternalFileChangeBanner.tsx` | 신규 — 10-19(#30605) | 부분 — 크기 상한·바이너리 거부·줄바꿈 보존(`main/editor/textIO.ts:10`) / 디스크 변경 감지 없음 | AI 작업 공간으로 이식 | 1차(AI 와 사람이 같은 파일을 고치면 덮어쓰기 사고) | S | — |
| 리치 마크다운 에디터 | Tiptap WYSIWYG, 슬래시 메뉴, 표, 목차, 원문 전환 | `R/editor/RichMarkdown*.tsx` | 변경 — 16커밋 | 부분 — 보기 전용(`md.tsx:137` react-markdown, AI 답변용) | AI 작업 공간으로 이식 | 3차 | L | — |
| 마크다운 리뷰 주석 | 렌더된 글을 선택해 리뷰 노트 | `D/editing/markdown.mdx#review-annotations` | 기존 | 없음 | AI 작업 공간으로 이식 | 3차 | M | — |
| 아티팩트로 공유 | 마크다운·HTML 을 Orca 계정 공개 링크로 게시 | `M/artifacts/` | 기존 | 없음 | 사내 부적합 | — | — | 🔴 외부 공개 업로드 |
| HTML 미리보기 | 샌드박스 탭에서 로컬·SSH HTML 렌더 | `D/editing/viewers.mdx#html`, `M/media/` | 변경 — 미리보기 권한·바이트 범위 `M/media/` 신규(10-07) | 없음 | AI 작업 공간으로 이식 | 3차 | M | — |
| Mermaid 뷰어 | 마크다운 안 다이어그램·`.mmd` | `R/editor/Mermaid*.tsx` | 기존 — 11커밋 | 없음 | AI 작업 공간으로 이식 | 3차 | S | — |
| PDF·이미지·오디오/비디오 뷰어 | 줌·위치 복원, 이미지 diff, 원격 바이트 범위 스트리밍 | `R/editor/PdfViewer.tsx`, `R/editor/ImageViewer.tsx`, `M/media/` | 변경 — 원격 바이트 범위(10-28) | 부분 — 아이콘·OS 열기만(`FileTree.tsx:97`) | AI 작업 공간으로 이식 | 2차 | S | — |
| CSV/TSV 표 뷰어 | 정렬·검색 표 | `D/editing/viewers.mdx#csv--tsv` | 기존 | 없음 — 아이콘만(`FileTree.tsx:92`) | AI 작업 공간으로 이식 | 3차 | S | — |
| Jupyter 노트북 | `.ipynb` 렌더·셀 편집·커널 실행 | `M/notebook/`, `R/editor/Ipynb*.tsx` | 신규 — `M/notebook` 9-23 최초(실행) | 없음 | 보류 | —(묶음 4 빼기) | L | — |
| 파일 탐색기 | 실시간 트리, git 상태 색, 생성/이동, Find in Folder, 원격 페이징 | `R/right-sidebar/FileExplorer*.tsx` | 변경 — 33커밋 | 있음 — `FileTree.tsx`(이름 필터 `:294`, 두 자리 마운트) / git 상태 색 없음 | AI 작업 공간으로 이식 | 2차(Orca 것 바탕 한 구현 — 묶음 4) | S | 공유(터미널과 같은 구현). 서버 SFTP 보기는 아라 것을 얹어 살린다 |
| 워크트리 전체 검색 | `Cmd-Shift-F` 내용 검색(필터·결과), ripgrep | `R/right-sidebar/Search*.tsx`, `M/ripgrep/` | 변경 — Search 13커밋, ripgrep 신규(9-24) | ✎ 없음 — 트리 이름 필터(`FileTree.tsx:294`)뿐, 내용 검색 없음 | AI 작업 공간으로 이식 | 1차(AI 가 바꾼 코드를 찾아 읽는 기본 도구) | M | ripgrep 동봉 승인 |

## 6. Diff·리뷰·소스 컨트롤

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| Diff 뷰어 | staged·unstaged·untracked 합친 diff, 비교 대상 전환, 파일 트리, 변경 없는 구간 접기 | `R/editor/DiffViewer.tsx`, `R/editor/DiffSection*.tsx` | 변경 — 공백 표시(9-02), 구간 접기(9-19) | 없음 — `git diff` 사용 grep 0, 로드맵 F6 | AI 작업 공간으로 이식 | 1차(AI 결과 검수의 기본) | M | — |
| 이미지·HTML diff | 나란히·스와이프·어니언스킨 | `R/editor/ImageDiffViewer.tsx` | 기존 — 1커밋 | 없음 | AI 작업 공간으로 이식 | 3차 | M | — |
| 머지 충돌 3-way | 3-way 보기·인라인 해결·"AI 로 해결" | `R/editor/EditorConflict*.tsx`, `R/editor/ConflictComponents.tsx` | 기존 — 8커밋 | 없음 | AI 작업 공간으로 이식 | 2차(묶음 5 — 3차에서 당김) | L | — |
| AI diff 주석(Annotate AI Diff) | 줄마다 코멘트를 달아 한 번에 에이전트에게 보내고, 해결/재검토 | `R/diff-comments/`, `store/slices/diffComments.ts` | 변경 — 20커밋 | 없음 — 로드맵 F7 | AI 작업 공간으로 이식 | 1차(AI 결과 검수의 핵심) | M | 사내에서 가장 가치 큰 축 |
| AI 작성 줄 표시(Attribution) | 에이전트가 쓴 줄을 기록해 거터에 표시, 내보내기 | `D/review/attribution.mdx` | 기존 | 없음 | AI 작업 공간으로 이식 | 2차 | M | 감사·컴플라이언스에 유용 |
| 소스 컨트롤 패널 | 스테이지/폐기, 커밋 메시지, Commit·Push·Pull·Sync, 상태별 주 버튼 | `R/source-control/`, `R/right-sidebar/SourceControl.tsx`, `R/right-sidebar/source-control/` | ✎ 변경(대폭) — `right-sidebar/source*` 132커밋(지난 판 "기존(소폭)") | 없음 — git commit/status 사용 grep 0 | AI 작업 공간으로 이식 | 1차(검수 후 커밋까지 한 화면) | M | — |
| AI 커밋 메시지·PR 본문 | 저장소별 레시피로 생성, 훅 실패 시 에이전트에게 수정 맡김 | `R/settings/CommitMessageAiPane.tsx` | 기존 | 없음 | AI 작업 공간으로 이식 | 2차(사내 LLM 엔드포인트 `shared/aiBaseUrl.ts` 연결 필요) | M | — |
| 푸시 안전장치·amend | 처음엔 upstream 설정, force-with-lease 분리, 푸시된 커밋 amend 확인 | `D/review/commit-push.mdx#push`, `M/git/push-target-validation.ts` | 기존 | 없음 | AI 작업 공간으로 이식 | 1차(소스 컨트롤과 한 묶음) | S | — |

## 7. Git 호스트·이슈 연동

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| GitHub PR | PR 생성·상태·체크·리뷰·코멘트·auto-merge·Stacked PR | `M/github/`, `R/github/` | 변경(대폭) — 89커밋 | 없음 | 사내 부적합 | — | L | `gh`·github.com 의존 |
| PR 페이지 | PR 을 탭 하나로 여는 전체 페이지 | `R/pull-request-page/` | 변경(대폭) — 32커밋 | 없음 | 사내 부적합 | — | L | — |
| GitHub Projects 보드 | Projects v2 표·칸반·로드맵 | `R/github-project/` | 변경(대폭) — 35커밋 | 없음 | 사내 부적합 | — | L | — |
| GitHub API 예산 | 남은 쿼터 표시 | `R/settings/GitProviderApiBudgetPane.tsx` | 기존 | 없음 | 사내 부적합 | — | S | — |
| GitLab MR·이슈·파이프라인 | MR/이슈 리뷰 화면, 파이프라인 작업·로그, `!123` 점프 | `M/gitlab/`, `R/gitlab/`, `R/gitlab-item-dialog/` | 변경(대폭) — 34커밋(항목 다이얼로그 8-27) | 없음 — 로드맵 F13 | AI 작업 공간으로 이식 | 2차(사내 GitLab 셀프호스트 — 주소·토큰 필요) | L | 설정에서 켜고 끄기, 기본 꺼짐. 켜도 MR·푸시는 사용자가 누를 때만(자동 업로드 없음) |
| Bitbucket Cloud | 토큰 연결, PR 생성 | `M/bitbucket/` | 기존 — 13커밋 | 없음 | 사내 부적합 | — | M | 외부 SaaS |
| Gitea·Azure DevOps | 코드 호스트 공급자(리뷰 링크·상태) | `M/gitea/`, `M/azure-devops/` | 기존 — 12·9커밋 | 없음 | 사내 부적합 | —(묶음 11 빼기) | M | — |
| Linear 이슈 | 목록/보드, 상세 편집, 이슈로 워크트리 생성 | `M/linear/`, `R/Linear*.tsx` | 변경 — 26커밋 | 없음 | 사내 부적합 | — | L | 외부 SaaS |
| Jira(Cloud·Server/DC) | 목록·보드·전이·즐겨찾기 필터·템플릿, 저장소별 기본값 | `M/jira/`, `R/JiraIssueWorkspace.tsx`, `R/jira-*.tsx` | 변경(대폭) — 36커밋, 62파일 중 32개 신규 | 없음 | 보류 | —(묶음 11 빼기) | L | 사내 일감은 monday.com → 사내 협업 툴 |
| 작업 페이지(작업 소스 통합) | GH/Linear/Jira/GitLab 작업을 한 페이지에서, 작업에서 워크스페이스 생성 | `R/task-page/` | 변경(대폭) — 97커밋 | 없음 | AI 작업 공간으로 이식 | 3차(묶음 11) | L | 사내 협업 툴을 끼울 수 있는 틀로. monday 연동은 안 함(곧 바뀜) |
| 워크스페이스–이슈 링크 | 이슈 하나를 연결해 카드에 표시 | `R/read-linked-task-issues.ts` | 기존 | 없음 | AI 작업 공간으로 이식 | 3차 | S | 사내 협업 툴 틀과 함께(묶음 11) |

## 8. 브라우저 팬

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 워크트리별 내장 브라우저 | 주소창(히스토리·퍼지), 뒤로/새로고침, 찾기, 워크트리 범위 탭, 닫은 탭 다시 열기 | `M/browser/`, `R/browser-pane/` | 변경(대폭) — 268·178커밋 | ✎ 부분 — 탭·뒤로·새로고침만(`BrowserWindow.tsx:39·49`), 용도는 OAuth 콜백·포워딩 미리보기(`main/browser/BrowserService.ts:3`) / 주소창·앞으로·찾기·워크트리 범위 없음 | 터미널(서버) 쪽에 이미 있음·유지 | —(서버 웹 콘솔 확인용 유지. Electron 43 후 ai-browser 가 정상 동작하면 그것으로 바꾼다) | — | 순서: Electron 43 → ai-browser 정상 동작 확인 → 이식(결정 11) |
| Chrome 식 새 탭·제안·히스토리 | 새 탭 페이지, 주소창 제안, 히스토리 보기·삭제 | `R/browser-pane/new-tab/`, `R/browser-pane/history/` | 신규 — 10-21·10-24 최초 | ✎ 없음 | 터미널 개선 | 3차(Electron 43 후 · ai-browser 이식과 함께) | S | 추천 사이트는 사내 URL 로 |
| 사이트별 확대·로딩선·링크 말풍선·음소거 | Cmd +/-/0 사이트별 줌, 로딩 선, 호버 URL, 소리 탭 음소거 | `feat(browser)`(10-21~25) | 신규 — 10-21~25 | 없음 | 터미널 개선 | 3차(Electron 43 후 · ai-browser 이식과 함께) | S | — |
| DevTools 도킹 | 브라우저 팬 안에 DevTools 붙이기·분리 | `R/browser-pane/devtools-dock/` | 신규 — 10-25 최초 | ✎ 없음 — 잠금 중 DevTools 닫기만(`main/ipc/registerLockIpc.ts:55`) | 터미널 개선 | 3차(Electron 43 후 · ai-browser 이식과 함께 — 묶음 13) | S | — |
| 사이트 권한 프롬프트 | 카메라·마이크·위치·외부 앱·로컬 네트워크·HTTP 기본 인증을 묻는다 | `R/browser-pane/browser-site-permission-prompt.ts` | 신규 — 10-21 최초 | 없음 — 의도적으로 전부 거부(`BrowserService.ts:32`) | 터미널 개선 | 3차(Electron 43 후 · ai-browser 이식과 함께 — 묶음 13) | S | 지금 아라는 전부 거부(`BrowserService.ts:32`) — 묻기로 바꾸는 일 |
| 다운로드 선반 | 진행/완료 다운로드, 취소·열기 | `D/browser/overview.mdx#downloads` | 기존 | ✎ 없음 — 다운로드 의도적 차단(`BrowserService.ts:37`, 파일은 SFTP 담당) | 터미널 개선 | 3차(Electron 43 후 · ai-browser 이식과 함께 — 묶음 13) | S | 지금은 의도적 차단(`BrowserService.ts:37`) — 풀 때 DLP 확인 |
| 링크 라우팅 | 링크를 Orca/시스템 브라우저 중 어디로, Shift 로 한 번 반대로 | `R/link-routing-preference-dialog.tsx` | 변경 — 팬 옆에 열기(10-23) | 부분 — 원격 localhost 자동 포워딩 후 내장 브라우저(`shared/linkTarget.ts:9`) / 사용자 선택·Shift 반전 없음 | 터미널(서버) 쪽에 이미 있음·유지 | — | S | — |
| 뷰포트 에뮬레이션 | 탭별 기기 크기 에뮬레이션 | `D/browser/overview.mdx#viewport-size-emulation` | 변경 | 없음 | AI 작업 공간으로 이식 | 3차(Electron 43 후 · ai-browser 이식과 함께) | S | — |
| 원격 워크스페이스 브라우징 | SSH 호스트 경유 트래픽·DNS | `D/browser/overview.mdx#remote-workspaces` | 변경 | 부분 — 포트 포워드 후 내장 브라우저(`main/forward/PortForward.ts`, `shared/linkTarget.ts`) / SOCKS 식 경유 없음 | 터미널(서버) 쪽에 이미 있음·유지 | — | M | 내부망 웹 콘솔 열기에 유용 |
| 브라우저 프로필(격리) | 프로필별 쿠키 분리, 저장소/워크스페이스별 기본 프로필 | `D/browser/profiles.mdx` | 변경 — 저장소별 프로필(10-23) | 없음 — 격리 파티션 하나(`BrowserService.ts:25` persist:ara-browser) | 터미널 개선 | 3차(Electron 43 후 · ai-browser 이식과 함께) | M | — |
| 쿠키 가져오기 | Chrome/Edge 등 쿠키 DB 에서 가져오기 | `R/BrowserCookieImport*.tsx` | 변경 — Vivaldi(10-28) | 없음 | 터미널 개선 | 3차(Electron 43 후 · ai-browser 이식과 함께 — 묶음 13) | M | 브라우저 쿠키 DB 읽기 — 사용자가 누를 때만 |
| 크롬 확장 설치 | Chrome Web Store 에서 확장 설치 | `M/browser/extensions/` | 신규 — 10-27 최초(224/224) | 없음 | 터미널 개선 | 3차(Electron 43 후 · ai-browser 이식과 함께 — 묶음 13) | M | 외부 스토어 — 사내망 반입 확인 |
| 디자인 모드(요소 주석) | 요소를 눌러 HTML·CSS·스크린샷·소스 위치를 에이전트 프롬프트로 | `D/browser/design-mode.mdx`, `R/browser-pane/` | 변경 — 지우개(10-05), 이미지 붙여넣기(10-29) | 없음 — 로드맵 F18 | AI 작업 공간으로 이식 | 3차(Electron 43 후 · ai-browser 이식과 함께. 스크린샷이 LLM 으로 나감 → 사내 엔드포인트일 때만) | M | — |
| 에이전트 브라우징 실시간 표시 | 에이전트의 브라우징을 보여 주고 채팅에서 그 페이지로 이동 | `feat(browser)`(10-25, 10-30) | 신규 — 10-25 | 부분 — MCP 도구 `browser_open`(`main/mcp/tools.ts:546`) / 실시간 표시 없음 | AI 작업 공간으로 이식 | 3차(Electron 43 후 · ai-browser 이식과 함께 — ai-browser 의 Space UI 가 같은 일) | M | 로그인·결제 자동화는 금지 |

## 9. Computer Use·에뮬레이터

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| Computer Use | 접근성 트리·스크린샷으로 데스크톱 앱 조작 | `M/computer/`, `R/settings/ComputerUsePane.tsx` | 변경 — 24커밋, 트리 diff(10-29) | 없음 — 로드맵 F19 | AI 작업 공간으로 이식 | 3차(묶음 13) | L | 기본 꺼짐, 켤 때 확인, 아라 창 제외 |
| 모바일 에뮬레이터 팬 | Android/iOS 에뮬레이터를 팬에 | `M/emulator/`, `R/emulator-pane/` | 변경 — 29·16커밋 | 없음 | 보류 | —(모바일) | L | 업무와 무관 |

## 10. 알림·트레이·대시보드·상태 표시

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 에이전트 완료 알림 | 작업→대기 전환 때 시스템 알림·소리·칩, 범주별 끄기 | `R/settings/NotificationsPane.tsx`, `M/ipc/notifications.ts` | 변경 — `M/notifications/` 9-10 은 모바일 푸시용 | 부분 — AI 세션 대기 시 시스템 알림(`store/aiQuietWatch.ts:66`) / 소리·범주 설정 없음 | AI 작업 공간으로 이식 | 2차 | S | — |
| 헤더 벨·알림 카드 | 미확인 알림 벨, 클릭하면 해당 팬, 카드 스택 | `R/notifications/`, `R/NotificationCardStack.tsx` | 변경 — 카드 스택 9-10 신규 | 없음 | AI 작업 공간으로 이식 | 3차 | S | — |
| 알림 소리 | 범주별 오디오 파일·볼륨 | `R/notification-sound-options.ts` | 기존 | 없음 | AI 작업 공간으로 이식 | 3차 | S | — |
| Dock 배지·트레이 | Dock 미확인 배지, 트레이 상주, 트레이에서 완전 종료 | `M/dock/`, `M/tray/` | 변경 — 트레이 완전 종료(10-27) | 없음(grep 0) | AI 작업 공간으로 이식 | 3차(로컬 데몬과 함께 — 트레이 상주) | S | macOS Dock 배지와 Windows 트레이 둘 다(결정 12) |
| 활동 피드(Activity) | 전 워크트리 에이전트 이벤트 스레드, 필터, 일괄 메뉴 | `R/activity/` | 변경(대폭) — 72커밋 | ✎ 없음 — `AppLogPanel.tsx` 는 서버 앱 로그 tail(`remoteLog.ts`)이라 별개 | AI 작업 공간으로 이식 | 1차(AI-09, A §13 과 같은 기능 — 묶음 2) | M | — |
| 에이전트 대시보드(칸반) | Needs You/Working/Done 칸반, 필터, 팝아웃 | `R/dashboard/`, `R/dashboard-popout/` | 변경(대폭) — 78·49커밋 | 부분 — AI 세션 트리·상태 그룹(`AiBenchTree.tsx`, `store/aiWorkbench.ts`) / 칸반·팝아웃 없음 | AI 작업 공간으로 이식 | 1차(AI-08, A §13 과 같은 기능 — 묶음 2) | M | — |
| 상태 표시줄 | 리소스·포트·SSH·업데이트 세그먼트, 표시 항목 메뉴 | `R/status-bar/` | 변경(대폭) — 166커밋 | 있음 — `StatusBar.tsx` | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |
| 깨어 있기(Caffeinate) | 잠자기 방지 | `R/status-bar/CaffeinateStatusSegment.tsx` | 기존 | 없음 | 보류 | — | S | 사내 전원 정책과 충돌. A §1 "컴퓨터 깨어있기"(이식 2차)와 같은 일이라 그쪽에서 한다 |
| 우측 사이드바 | 파일·검색·소스 컨트롤·체크·포트·플러그인을 탭으로 | `R/right-sidebar/` | 변경(대폭) — 401커밋 | 부분 — 하단 패널 서버 표 5종(`ServerTool.tsx`, `BottomPanel.tsx`) / 파일·검색·SCM 탭 묶음 없음 | AI 작업 공간으로 이식 | 2차(1차 패널을 담는 틀 — 처음엔 단순 탭으로) | M | 공유(터미널과 같은 구현) |

## 11. 설정·키바인딩·i18n

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 설정 화면(검색형, 38개 팬) | 팬별 설정, `Cmd-,` 키워드 검색 | `R/settings/` | 변경(대폭) — 454커밋 | 부분 — `SettingsDrawer.tsx`(섹션형 서랍) / 검색 없음 | 터미널(서버) 쪽에 이미 있음·유지 | —(AI 작업 공간 설정은 섹션 하나 추가) | M | — |
| 외형(테마·액센트·밀도·배율) | 테마, 액센트, 밀도, UI 배율, 앱 아이콘 | Settings→Appearance | 기존 | 부분 — UI 배율(`SettingsDrawer.tsx:1315`)·커서 모양 / 테마·액센트 없음 | 터미널(서버) 쪽에 이미 있음·유지 | 3차 | S | — |
| 키바인딩 재지정 | 모든 바인딩 재지정, `keybindings.json` | `M/keybindings/`, `R/settings/ShortcutsPane.tsx` | 기존 — 4커밋 | 부분 — 단축키 표 보기와 잠금 단축키 변경만(`SettingsDrawer.tsx:747`, `shared/keymap.ts:93`) | 터미널(서버) 쪽에 이미 있음·유지 | 3차 | M | — |
| UI 언어 12종 | System·영·중(간/번)·한·일·스·프·포·러·터·독 | `src/renderer/src/i18n/locales/` | 변경 — 8-28 5개 → 신규 6개(fr·de·pt·ru·tr·zh-Hant) | 부분 — `renderer/i18n/ko.json` 1개(구조는 있음) | 터미널(서버) 쪽에 이미 있음·유지 | —(한국어 하나면 충분) | S | — |
| 플러그인(Alpha) | git 마켓플레이스, 미리보기, 바이트 승인 | `M/plugins/`, `R/plugins/` | ✎ 변경(대폭) — `M/plugins` 7-27 최초·55커밋, 렌더러 `R/plugins/` 10-28 신규 | 없음 — 로드맵 F16 | AI 작업 공간으로 이식 | 3차(묶음 13 — 사내 승인 플러그인만) | L | 외부 마켓 대신 사내 승인 목록 |
| 실험 기능 토글 | 시험 기능 켜기 | `R/settings/ExperimentalPane.tsx` | 변경 | 부분 — 코드 상수 스위치(`shared/features.ts:88`) / 사용자 토글 없음 | 터미널(서버) 쪽에 이미 있음·유지 | — | S | — |

## 12. 업데이트·텔레메트리·진단·안정성

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 자동 업데이트 | 확인·다운로드·재시작, 다른 인스턴스 대기 | `M/updater/`, `R/UpdateCard.tsx` | 변경 — 29커밋, `M/updater/` 분리(8-30) | 있음 — `main/update/AutoUpdate.ts`(사내 배포) | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |
| 릴리스 채널(RC·perf) | Shift/Ctrl-클릭으로 프리릴리스 선택 | `D/settings.mdx#general` | 기존 | 없음 | 터미널 개선 | 3차(사내 베타 채널로 응용) | S | — |
| 로컬 빌드 전환 | macOS 로컬 빌드 골라 전환 | `M/local-builds/` | 기존 — 6커밋 | 없음 | 보류 | —(개발자 전용. macOS 라서 뺀 것이 아니다) | M | — |
| 익명 텔레메트리 | 로컬 ID, 내용 미전송, 끄기, 첫 실행 동의 | `M/telemetry/` | 변경 — 31커밋 | 있음 — `main/telemetry/`, `store/telemetry.ts`(사내 수집) | 터미널(서버) 쪽에 이미 있음·유지 | — | — | 🔴 원본은 외부 전송 → 사내 수집기로만 |
| 크래시 리포트 | Help→Report Crash, OOM 원인·롱태스크 | `M/crash-reporting/`, `R/crash-report/` | 변경 — 32커밋 | 있음 — `main/report/BugReport.ts`, `BugReportModal.tsx` | 터미널(서버) 쪽에 이미 있음·유지 | — | — | — |
| 멈춤 감시(Hang watchdog) | 메인 스레드 멈춤을 워커가 감지·다음 실행 때 보고 | `M/hang-watchdog/` | 기존 — 6커밋 | 없음 | 터미널 개선 | 1차(FD-02, 기반 — 묶음 0) | M | 진단 가치 높음 |
| 진단 프로브 | 이벤트 루프 지연·처리량 측정 | `M/diagnostics/` | 기존 — 3커밋 | 없음 | 터미널 개선 | 1차(FD-03, 기반 — 묶음 0) | S | — |
| 렌더러 복구·안전 그래픽 모드 | 렌더러 크래시 자동 재로드, GPU 크래시 반복 시 안전 모드 | `R/error-boundaries/`, i18n `rendererRecovery`·`gpuFallback` | 기존 | ✎ 없음 — `render-process-gone` 처리 grep 0(GPU 정보 조회만 `main/ipc/registerWindowIpc.ts:149`) | 터미널 개선 | 1차(FD-04, 기반 — 묶음 0) | M | — |
| 설치 폴더 ACL 복구 | Windows 설치 폴더 ACL 이 샌드박스를 막으면 고친다 | i18n `installDirAcl` | 기존 | 없음 | 터미널 개선 | 3차(묶음 13) | S | — |

## 13. 온보딩·안내·계정·기타 앱 셸

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라 현황(근거) | 분류 | 우선순위(이유) | 난이도 | 사내 메모 |
|---|---|---|---|---|---|---|---|---|
| 온보딩 흐름 | 첫 실행 단계·체크리스트 | `R/onboarding/` | 변경(대폭) — 38커밋 | 부분 — `WelcomeModal.tsx`, `BootSplash.tsx`, `AiBootstrapModal.tsx` | AI 작업 공간으로 이식 | 2차(AI 공간 첫 안내 — Orca 온보딩, 묶음 13) | S | 아라 인사·부트스트랩(`WelcomeModal`·`AiBootstrapModal`)은 그대로 |
| 기능 소개 벽(Feature Wall) | 기능 타일(GIF/WebP), 연동 목록 | `R/feature-wall/` | 변경(대폭) — 34커밋 | 없음 | 보류 | — | S | 미디어 용량 |
| 상황별 팁 | 1회성 팁, "지금 켜기/그대로" | `R/feature-tips/` | 변경 — 21커밋 | 없음 | AI 작업 공간으로 이식 | 3차(새 작업 공간 안내) | S | — |
| 가이드 투어 | 화면 요소를 짚어 가는 투어 | `R/contextual-tours/` | 기존 — 13커밋 | 없음 | AI 작업 공간으로 이식 | 3차 | M | — |
| 설정 안 셋업 가이드 | 설정 속 셋업 가이드 팬 | `R/setup-guide/` | 기존 — 10커밋 | 없음 | AI 작업 공간으로 이식 | 3차(묶음 13 넣기 — 차수가 없어 3차로 둠) | S | — |
| 별 요청·펫(장식) | GitHub 별 요청 카드, 상태 표시줄 마스코트 | `M/star-nag/`, `R/pet/` | 기존 — 2·12커밋 | 없음 | AI 작업 공간으로 이식 | 3차(펫만 — 묶음 13 넣기, 차수가 없어 3차로 둠) | S | 별 요청은 빼기(묶음 13) |
| Orca 계정·프로필 | Orca 클라우드 로그인, 조직, 계정별 상태 이전 | `M/orca-profiles/`, `R/unexpected-signout/` | 변경(대폭) — 45커밋 | 없음 — 사내 계정 하나 | 사내 부적합 | — | — | 🔴 외부 클라우드 계정 |
| 선택 텍스트 복사 메뉴·줌 오버레이 | 선택 텍스트 복사 메뉴, 줌 배율 오버레이 | `R/SelectedTextCopyMenu.tsx`, `R/ZoomOverlay.tsx` | 기존 | 부분 — 터미널 글꼴 확대(`MainArea.tsx:1114` zoomFont) / 복사 메뉴·배율 오버레이 없음 | 터미널(서버) 쪽에 이미 있음·유지 | — | S | — |
| 앱 메뉴 | 업데이트 확인·크래시 신고·사이드바 토글·완전 종료 | `M/menu/register-app-menu.ts` | 기존 — 11커밋 | ✎ 있음 — 프레임 없는 타이틀바의 메뉴바(`TitleBar.tsx:3`, `interactions/actions.tsx` MENUBAR) | 터미널(서버) 쪽에 이미 있음·유지 | —(AI 작업 공간 메뉴 항목만 추가) | S | — |

---

## 변경 요약(지난 판 대비)

- **v4**(묶음별 결정): 35행을 고쳤다(분류 이동 15).
  - 1차로 당김 10행: 로컬 데몬(묶음 3)·orcad·SSH 워크트리·관리형 서버·실행 위치(묶음 8), 활동 피드·대시보드(묶음 2, A §13 과 같은 기능), 멈춤 감시·진단 프로브·렌더러 복구(기반, 묶음 0).
  - 넣기로 바꿈(3차): 브라우저 5행(DevTools·사이트 권한·다운로드·쿠키·크롬 확장 — 터미널 개선, ai-browser 와 함께), Computer Use·플러그인(묶음 13), 설치 폴더 ACL, 셋업 가이드, 펫, 네트워크·프록시(묶음 8). 온보딩은 AI 공간 첫 안내로 2차(묶음 13).
  - 빼기로 바꿈: 이모지 이름(묶음 1), Jupyter(묶음 4), Jira(묶음 11).
  - 우선순위·메모만: 머지 충돌 3-way 2차(묶음 5), `.worktreeinclude` Orca 기본값(묶음 5), 파일 탐색기 Orca 바탕(묶음 4), GitLab 기본 꺼짐·누를 때만(묶음 11), 작업 페이지 사내 협업 툴 틀(묶음 11), OSC 52 기본 꺼짐(묶음 12), 워크트리 없이 폴더에서 바로 돌리기(묶음 1).
- **v3**(결정 5~12):
  - 보류 → 이식 12행: 로컬 터미널 데몬(2차)·orcad(2차)·완전 종료·원격 바인딩 전 키 경고·관리형 서버 자동 설치·원격 Orca 서버·실행 위치 선택·WSL 4행·Dock 배지·트레이(모두 3차). "원격 데몬 안 함", "§8 원격 설치 금지", "운영 서버에 상주 프로세스 설치", "데몬 전제" 사유는 "운영 서버에 설치할 때 호스트별 사용자 동의·제거 방법" 운영 메모로 바꿨다.
  - 보류 → 터미널 개선 16행: 점프 호스트(1차, TM-01), Reset Terminal·macOS 로컬 네트워크 복구·렌더러 복구(2차), OSC 52·인라인 이미지·테마·셸 선택·Ghostty·Kerberos·브라우저 3행·릴리스 채널·멈춤 감시·진단 프로브(3차).
  - 세션 복원·파일 탐색기·우측 사이드바 메모에 "공유(터미널과 같은 구현)"(결정 8). 브라우저 행에 "Electron 43 후 · ai-browser 이식과 함께"(결정 11). "사내 Windows" 사유는 다시 봤다(Ghostty·Linux·로컬 빌드, 결정 12).
  - B 행 수는 155 다. v2 요약표의 154 는 셈이 틀린 값이었다.
- 아래는 v2 기록이다.
- **행 수**: 159 → 155. 합친 행 4개 — ① Ghostty 가져오기 + Warp 테마 가져오기 → "Ghostty·Warp 설정 가져오기" ② Remote Orca Server + `orca serve` + (12장) 원격 서버 업데이트 상태 → "원격 Orca 서버·`orca serve`" (−2) ③ Star nag + Pet → "별 요청·펫(장식)"
- **신규 23 → 23**(전체 이력 기준, 3개 들고 3개 나감)
  - 신규로 올림 3: 완전 종료(10-27), 탭 호버 카드(10-09), 관리형 서버 자동 설치(`M/managed-server/` 10-19, 34/34)
  - 신규에서 내림 3: 링크 클릭 팝오버(전신 `TerminalLinkActionPopover` 8-09), Cloud VM(설정 팬 6-30), 플러그인(`M/plugins` 7-27 — 렌더러만 10-28 신규)
  - 결과적으로 전체 이력을 써도 신규 수는 그대로다. 얕은 클론의 시작점(8-27)과 기준일(8-28)이 하루 차이라 "8-28 에 있었나" 판정이 같기 때문이다. 바뀐 것은 경계 사례 6건과 커밋 수 근거
  - 그 밖의 Orca 상태 정정: 소스 컨트롤 "기존(소폭)" → 변경(대폭)(`right-sidebar/source*` 132커밋), orcad 최초 추가일 8-22 명시
- **아라 현황 정정 14행**(✎): 
  - 있음 → 부분 2: 내장 브라우저(주소창·앞으로·찾기 없음), SSH 대상 관리(`~/.ssh/config` 가져오기 없음)
  - 부분 → 없음 9: 디스크 사용량, Quick Open, 워크트리 전체 검색, 고급 연결(점프), 네트워크·프록시, DevTools 도킹, 다운로드 선반(오히려 차단), 활동 피드(AppLogPanel 은 서버 로그), 렌더러 복구
  - 부분 → 있음 1: 앱 메뉴(TitleBar 메뉴바)
  - 없음 → 부분 1: 떠 있는 터미널(세션 떼어내기 창)
  - 그 밖: 새 탭·제안·히스토리 부분 → 없음
- **새 열**: 분류·우선순위 추가, 아라 근거에 파일:줄

## 불확실한 점

- **`터미널 개선`의 범위**: 결정 7 은 터미널 일반 기능을 말했다. v3 는 내장 브라우저 개선 3행과 앱 안정성 4행(렌더러 복구·멈춤 감시·진단 프로브·릴리스 채널)도 "지금 아라 앱에 넣을 일반 기능"으로 보고 여기 넣었다. 반대로 `유지`로 분류된 행 중 개선 여지가 있는 것(대용량 호스트 피커 2차, `~/.ssh/config` 가져오기 3차 등)은 분류를 바꾸지 않았다.
- **WSL 4행**: 결정 6 대로 원격·데몬 계열과 함께 이식 3차로 두었다. WSL 사내 허용 여부는 확인하지 않았다(메모).
- **8-28 판정은 경로 단위**다. 기능 하나가 폴더 하나에 깔끔히 대응하지 않는 행(브라우저 하위 기능, 탭 호버 카드 등)은 `git log -S`·`git grep 94e75866` 으로 키워드 최초 등장을 따로 봤다. 키워드를 잘못 고르면 틀릴 수 있다.
- **빌드 스위치 뒤 기능**: 레이아웃 소유자(`ORCA_LAYOUT_OWNER`), WSL Mover·WSL 호스트, connectors 는 기본 꺼짐이다. 일반 사용자에게 보이는지는 확인하지 않았다.
- **Electron 버전 차이**: 아라 `electron ^31.3.1`, Orca `43.8.4`(package.json). 1차 기능 중 Monaco·ripgrep 은 버전 영향이 작지만, 브라우저 팬 계열(`WebContentsView` API)은 업그레이드 뒤에 이식하는 편이 안전하다.
- **portmap 경로**: R/editor/ 는 Monaco·diff·마크다운·뷰어가 한 폴더라 Monaco·Diff·안전 저장 항목이 같은 폴더를 공유한다. 모니터링에서 같은 diff 가 여러 항목에 잡힐 수 있다.

---

# C. 모바일 동반앱 — Orca 앱만 빌려 아라를 조종할 수 있나


- 대상: `D:\orca` (stablyai/orca) HEAD `7a7f46f8a3` (2026-10-31), 기준 커밋 `94e75866` (2026-08-28)
- 방식: 읽기 전용. 빌드·설치·실행·웹 조회 없음. 경로는 `D:\orca` 기준 상대 경로.

## 0. 한 줄 요약

**조건부 가능(LAN 한정), 그러나 "스토어 앱만 빌리기"는 권하지 않는다.** 휴대폰 앱은 얇은 껍데기(shell)이고, 실제 화면 대부분은 **데스크톱이 내려주는 웹 번들**(`mobileWeb.bundle.*`)을 WebView로 띄운 것이다. 그래서 아라가 Orca 데스크톱인 척하려면 E2EE 핸드셰이크와 RPC 수십 개 말고도 **Orca 소스로 빌드한 mobile-web 번들을 아라가 직접 서빙**해야 한다. 그리고 스토어 앱이 자동 업데이트되면 언제든 깨질 수 있다. 현실적인 대안은 `mobile/`(MIT)을 포크해 **사내 빌드 APK로 배포**하는 것이다.

**v4 결정(묶음 9): Claude 원격 제어가 1차, Orca 스토어 앱 연결이 3차다. 자체 포크는 대안이다.**
- **1차 — Claude 원격 제어 자동 켜기.** 아라가 띄우는 Claude 세션에서 원격 제어(Remote Control)를 자동으로 켠다. 폰은 Claude 앱으로 프롬프트·출력·diff·권한/질문 응답·푸시 알림을 받는다. 사내는 Team 플랜이고 원격 제어가 켜져 있다. Claude Code 세션만 된다. 아라 쪽 일이라 대응표에는 넣지 않았다(5절 끝).
- **3차 — Orca 스토어 앱을 아라에 연결.** Orca 앱을 그대로 쓰고(앱만 빌림), Orca 를 이식한 아라가 데스크톱 노릇을 한다. Codex·Gemini·서버 터미널까지 폰으로 보려는 것이다. 착수 전에 사내 Wi-Fi 직결을 실측한다. 모바일 기능 행(C-6)은 모두 이 3차에 묶었다.
- **대안 — 자체 포크.** `mobile/` 을 포크해 사내 앱으로 배포하는 길(아래 대안 1)은 스토어 앱 연결이 막힐 때 쓴다.
- v3 는 "자체 포크로 진행, 스토어 앱 비권장"이었다. 아래 1~5절의 조사 내용(스토어 앱의 위험)은 그대로 두고, 5절 결론만 v4 로 고쳐 썼다.

---

## 1. 모바일 ↔ 데스크톱 연결 방식

### 1-1. 페어링: QR 또는 코드 붙여넣기
- 페어링 URL은 `orca://pair?code=<base64url(JSON)>` 이다. `src/shared/pairing.ts:15-26`(encode), `:29-47`(decode, 호스트 정확히 일치), `:62-71`(딥링크나 bare 코드 붙여넣기 모두 허용).
- 데스크톱은 `qrcode`로 같은 URL을 QR로 그린다. `src/main/runtime/mobile-pairing-qr.ts:8-20`.
- 오퍼 스키마(`PAIRING_OFFER_VERSION = 2`)는 `src/shared/mobile-relay-pairing-offer.ts:10, 69-81`에 있다.
  - 필수 필드: `v:2`, `endpoint`(ws/wss URL), `deviceToken`, `publicKeyB64`(데스크톱 Curve25519 공개키 32B)
  - 선택 필드: `pairedDeviceId`, `scope('mobile'|'runtime')`, `relay{directorUrl, cellUrl, relayHostId, inviteToken, inviteExpiresAt(≤10분), e2eeFraming:2}`, `hostDescriptor`
  - 릴레이 URL 검증은 "정규 HTTPS origin"인지만 본다(`:18-31, 46-52`). **도메인을 고정(pin)하지 않는다.**
- 문서상 절차(`docs/site/content/docs/mobile.mdx:37-42`): 데스크톱이 일회성 코드를 띄우면 모바일에서 Pair → 붙여넣기 또는 스캔. 이 교환으로 그 폰 전용 device token이 생긴다.

### 1-2. 전송: 직접 LAN WebSocket과 Orca 클라우드 릴레이, 두 경로
| 경로 | 내용 | 근거 |
|---|---|---|
| Direct (LAN/Tailscale) | 폰이 데스크톱 `ws://<ip>:6768`에 직접 붙는다. 평문 ws 위에 앱 계층 E2EE를 얹는다. | `src/main/runtime/runtime-rpc/runtime-rpc-pairing-types.ts:20` (`DEFAULT_WS_PORT = 6768`), `mobile.mdx:86,120`. Android `usesCleartextTraffic: true`, iOS `NSAllowsLocalNetworking`: `mobile/app.json:39,88,143` |
| Relay ("Anywhere") | 폰과 데스크톱이 각각 릴레이 셀로 아웃바운드 WSS를 연다. 릴레이는 프레임을 이어 붙이기만 한다. | `cloud/README.md:3-8`. 기본 director는 `https://relay.onorca.dev`(`src/main/orca-profiles/profile-cloud-auth-config.ts:27, 96-97`, 개발 빌드만 `ORCA_RELAY_URL`로 덮어쓰기 가능) |

- 로그인하지 않은 데스크톱은 무조건 `local-only`(LAN)로 동작한다. Relay를 쓰려면 Orca 계정 로그인이 필수다. `src/shared/mobile-pairing-connection-mode.ts:3-11`(`!signedIn → 'local-only'`), `:22-28`(`automatic && !signedIn`이면 오퍼 발급 금지). 문서도 같다: "sign-in is required for Relay only"(`mobile.mdx:41`).
- Relay 방화벽 대상: `login.onorca.dev`, `auth.onorca.dev`, `relay.onorca.dev`, `*.relay.onorca.dev`의 443 포트(`mobile.mdx:107-118`).

### 1-3. E2EE (v2)
- 핸드셰이크 메시지는 `e2ee_hello`(폰 → 데스크톱: `clientPublicKeyB64`, `clientNonceB64`, `capabilities{framing:[2]}`, `context{transport:'direct'|'relay', relayHostId?}`)와 `e2ee_ready`(데스크톱 → 폰)다. `src/shared/mobile-e2ee-v2-contract.ts:1-32`. 트랜스크립트 인코딩은 `:110-`.
- 키 합의는 X25519(NaCl `box.before`)로 한다. `src/shared/e2ee-crypto.ts:9-14`.
- 키 스케줄은 HKDF-SHA256이다. salt = `sha256("orca-mobile-e2ee/v2/salt\0" ‖ clientNonce ‖ desktopNonce)`, info = `label ‖ sha256(transcript)`, 출력 96B를 m→d 키, d→m 키, sessionId로 나눈다. `src/shared/mobile-e2ee-v2-node-key-schedule.ts:13-32`.
- 프레임 암호화는 NaCl `secretbox`(XSalsa20-Poly1305)다. `src/shared/mobile-e2ee-v2-framing.ts:1, 31, 45-61`.
- 인증 메시지는 `{type:'e2ee_auth', v:2, transcriptHashB64, deviceToken}` → `e2ee_authenticated`이다. `src/shared/paired-e2ee-client-handshake.ts:224-225, 146`. device-key 자격증명은 v2에서만 쓸 수 있다(`:127-128`).
- 레거시 v1(`{type:'e2ee_hello', publicKeyB64}` → `{type:'e2ee_ready'}`, NaCl box)은 **한 번도 v2에 성공한 적 없는 호스트**가 v2 hello를 거절할 때만 허용된다(다운그레이드 방지 래치). `src/shared/paired-e2ee-framing-policy.ts:25-28`, 픽스처는 `src/shared/mobile-e2ee-legacy-fixtures.ts:1-15`.
- 공개키는 페어링 때 QR로 고정(pin)된다(`mobile-relay-pairing-offer.ts:74`). 릴레이는 암호문만 본다.

### 1-4. 인증, 토큰, 계정
- LAN 경로는 **Orca 계정이 필요 없다.** QR 속 `deviceToken`과 데스크톱 공개키 pin만 있으면 된다.
- 페어링 뒤 `pairing.registerDeviceKey`로 기기 키를 등록하는 흐름이 있다(paired-desktop RPC, `src/main/runtime/runtime-rpc/runtime-rpc-mobile-paired-desktop-methods.ts`). 데스크톱 쪽은 `src/main/runtime/device-registry.ts`, `device-credential.ts`.
- Relay는 데스크톱이 `login.onorca.dev/v1/desktop/auth/relay-token`에서 JWT를 받아야 한다(`profile-cloud-auth-config.ts:25, 90-92`). 릴레이 서버는 `ORCA_RELAY_AUTH_ISSUER`, `ORCA_RELAY_JWKS_URL`, aud `orca-relay`로 검증한다(`cloud/apps/relay/src/config.ts:50-52`).

### 1-5. 외부 클라우드 의존 (하드코딩)
| 대상 | 용도 | 근거 |
|---|---|---|
| `relay.onorca.dev` | 릴레이 director | `profile-cloud-auth-config.ts:27` |
| `login.onorca.dev` | 계정 로그인, relay/connector 토큰 | 같은 파일 `:25` |
| `push.onorca.dev` | 푸시 게이트웨이(APNs/FCM) | `src/main/runtime/push/push-gateway-origin.ts:4` |
| `www.onorca.dev/v1/feedback` | 모바일 연결 진단 제출 | `mobile/src/diagnostics/connection-diagnostics-submission.ts:3` |
| `itunes.apple.com/lookup?bundleId=com.stably.orca.mobile`, `api.github.com/repos/stablyai/orca/...mobile-android-v*` | 앱 업데이트 확인 | `mobile/src/app-update/app-store-update-source.ts:5`, `github-release-update-source.ts:20-22` |
| Firebase `onorca-cloud` | Android FCM | `mobile/google-services.json:4,12` |

---

## 2. 프로토콜 정의와 API 범위

### 2-1. 정의 위치
- 와이어 봉투는 `{id, ok:true, result, _meta:{runtimeId}}`, `{id, ok:false, error{code,message,data?}}`, `{_keepalive:true}`다. `src/shared/runtime-rpc-envelope.ts:1-50`.
- 메서드별 파라미터 스키마(zod)는 `src/shared/rpc-contract/`(141개 파일)과 생성 카탈로그 `src/shared/rpc-contract/rpc-params-catalog.generated.ts`에 있다.
- 모바일 허용 메서드 목록은 **라우팅 표 = 허용 목록**이다. `src/main/runtime/runtime-rpc/runtime-rpc-mobile-method-allowlist.ts:1-4` → `runtime-rpc-mobile-method-routing.ts:7-237`(execution-host 라우트). 여기에 `runtime-rpc-mobile-paired-desktop-methods.ts`(paired-desktop 라우트)와 `runtime-rpc-mobile-agent-session-methods.ts`가 더해진다.
- 릴레이 와이어 계약은 `cloud/packages/relay-contract`, 폰 쪽 릴레이 프로토콜은 `src/shared/mobile-relay-phone-protocol.ts`, 푸시는 `src/shared/mobile-push-contract.ts`와 `cloud/packages/push-contract`에 있다.
- 회귀 골든: `mobile/rpc-foundation/goldens/`(772개 JSON), `pilot-scenarios.json`.

### 2-2. 버전 협상
- 런타임 프로토콜은 `RUNTIME_PROTOCOL_VERSION = 3`, `MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION = 2`다. 정책 주석은 "범위 호환이고 앱 버전 일치는 요구하지 않는다. 메서드 삭제나 필수 파라미터 변경 때만 올린다"(`src/shared/protocol-version.ts:37-43`). 모바일용 별칭은 `:159-162`.
- 모바일은 `MOBILE_PROTOCOL_VERSION = 3`, `MIN_COMPATIBLE_DESKTOP_VERSION = 2`다(`mobile/src/transport/protocol-version.ts:4-5`). 판정 함수는 `src/shared/protocol-compat.ts:73-`이고, 버전 필드가 없으면 0으로 읽는다.
- `status.get` 응답의 `protocolVersion`, `minCompatibleMobileVersion`, `capabilities[]`, `appVersion`, `hostPlatform`, `machineName`으로 판정한다. `mobile/src/transport/host-status-reply-schema.ts:8-16`, `host-status-gates.ts:110-147`.
- 기능 단위 게이트는 capability 문자열이다(`protocol-version.ts:133-155`, 예: `mobileWeb.bundle.v1`은 `src/shared/mobile-web-bundle/mobile-web-bundle-capability.ts:2`).
- 웹 번들 호환 검사: 셸이 지원하는 번들 스키마는 `[1]`, `MOBILE_WEB_PAGE_VERSION_FLOOR = 1`이다(`mobile/src/transport/mobile-web-bundle-compat.ts:5-8`). 번들이 없으면 `bundle-unavailable` 차단 화면이 뜬다(`mobile/src/components/ProtocolBlockScreen.tsx:37`).

### 2-3. 모바일이 부르는 데스크톱 API
- **허용 메서드는 약 346개다.** 위 세 파일에 나온 고유 메서드 문자열을 센 값이다.
  - execution-host 약 214개: agent, automation, browser, clipboard, files, git, github, gitlab, host, hostedReview, markdown, nativeChat, orchestration, preflight, project, repo, session.tabs, ssh, status, terminal, worktree 등
  - paired-desktop 약 100개: accounts, aiVault, github.project, jira, linear, mobileRelay, mobileWeb.bundle, notifications, pairing, runtime.clientEvents, settings, speech.dictation, stats, ui 등
  - agentSession 35개
- 핵심 20개(아라 관점):
  1. `status.get`: 버전, capability, 호스트 정보
  2. `repo.list`
  3. `worktree.ps`: 홈 화면의 워크트리·에이전트 상태 목록
  4. `worktree.activate`
  5. `session.tabs.list`, `session.tabs.subscribe`(`subscribeAll`): 세션 탭 목록과 스트림
  6. `terminal.list`
  7. `terminal.subscribe`, `terminal.unsubscribe`: 터미널 출력 스트림(바이너리 프레임, `mobile/src/transport/rpc-client-terminal-binary-frame.ts`)
  8. `terminal.send`: 입력
  9. `terminal.updateViewport`
  10. `session.readTerminalScrollback`
  11. `terminal.agentStatus`
  12. `agentSession.subscribe`, `agentSession.send`: Chat UI
  13. `agentSession.respondToApproval`: 권한 승인
  14. `agentSession.respondToQuestion`: 질문 응답
  15. `notifications.subscribe`, `notifications.getMissedSince`
  16. `notifications.registerPush`: 푸시 토큰 등록
  17. `mobileWeb.bundle.manifest`, `mobileWeb.bundle.chunk`, `mobileWeb.bundle.range`: **화면 번들 다운로드(필수)**
  18. `settings.get`, `ui.get`
  19. `settings.getTerminalQuickCommands`
  20. `pairing.registerDeviceKey`
  - 그 밖에 `clipboard.startImageUpload` 계열, `speech.dictation.*`
- 푸시: 폰은 Orca 자격증명이 없다. **데스크톱**이 X25519 호스트 키로 `push.onorca.dev`에서 챌린지 인증을 받아(24시간 세션) 폰의 네이티브 토큰을 등록하고 푸시를 요청한다. 게이트웨이가 APNs 키를 들고 APNs/FCM으로 보낸다(`cloud/README.md:30-46`). OS 배너는 이 provider 푸시 경로로만 뜬다. 앱이 열려 있을 때는 소켓 알림으로 동작한다(같은 위치).

---

## 3. 아라가 "Orca 데스크톱인 척" 하려면

### 3-1. 최소 구현 범위 (LAN 직결, 스토어 앱 대상)
1. **페어링**: X25519 키쌍을 만들고 `orca://pair?code=` QR을 띄운다. JSON은 `{v:2, endpoint:"ws://<사내IP>:6768", deviceToken, publicKeyB64}` 하나다(relay 필드 생략). 근거: `pairing.ts:15-26`, `mobile-relay-pairing-offer.ts:69-81`.
2. **WS 서버와 E2EE v2**: hello/ready 처리, 트랜스크립트 해시, HKDF, secretbox 프레이밍, `e2ee_auth v2` 검증. Node `crypto`(hkdf)와 `tweetnacl`만으로 가능한 크기다. 근거: 1-3절.
3. **RPC 봉투와 keepalive**: `runtime-rpc-envelope.ts`.
4. **`status.get`**: `protocolVersion:3`, `minCompatibleMobileVersion:2`, `capabilities`에 `mobileWeb.bundle.v1`과 쓰려는 기능의 capability를 넣는다.
5. **웹 번들 서빙**: Orca 저장소에서 `pnpm build:mobile-web`(`package.json:148`)으로 만든 `out/mobile-web/manifest.json`과 청크를 `mobileWeb.bundle.manifest/chunk/range`로 내준다. 데스크톱 쪽 로더는 `src/main/runtime/bundled-mobile-web-bundle.ts:17-40`이다. **이 단계를 빼면 홈, 세션, 파일, 소스컨트롤, 태스크 화면이 모두 차단된다.** 해당 화면 목록: `mobile/app/h/[hostId]/index.tsx`, `session/[worktreeId].tsx`, `files/`, `source-control/`, `review/`, `tasks.tsx`, `accounts.tsx`, `automations.tsx`, `agent-history/`. 모두 `MobileWebShellScreen`을 쓴다.
6. **화면이 부르는 RPC**: 홈과 터미널만 돌리려 해도 약 30~60개가 필요하다. 참고 자료는 저장소에 있는 **모바일 개발용 mock 데스크톱** `mobile/scripts/mock-server*.ts`(약 1,790줄, 메서드 약 55개: status.get, repo.list, worktree.ps, session.tabs.*, terminal.list/subscribe/send, nativeChat.*, git.*, files.*, accounts.*, clipboard.* 등)이다.
   - 단, 이 mock은 **레거시 v1 핸드셰이크**(`mock-server.ts:30-60`)를 쓰고 `mobileWeb.bundle.*`을 구현하지 않는다. 9-18 이후 셸 구조와 맞지 않아 낡았을 가능성이 크다.
7. **개념 매핑**: Orca의 repo/worktree/session tab/agentSession 모델에 아라의 SSH 세션과 AI CLI 세션을 끼워 맞춰야 한다. 예: 아라 세션 1개를 가짜 worktree 1개와 터미널 탭 1개로 둔다.

**규모 추정**: 핸드셰이크와 서버 골격은 수백 줄이다. 실제로 쓸 만한 화면(홈, 터미널, 승인/질문)까지 가면 RPC 40~80개와 스트림 프레임 형식을 맞춰야 한다. 거기에 Orca 번들 빌드 파이프라인까지 떠안는다.

### 3-2. 버전 검사로 막히나
- 지금은 막히지 않는다. 범위 호환(데스크톱 ≥2)이고 버전 필드가 없으면 0으로 읽는다.
- 대신 화면 번들은 **아라가 서빙한 Orca 빌드의 페이지**이므로, 셸(스토어 앱)과 페이지 버전 사이가 어긋날 위험을 아라가 진다.

### 3-3. 앱 버전업 때 깨질 위험: 높음
- 호환 정책 코드는 있다(`protocol-version.ts:37-43`: "Raise minimum client/server versions to refuse unsupported peers"). 그러나 그 최소값을 올리는 쪽은 Stably다.
- 셸이 `SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS`나 `MOBILE_WEB_PAGE_VERSION_FLOOR`를 올리면 아라가 들고 있는 번들이 거부된다(`mobile-web-bundle-compat.ts:5-8`).
- 변경 빈도: 8-28 이후 `mobile/`에 **1,080개 커밋**이 들어갔다(`git log 94e75866..HEAD -- mobile`). 앱 버전은 `0.0.61`(`mobile/app.json:5`), 베타다(`mobile.mdx:11`).
- 스토어 앱은 자동 업데이트되므로 사내 폰의 버전을 고정할 수 없다(Android APK는 수동 설치라 고정할 수 있다).

---

## 4. 막히는 점

| 항목 | 판단 | 근거 |
|---|---|---|
| 스토어 앱이 공식 릴레이나 계정에 묶였나 | **LAN은 안 묶였다.** Relay만 로그인과 `login.onorca.dev` 토큰이 필요하다. 앱은 릴레이 도메인을 고정하지 않고 QR의 HTTPS origin을 따른다. | `mobile-pairing-connection-mode.ts:3-28`, `mobile-relay-pairing-offer.ts:18-52`, `mobile/src`에서 `onorca`는 진단·개인정보 링크에만 나온다 |
| 푸시 알림 | **스토어 앱은 Stably 게이트웨이를 거쳐야만 받는다.** APNs 키와 FCM 프로젝트(`onorca-cloud`)가 Stably 소유라 자체 게이트웨이로는 스토어 앱에 푸시를 보낼 수 없다. 외부로 보내야 하므로 DLP상 불가. 앱이 켜져 있을 때의 소켓 알림만 가능하다. | `cloud/README.md:30-46`, `push-gateway-origin.ts:4`, `google-services.json:4` |
| 라이선스 | 코드는 **MIT**(루트 `LICENSE`, "Copyright (c) 2026 Lovecast Inc."). `mobile/`에 별도 LICENSE는 없고 루트를 따른다. `cloud/`도 루트 MIT라고 명시돼 있다(`cloud/README.md:10-11`). 상표 파일은 없지만 "Orca" 이름과 로고는 상표로 다루는 게 안전하니 포크 빌드에서는 이름과 아이콘을 바꿔야 한다. | `LICENSE:1-3` |
| 번들 ID | `com.stably.orca.mobile`(iOS/Android), URL scheme `orca`. 포크 빌드에서는 바꿔야 한다(스킴이 겹치면 딥링크 충돌). | `mobile/app.json:9,31,91` |
| 사내망과 LTE | 폰이 사내 Wi-Fi(같은 L3 경로)에 있어야 LAN 직결이 된다. LTE에서는 릴레이나 VPN/Tailscale이 필요하다. | `mobile.mdx:120,129` |
| 자체 릴레이 | 릴레이 서버 코드는 **저장소에 있다**(`cloud/apps/relay`, `relay-contract`, `push`). 하지만 운영 Terraform과 인증 서비스(JWT 발급자)는 비공개 `stablyai/orca-cloud`에 있다. 자체 호스팅하려면 자체 JWT 발급자(JWKS)와 Postgres가 필요하고, 아라 쪽에도 데스크톱 릴레이 클라이언트(`src/main/runtime/mobile-cloud-relay/`, 비테스트 약 4.8천 줄)를 구현해야 한다. | `cloud/README.md:67-72, 98-100`, `cloud/apps/relay/src/config.ts:50-52` |
| Android APK 직접 설치 | 가능하다. 공식 APK는 `onorca.dev/download`에서 받는다(웹 조회 금지라 확인은 안 함). 문서는 브라우저 다운로드와 "알 수 없는 앱 설치" 허용 절차만 다룬다. 업데이트 확인은 GitHub Releases `mobile-android-v*`를 조회한다. | `docs/site/content/docs/android-apk.mdx:7-21`, `github-release-update-source.ts:20-22` |
| 아웃바운드 호출 | 스토어 앱은 업데이트 확인(itunes, api.github.com)을 하고, 진단 제출(onorca.dev)도 사용자가 누르면 나간다. DLP 환경에서 차단 대상 목록에 올려야 한다. | 1-5절 |

---

## 5. 결론

**판정: 조건부 가능.** 조건은 LAN 직결, 푸시 없음, 높은 유지보수 부담이다. "앱만 빌리기"(스토어 앱 + 아라 = 가짜 데스크톱)는 **비추천**이다.

- 되는 것: 계정·클라우드 없이 사내 Wi-Fi에서 QR 페어링, E2EE v2, 터미널 보기/입력, 상태 보기. 프로토콜은 공개돼 있고 MIT이며, 버전 검사도 범위 호환이라 당장 막히지는 않는다.
- 막히는 것: ① 화면이 데스크톱 제공 웹 번들이라 아라가 Orca 번들을 빌드해 서빙해야 하고 그 번들이 기대하는 RPC 의미까지 맞춰야 한다. ② 푸시는 Stably 클라우드에서만 된다. ③ 스토어 앱이 자동 업데이트되면 예고 없이 깨진다(8-28 이후 1,080 커밋). ④ LTE 외부 접근에는 릴레이가 필요한데 자체 호스팅 비용이 크다.

**v4 결론(묶음 9): Claude 원격 제어 1차 + Orca 스토어 앱 연결 3차(사내 Wi-Fi 직결 실측 전제). 자체 포크는 대안이다.**

위 "비추천"은 v3 시점의 판단이다. v4 에서 다시 평가한 근거는 다음과 같다.
- **막히는 것 ①(번들·RPC)이 작아졌다.** 런타임·데몬·orcad 를 1차로 Orca 따라 이식하므로(묶음 3·8), 모바일이 부르는 RPC 대부분이 아라에 생긴다. 화면 번들도 추적 중인 Orca 커밋에서 빌드해 서빙한다.
- **iOS 도 된다.** 스토어 앱을 쓰므로 Apple 개발자 계정·사내 배포 경로가 필요 없다.
- **남는 제약**:
  - ② 푸시는 Stably 게이트웨이 전용이다 → 앱이 켜져 있을 때 소켓 알림만 받는다.
  - ③ 스토어 앱은 자동 업데이트된다 → 주간 점검(F절)에 모바일 프로토콜 경로를 더하고 Orca 를 늦지 않게 따라간다.
  - ④ 밖(LTE) 접속은 Orca 릴레이(Orca 계정 필요) 또는 사내 VPN 이다 — **미정**.
  - 사내 Wi-Fi 직결은 조건부다. 무선 클라이언트 격리, 유무선 망 분리, Windows 방화벽(6768 인바운드)에 막힐 수 있다 → 3차 착수 전에 실측한다.

**1차 — Claude 원격 제어 자동 켜기**(준영님 제안, 문서 `code.claude.com/docs/en/remote-control` 확인 — 결정 기록 묶음 9)
- 켜는 법: 사용자 settings 의 `remoteControlAtStartup: true`(프로젝트 설정의 true 는 무시된다) 또는 `claude --rc`. 대화형 세션에만 된다.
- 네트워크: 인바운드 없음. Anthropic 으로 나가는 443 만 쓴다.
- 요금제: Pro/Max/Ultra/Team/Enterprise, API 키는 안 된다. Team/Enterprise 는 Owner 가 관리자 설정에서 켜야 한다(사내 Team 플랜, 켜져 있음).
- 폰에서: 프롬프트·출력·diff·권한/질문 응답·푸시 알림·새 세션 시작. 서버 모드(`claude remote-control`)는 최대 32 세션, `--spawn worktree`.
- 제약: Claude Code 만 된다. `-p`/stream-json/Agent SDK 세션에서 켜는 방법은 문서에 없다 → **채팅 화면(묶음 7)은 Claude 세션을 원격 제어가 되는 방식으로 띄워야 한다.** PTY 대화형은 될 것으로 보이나 아라가 띄운 세션에서 실제로 켜지는지 시험해야 한다. OS 지원 표기는 없다.
- Codex·Gemini·서버 터미널은 이 경로로 안 된다 → 3차 Orca 앱 연결이 맡는다. 밖에서 전 에이전트를 조종하는 다른 길은 Slack 연결(A §13, 2차)이다.

**대안 (자체 포크 등 — 스토어 앱 연결이 막힐 때)**
1. **포크 빌드 사내 배포**: `mobile/`을 포크해 번들 ID, 이름, 스킴을 바꾸고 외부 URL(업데이트 확인, 진단, 푸시)을 제거하거나 사내로 돌린 APK를 사내 배포한다. 아라 쪽은 필요한 RPC 부분집합만 구현하고, 버전은 둘 다 우리가 고정한다. 셸과 번들을 같은 커밋에서 빌드하면 호환 위험이 사라진다. iOS는 사내 배포 경로(Enterprise/ABM)가 필요하다.
2. **더 가볍게**: 아라에 자체 모바일 웹 페이지(PWA)를 두고, 사내 Wi-Fi와 사내 인증으로 터미널 보기, 승인, 질문 응답만 제공한다. Orca 코드는 E2EE v2 설계(1-3절)와 화면 아이디어만 참고한다. 유지보수 부담이 가장 작다.
3. 외부망(LTE) 접근이 꼭 필요할 때만 사내 VPN을 쓴다. 자체 릴레이(`cloud/apps/relay` + 자체 JWKS)는 그 다음 단계다.

---

## C-6. 모바일 앱 기능 목록 (v4 — Orca 스토어 앱 연결 3차)

v4 분류: 이식 20 · 전역 겹침 1(받아쓰기 — 아라 음성 유지) · 사내 부적합 1(작업(이슈) — 외부 SaaS). 우선순위는 이식 20행 모두 3차다(묶음 9: 모바일 기능 목록은 Orca 앱 연결 3차에 묶는다). v3 의 2차 6행(연결·암호화·데스크톱 제공 화면·홈·터미널·승인 응답)을 3차로 내렸다. 그 사이 1차에서는 Claude 세션만 Claude 앱 원격 제어로 폰에서 다룬다. 에이전트 계정 전환은 데스크톱에서 계정 여러 개가 2차가 됐으므로(묶음 6) 이식으로 옮겼다. "아라가 받쳐 주려면" 칸은 스토어 앱 기준으로 고쳤다(푸시는 앱이 켜져 있을 때만, 앱 업데이트는 스토어 앱이 맡음).
v3 는 자체 포크 기준으로 연결 묶음을 2차, 나머지를 3차로 두었다.
v2 는 분류를 전부 **보류(모바일)** 로 두었다. "앱만 빌리기"는 권하지 않는다는 결론(위 C-5)에 따른 것이었다. 아래 "8-28 이후"는 전체 이력에서 파일 최초 추가일과 8-28 이후 추가된 파일 비율로 다시 판정했다. 지난 판은 얕은 클론 탓에 8-27 일괄 추가를 "기존"으로 읽었고, 그래서 몇 행은 거꾸로 "신규"로 잘못 적혀 있었다(받아쓰기·계정 전환).
`mobile/` 전체: 최초 추가 05-04, 파일 4,828개 중 3,386개(70%)가 8-28 이후 추가, 커밋 1,080개. `cloud/`(릴레이·푸시): 09-03 신규, 845개 전부 8-28 이후.

| 기능 | 한 줄 설명 | Orca 근거 | 8-28 이후 | 아라가 받쳐 주려면 | 분류 | 우선순위 | 사내 메모 |
|---|---|---|---|---|---|---|---|
| QR·코드로 휴대폰 연결 | QR 스캔 또는 코드 붙여넣기로 데스크톱과 연결, LAN/릴레이 선택 | `mobile/app/pair-scan.tsx`, `src/shared/pairing.ts` | 기존(05-04) | 하 | AI 작업 공간으로 이식 | 3차 | LAN 직결은 계정이 필요 없다. 착수 전 사내 Wi-Fi 직결 실측(무선 격리·망 분리·방화벽 6768). 밖(LTE)은 Orca 릴레이(Orca 계정) 또는 사내 VPN — 미정 |
| 종단 암호화 직결 | X25519 + HKDF + secretbox | `src/shared/mobile-e2ee-v2-contract.ts` | 기존(07-14) | 하~중 | AI 작업 공간으로 이식 | 3차 | 사내 평문 ws 위에 앱 계층 암호화 |
| 데스크톱이 내려주는 화면 | 홈·세션·파일 등 주요 화면을 데스크톱 웹 묶음으로 띄움 | `mobile/src/mobile-web-shell/`, `src/shared/mobile-web-bundle/` | **신규(09-18)** | 상 | AI 작업 공간으로 이식 | 3차 | 추적 중인 Orca 커밋에서 빌드해 서빙. 스토어 앱이 자동 업데이트되면 어긋날 수 있다 → 주간 점검에 모바일 프로토콜 경로 추가 |
| 호스트 홈 | 모든 호스트의 워크트리와 에이전트 상태 | `mobile/src/home/` | 변경(08-24, 절반 재작성) | 중 | AI 작업 공간으로 이식 | 3차 |  |
| 터미널 보기·입력 | 스크롤백, 실시간 입력, 보조 키 | `mobile/src/terminal/TerminalWebView.tsx` | 기존(05-04) | 중 | AI 작업 공간으로 이식 | 3차 | 핵심 가치 |
| 채팅형 세션 | 대화 기록과 입력창 | `mobile/src/session/` | **변경(대폭: 942개 중 624개 신규)** | 상 | AI 작업 공간으로 이식 | 3차 |  |
| 승인·질문 응답 | 에이전트 권한 요청 승인, 질문에 답 | `mobile/src/session/use-mobile-structured-prompt-responses.ts` | **신규(09-06)** | 중~상 | AI 작업 공간으로 이식 | 3차 | Claude 세션은 1차에 Claude 앱 원격 제어로 먼저 된다 |
| 빠른 명령 | 저장한 명령·프롬프트 실행, 데스크톱과 동기화 | `mobile/src/terminal/quick-commands.ts` | 기존(07-19) | 하 | AI 작업 공간으로 이식 | 3차 |  |
| 이미지·파일 첨부 | 사진·파일을 터미널·채팅으로 업로드 | `clipboard.startImageUpload` 계열 | 기존 | 중 | AI 작업 공간으로 이식 | 3차 | DLP: 휴대폰에서 사내 PC 로 반입하는 경로 |
| 음성 받아쓰기 | 마이크 입력을 데스크톱 음성 인식으로 전사 | `mobile/src/dictation/` | 변경(06-15, 절반 신규) — 지난 판 "신규" 정정 | 상 | 전역 기능과 겹침 | — | 아라 전역 음성 기능과 겹친다(결정 2) |
| 푸시 알림 | 에이전트 완료 등 휴대폰 알림 | `mobile/src/notifications/`, `cloud/apps/push/` | **신규(09-06)** | 하(앱이 켜져 있을 때만) | AI 작업 공간으로 이식 | 3차 | 스토어 앱 푸시는 Stably 게이트웨이 전용 → 앱이 켜져 있을 때 소켓 알림만. 자체 포크(대안)로 가면 자체 푸시 |
| 파일 탐색·미리보기 | 워크스페이스 파일 트리 | `mobile/src/files/` | 변경(06-15, 절반 신규) | 중 | AI 작업 공간으로 이식 | 3차 |  |
| 소스 컨트롤 | 변경 파일, 스테이지, 커밋, diff | `mobile/src/source-control/` | 변경(05-17) | 중~상 | AI 작업 공간으로 이식 | 3차 |  |
| 브라우저 미러 | 데스크톱 브라우저 화면 스트리밍과 터치 조작 | `mobile/src/browser/` | 변경(05-18, 2/3 신규) | 상 | AI 작업 공간으로 이식 | 3차 |  |
| 새 워크스페이스 만들기 | 브랜치·이슈에서 생성 | `mobile/app/new-workspace.tsx` | **신규(10-21)** | 상 | AI 작업 공간으로 이식 | 3차 |  |
| 작업(이슈) | GitHub·Linear·Jira 이슈 보기·생성 | `mobile/src/tasks/` | 변경(05-21, 2/3 신규) — 지난 판 "신규" 정정 | 상 | 사내 부적합(클라우드·계정) | — | 외부 SaaS |
| 에이전트 계정 전환 | Claude·Codex 계정 선택, 사용량 | `mobile/src/accounts/` | 기존(08-04) — 지난 판 "신규" 정정 | 중 | AI 작업 공간으로 이식 | 3차 | 계정 여러 개 전환은 데스크톱 2차(묶음 6) 다음 |
| 에이전트 기록 | 지난 세션 검색과 재개 | `mobile/src/agent-history/` | 변경(07-10, 절반 신규) | 상 | AI 작업 공간으로 이식 | 3차 |  |
| 자동화 | 예약 자동화 목록·생성·실행 | `mobile/src/automations/` | **신규(10-30)** | 상 | AI 작업 공간으로 이식 | 3차 |  |
| 앱 업데이트 안내 | 앱스토어·GitHub Releases 조회 | `mobile/src/app-update/` | 신규(09-28) | —(스토어 앱이 맡음) | AI 작업 공간으로 이식 | 3차 | 스토어 앱이 자동 업데이트한다 → 주간 점검에 모바일 프로토콜 경로를 더해 Orca 를 늦지 않게 따라간다. 자체 포크(대안)면 사내 배포 서버 |
| 연결 기록·문제 해결 | 연결 로그와 진단 제출 | `mobile/app/connection-log.tsx`, `troubleshoot.tsx` | 기존(05~07) | 하 | AI 작업 공간으로 이식 | 3차 | 진단 제출은 onorca.dev 로 나간다 — DLP 차단 목록에 올린다 |
| 여러 데스크톱·주소 편집 | 여러 데스크톱에 동시 연결, 다시 연결하지 않고 주소 변경 | `docs/site/content/docs/mobile.mdx:31-32` | 기존 | 하 | AI 작업 공간으로 이식 | 3차 |  |

모바일 신규: 6행(데스크톱 제공 화면·승인 응답·푸시·새 워크스페이스·자동화·업데이트 안내). 지난 판 "신규" 9행 중 3행(받아쓰기·작업·계정 전환)을 정정했다.

---

# D. 8-28 이후 변화 요약 (`94e75866..7a7f46f8a3`)

이번 판은 전체 이력(`git fetch --unshallow`, 루트 커밋 2026-03-16, 총 18,264 커밋)을 기준으로 했다. 범위 안 수치는 v1 과 같다.

| | 8-28 (`94e75866`) | 10-31 (`7a7f46f8a3`) |
|---|---:|---:|
| 커밋 | — | **8,866**(스쿼시 머지, 머지 커밋 0) |
| `src` `.ts/.tsx` | 16,840 (테스트 6,757) | **33,367** (테스트 13,099, 39%) |
| `src` 최상위 | cli main preload **relay** renderer shared types | cli main **packages** preload renderer shared types **wsl-guest** |
| 안정 태그 | v1.4.192 (8-29) | v1.4.245 (10-30), 53개 |

- 커밋 종류: fix 4,024 · test 905 · **feat 768** · perf 763 · refactor 540.
- feat 범위 상위: native-chat 106 · mobile 105 · relay 62 · wsl 34 · browser 34 · sidebar 25 · ssh 24.

### 큰 줄기

1. **채팅 화면이 주 화면이 됐다.** `src/main/acp`(10-05, Agent Client Protocol 호스트)가 새로 생겼다. 채팅 세부 기능 대부분이 8-28 이후 신규다(A §3). `src/main/native-chat` 은 1,177 파일 중 963개가 8-28 이후 추가됐다.
2. **모바일과 클라우드 릴레이가 붙었다.** 루트에 `cloud/`(09-03, 845 파일 전부 신규: relay·push·connector)가 생겼다. 데스크톱이 모바일 화면을 서빙하는 구조는 09-18부터다. `mobile/` 은 4,828 파일 중 70% 가 8-28 이후 추가됐다.
3. **SSH 릴레이를 지우고 orcad 만 남겼다.** 10-10 `#27214`(orcad 가 못 붙는 호스트는 연결 실패)과 `#27215`(릴레이 서버 삭제) 때문이다. WSL 게스트는 `src/wsl-guest` 로 분리됐다. v2 는 이 원격 실행 층을 아라 원칙(원격에 아무것도 안 깐다)과 반대 방향이라 보류로 두었다. v3 는 AI 작업 공간에 한해 이 제약을 풀었으므로(결정 5) orcad 를 이식 2차로 둔다. 터미널 쪽 원칙은 그대로다.
4. **프로세스 실행을 패키지로 분리했다.** `src/packages/process-host`(10-09)가 생겼다.
5. **WSL 이 1급 기능이 됐다.** WSL 호스트, `wsl-move`, `wsl-drive-project`(10-28)가 들어왔다.
6. **새 main 폴더 36개**(최초 추가일 기준, 전체 이력으로 확인):
   - updater(08-30), ai-vault-search·notifications(09-10), agent-launch(09-15)
   - 프로바이더 10개: opencode2, muse, jcode, zcode, dsh, qoder, codebuddy, qwen-code, kiro, omp
   - notebook(09-23), ripgrep(09-24), cursor-accounts·macos-keychain(09-25), credentials·foreign-sqlite-readers(10-02), managed-data-accounts(10-03)
   - acp·provider-process(10-05), media·jsonl-rpc(10-07), remote-layout-snapshot(10-11), worker-thread-child-process(10-12), node-runtime(10-13)
   - managed-server(10-19), external-conversations·ephemeral-vm(10-22), connector-cloud(10-26), link-preview(10-29)
   - 새 렌더러 폴더: gitlab-item-dialog, link-actions, unexpected-signout, managed-runtime, host-picker, plain-ssh-terminal, standalone-terminal, plugins, wsl-drive-project, wsl-move
7. **제거된 것:** `src/relay` 전체, 렌더러 `plugin-catalog`(`plugins` 로 흡수).

---

# E. 구조 요점 + Electron 맞추기 재료

## E-1. 모듈 경계 — 이식 단위

| 층 | 위치 | 규모·특징 |
|---|---|---|
| main | `src/main/<도메인>/` | 도메인 폴더 약 130개. `runtime/` 1,359 · `daemon/` 638 파일 |
| IPC(main) | `src/main/ipc/` | 620 파일, 기능마다 `*-ipc.ts` |
| preload | `src/preload/api/` | 160 파일. `*-api.ts`(타입)와 `*-bridge.ts`(구현) 쌍 |
| RPC 계약 | `src/shared/rpc-contract/` | 런타임·원격·모바일용 zod `*-params.ts` |
| renderer | `src/renderer/src/components/<영역>/`(60여 폴더) | 이식 단위로 가장 자연스럽다 |
| 상태 | `src/renderer/src/store/` | **zustand 5 단일 스토어 + 슬라이스**(`store/index.ts`) |
| 공유 패키지 | `src/packages/process-host`(유일) | `native/*` 는 네이티브 모듈. `cloud/`·`mobile/` 은 독립 워크스페이스 |
| 테스트 | `*.test.ts(x)` 동거 + `tests/e2e`(Playwright) + 픽스처 스크린샷 | vitest 5, 39% |

**이식할 때 유의할 점이 둘 있다.**
- 기능 하나가 다섯 자리(main 도메인 · ipc · preload 쌍 · store 슬라이스 · 컴포넌트)에 흩어져 있다. 그래서 대응표의 `orcaPaths` 도 이 다섯 자리를 모두 담았다.
- 거의 모든 기능이 "호스트 선택(로컬/WSL/SSH/원격 런타임)"을 인자로 받는다. v3 는 원격·데몬을 허용하므로(결정 5·6) 이 축을 살려 둘 수 있다. 다만 1차는 로컬부터 하고 원격 호스트는 2·3차에 붙이므로, 처음엔 호스트 축을 로컬 하나로 좁혀 옮긴다. 그래서 여전히 **복사보다 재작성에 가깝다**.

## E-2. Electron 맞추기 재료

> 원문 조사(전부): 아래 절. 근거는 `D:\AI\OFA` 코드(파일:줄)와 electronjs.org breaking-changes·릴리스 문서다. 아라 현재 설치본은 `electron 31.7.7`(`node_modules/electron/package.json`)이다.
> 메인이 두 곳을 직접 확인했다: `src/renderer/store/pasteFiles.ts:76`(`File.path` 사용)과 `vitest.config.ts:22`(`poolOptions.forks.singleFork`).


조사일 2026-10-31 · 읽기 전용 · 아라 `D:\AI\OFA` (master a0a024e) / Orca `D:\orca` (7a7f46f8a3)

출처
- [E-BC] https://www.electronjs.org/docs/latest/breaking-changes
- [E31] https://www.electronjs.org/blog/electron-31-0 · [E43] https://www.electronjs.org/blog/electron-43-0
- [X6] https://github.com/xtermjs/xterm.js/releases/tag/6.0.0

---

### 1. 버전 대조표

| 패키지 | 아라 선언 (설치본) | Orca | 비고 |
|---|---|---|---|
| electron | ^31.3.1 (31.7.7) | 43.8.4 (고정) | |
| └ Chromium / Node / V8 | 126.0.6478.36 / 20.14.0 / 12.6 (31.0.0 기준 [E31]) | 150.0.7871.46 / 24.17.0 / 15.0 [E43] | 31.7.7 의 패치 Node 는 실행 금지라 미확인 |
| electron-vite | ^2.3.0 (2.3.0) | ^6.0.0 | |
| electron-builder | ^24.13.3 | 26.15.3 | |
| electron-updater | ^6.8.9 | ^6.8.10 | 사실상 동일 |
| vite | ^5.4.0 (5.4.21) | ^8.3.5 | Rolldown 기반 |
| @vitejs/plugin-react | ^4.3.1 (4.7.0) | ^6.1.2 | |
| react / react-dom | ^18.3.1 | ~19.2.8 | |
| @types/react / -dom | ^18.3.x | ~19.2.x | |
| typescript | ^5.5.4 (5.9.3) | ^7.0.2 (+ `typescript-api: npm:typescript@6.0.3`) | TS7 은 Go 네이티브, JS API 없음 → Orca 는 API 소비자용으로 6 을 별칭 설치 |
| @types/node | ^22.5.0 | ^24.19.2 | |
| @xterm/xterm | ^5.5.0 | 6.1.0-beta.304 (패치) | |
| @xterm/headless | ^5.5.0 | 6.1.0-beta.303 | |
| @xterm/addon-fit/search/unicode11/web-links/webgl | 0.10/0.15/0.8/0.11/0.18 | 0.12/0.17/0.10/0.13/0.20 beta (search·webgl 패치) | |
| node-pty | ^1.1.0 (1.1.0) | ^1.1.0 (패치) | 같은 버전 |
| ssh2 | ^1.17.0 | ^1.17.0 (`allowBuilds: ssh2: false`) | 같은 버전 |
| ws | ^8.21.2 | ^8.22.0 (패치) | |
| vitest | ^2.0.5 (2.1.9) | 5.0.5 (패치) | |
| @playwright/test | ^1.62.1 | ^1.64.1 | |
| lucide-react | ^1.31.0 | ^0.577.0 | **아라가 더 새것** — 건드릴 필요 없음 |
| zod | 4.4.3 | ~4.6.7 | 마이너 |
| react-markdown / remark-gfm | ^10.1.0 / ^4.0.1 | 동일 | |
| Node(빌드 호스트) | 현재 v22.17.0 | engines `24`, pnpm 12 | |

#### Orca 의 패치(D:\orca\pnpm-workspace.yaml `patchedDependencies`, config/patches) — 우리에게 필요한가

| 패치 | 내용 | 아라에 필요? |
|---|---|---|
| node-pty@1.1.0 | binding.gyp: Linux GCC9 용 `gnu++2a`, **Windows `SpectreMitigation` 제거**, **winpty 타깃 제거**; mac/linux fd 재사용 방어(terminal.js·unixTerminal.js·pty.cc); `conpty_console_list_agent` 의 AttachConsole 실패 try/catch | 대부분 불필요(prebuilds 사용). 단 아라는 macOS 도 지원하므로(결정 12) mac fd 재사용 방어는 맥 빌드 때 가치가 생긴다(E-3). 소스 재빌드할 일이 생기면 Spectre 라이브러리 미설치 빌드 실패 회피용으로 binding.gyp 부분만 가치 있음. console_list try/catch 는 셸 종료 직후 크래시 방어라 **선택적으로 가치 있음** |
| @xterm/xterm 6.1 beta | IME CompositionHelper, MouseService, WidthCache, InputHandler 수정 | xterm 6 으로 갈 때만 의미. 5.5 유지면 불필요 |
| addon-webgl / search / serialize / image / ligatures | 렌더·검색 캐시·직렬화 수정 | 동일 — xterm 6 동반 시만. 아라는 serialize·image·ligatures 미사용 |
| ws@8.22.0 | sender.js 19줄 | 불필요 (아라 8.21) |
| vitest@5.0.5 | Orca 자체 pool 관련 | vitest 5 로 가면 내용 확인 필요 |

---

### 2. 아라 네이티브 모듈 · wasm

| 모듈 | 형태 | 현재 로드 경로 | Electron 43 위험 | 대응 |
|---|---|---|---|---|
| node-pty 1.1.0 | node-addon-api(N-API) — `node_modules/node-pty/binding.gyp:4` | `prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node` 사용(build/Release 엔 conpty.dll·OpenConsole.exe 만). 로더는 build/Release → build/Debug → prebuilds 순(`node_modules/node-pty/lib/utils.js:19`) | **낮음**: N-API 는 ABI 독립이라 prebuild 그대로 동작. 단 electron-builder `npmRebuild`(기본 true, yml 에 설정 없음)가 패키징 때 소스 재빌드를 시도 → Electron 33+ 는 **C++20 필수**[E-BC 33], VS2022 + Spectre 완화 라이브러리 필요 | `electron-builder.yml` 에 `npmRebuild: false` 검토(prebuild 로 충분), 또는 VS2022 C++20·Spectre 라이브러리 준비. `asarUnpack: node_modules/node-pty/**`(electron-builder.yml:9) 유지. `useConpty/useConptyDll`(src/main/sessions/PtyBackend.ts:180) 그대로 |
| ssh2 1.17 `sshcrypto.node` | **nan** + OpenSSL 헤더 (`lib/protocol/crypto/binding.gyp`) | install.js 가 **시스템 Node**용으로 빌드(`--target=${process.version}`) → Electron 에선 이미 로드 실패 → JS 폴백 (`lib/protocol/crypto.js:29-33` try/catch) | **낮음**(지금과 같음). npmRebuild 가 Electron 43 헤더로 다시 빌드하면 BoringSSL·C++20 때문에 실패 가능 → 그래도 optional | Orca 처럼 빌드 자체를 끄는 게 단순(`allowBuilds ssh2:false`). 실패 로그만 무시 |
| cpu-features 0.0.10 | **nan**, ssh2 의 optional | `build/Release/cpufeatures.node`(시스템 Node ABI) → Electron 에선 이미 실패 → try/catch(`ssh2/lib/protocol/constants.js:6-8`) | 낮음 | 동일. Orca 는 beforeBuild 에서 cpu-features 재빌드를 건너뜀(config/electron-builder.config.cjs:733 주석) |
| @devolutions/iron-remote-desktop-rdp (vendor) | Rust→**wasm**, base64 data: URL 내장 | 렌더러 | **낮음**: wasm(simd128·bulk-memory)은 Chromium 150 에서 문제 없음. 위험은 번들러 쪽 — `electron.vite.config.ts` 의 `rdpWasmDataUrlFix`(vite:asset-import-meta-url 회피, dev 전용)가 vite 8 에서도 필요한지/동작하는지 재확인 | vite 8 전환 후 `npm run check:rdpwasm` + dev 실행으로 RDP init 확인 |
| @rollup/rollup-win32-* , esbuild | 빌드 도구 네이티브 | — | vite 8 은 rolldown 으로 교체 → 아래 4절 esbuild 항목 | |
| playwright-core webp_codec.wasm | 테스트 | — | 무관 | |

---

### 3. Electron 32~43 breaking changes ↔ 아라 코드

[E-BC] 에서 32~43 항목 58개 중 아라에 걸리는 것만. (macOS·Linux 전용, OSR, extensions, WebUSB 등은 해당 없음 — grep 0건)

#### 해당 있음

| 버전 | 변경 | 아라 위치 | 판정 |
|---|---|---|---|
| 32 | **`File.path` 제거** → `webUtils.getPathForFile` | `src/renderer/store/pasteFiles.ts:76` (정본 `filePaths()`), `src/renderer/components/AraChatPanel.tsx:418` (`(f as File & {path?}).path` 직접 검사) · 호출처 FileTree.tsx:1052·1070, AraChatPanel.tsx:416, RdpView.tsx(import 18) | **업그레이드 전에 먼저 고칠 것(작음, 결정 9)**: 그냥 올리면 경로가 빈 배열이 되어 드래그앤드롭·붙여넣기 파일이 조용히 사라지고, AraChatPanel 은 모든 파일을 `saveClipFile` 로 임시 저장해 버린다. 대응: preload 에서 `webUtils.getPathForFile` 을 contextBridge 로 노출하고 `filePaths()` 와 AraChatPanel.tsx:418 두 곳을 그걸로 바꾼다. **지금 31 에서 먼저 바꿀 수 있다**: 설치본 `node_modules/electron/package.json` 은 31.7.7 이고, `node_modules/electron/electron.d.ts:17319-17332` 에 `interface WebUtils { getPathForFile(file: File): string }` 이 있으며 `:22439` 에서 `Renderer` 네임스페이스(preload 에서 쓰는 쪽)에 `const webUtils` 로 내보낸다. 같은 주석이 "This method superseded the previous augmentation to the `File` object with the `path` property" 라고 적는다. webUtils 가 처음 들어온 판은 Electron 29 다(Electron 29 릴리스 노트 기준 — 이번엔 웹 조회 없이 설치본 타입으로만 확인했다). (FileTree.tsx:1064-1065 주석이 이미 이 날을 예고) |
| 32 | `webContents.goBack/goForward/canGoBack/canGoForward` **deprecated** → `navigationHistory` | `src/main/browser/BrowserService.ts:79-84`, `src/main/browser/BrowserTabs.ts:243` | 경고만(43 까지 제거 공지 없음). 같이 바꾸는 게 싸다: `wc.navigationHistory.canGoBack()/goBack()` |
| 32 | `userData/databases` 첫 실행 시 삭제(WebSQL) | userData 경로 `src/main/index.ts:117-118` | 아라는 WebSQL 미사용 → 영향 없음(확인용) |
| 33 | 네이티브 모듈 **C++20 필수** | 2절 | 재빌드 경로에만 해당 |
| 33 | `registerFileProtocol`·Windows 파일 경로 커스텀 프로토콜 | grep 0건 (protocol API 미사용) | 해당 없음 |
| 34 | Windows 전체화면에서 메뉴바 숨김 | `Menu.` 사용 0건, 기본 메뉴 | 영향 미미 |
| 35 | `console-message` 인자 → details 객체 | grep 0건 | 해당 없음 |
| 36 | `app.commandLine` 스위치 소문자화 | `src/main/index.ts:117` `hasSwitch('user-data-dir')` — 이미 소문자 | 안전. e2e 가 `--user-data-dir` 로 격리하므로 회귀 시 실데이터 오염(주석 index.ts:110-116) → 업그레이드 후 `tests/userDataPath.test.ts` + e2e 1회 필수 |
| 39 | `window.open` 팝업 항상 resizable | `src/main/rdp/RdpWindows.ts:153-165` (RDP 다중 모니터 자식 창), 호출 `src/renderer/store/rdpMirror.ts:69` | 동작 변화: 자식 창이 리사이즈 가능해짐. 모니터를 덮는 창이라 막고 싶으면 `overrideBrowserWindowOptions` 에 `resizable: false` 추가 |
| 40 | 렌더러의 `clipboard` 모듈 deprecated | 아라는 이미 main 경유 (`src/main/ipc/registerWindowIpc.ts:4`, `src/preload/index.ts:363`, `src/renderer/store/clipboardWrite.ts`) | 해당 없음 |
| 42 | `electron` postinstall 이 바이너리를 안 받음 → 첫 실행 때 다운로드, `ELECTRON_SKIP_BINARY_DOWNLOAD` 미지원 | `npm run smoke`·e2e·`electron tests/*.cjs` 스크립트 전부 | **사내망(DLP/프록시)에서 첫 실행 다운로드 실패 가능**. CI/배포 PC 에서 `install-electron` 선실행 또는 미러(ELECTRON_MIRROR) 확인 |
| 42 | Notification(mac) 서명 필요 | `src/renderer/store/aiQuietWatch.ts:66` (Web Notification) | Windows 무관, mac 빌드는 ad-hoc 서명이라 실패 이벤트 가능 |
| 43 | **dialog `defaultPath` 기본값 = 다운로드 폴더** | `src/main/ipc/registerFsIpc.ts:15`, `src/main/ipc/registerSftpIpc.ts:58·63·68`, `src/main/ipc/registerSessionLogIpc.ts:46` (파일명만 넘김) | 동작 변화: "마지막 폴더 기억"이 사라진다. 원하면 마지막 디렉터리를 저장해 `defaultPath` 로 넘긴다 |
| 43 | 다운로드가 기본으로 Downloads 에 저장 | 내장 브라우저 `src/main/browser/*` (will-download 핸들러 없음) | 사용자 체감만 |

#### 확인했고 해당 없음 (grep 0건 또는 이미 신 API)

BrowserView(이미 `WebContentsView` — BrowserTabs.ts:18·161) · `session.setPreloads/getPreloads` · `webContents.getPrinters`/`PrinterInfo.isDefault` · `ipcRenderer.sendTo` · `systemPreferences`(isAeroGlassEnabled 등) · `nativeTheme` · `protocol.register*Protocol`/`protocol.handle` · `webFrame`(routingId) · `crashReporter` · `app.commandLine.appendSwitch` · `utilityProcess` · `net` · `desktopCapturer` · `titleBarOverlay`/`titleBarStyle` · `webContents.print`/`printToPDF` · `setVisualZoomLevelLimits` · `console-message` · `session.serviceWorkers` · `webRequest`(urls 빈 배열) · `clearStorageData` · `nativeImage.toBitmap/getBitmap` · `<webview>`(webviewTag:false — BrowserTabs.ts:170) · `document.execCommand('paste')`.
`will-navigate`/`setWindowOpenHandler`/`setPermissionRequestHandler`(BrowserService.ts:32-71, index.ts:545)은 시그니처 변경 없음. contextIsolation/sandbox 는 이미 명시적 true.

---

### 4. 도구체인 업그레이드에서 깨질 곳

#### React 18 → 19
- 제거 API(propTypes, defaultProps, string ref, `ReactDOM.render`, `findDOMNode`, `unmountComponentAtNode`, `react-dom/test-utils`, contextTypes): **0건**. `createRoot` 이미 사용(src/renderer/main.tsx:4·74·77).
- **전역 `JSX` 네임스페이스 제거(@types/react 19)**: `JSX.Element` 43줄 / 31파일 (예: AiBenchTree.tsx:125, AraChatPanel.tsx:94, FileTree.tsx:72·116·133, md.tsx:38·134). 기계적 치환 `React.JSX.Element` 또는 `import type { JSX } from 'react'`. → typecheck 대량 에러의 주원인.
- `forwardRef`: `src/renderer/components/MainArea.tsx:1·157` — 19 에서 동작(ref-as-prop 가능, forwardRef 는 이후 deprecated 예정). 급하지 않음.
- `useRef()` 무인자: 0건. `RefObject` 타입 변화(`RefObject<T>` 가 `current: T`) 는 typecheck 로 잡힌다.
- 렌더 타이밍(자동 배칭은 18 에서 이미), StrictMode 이중 effect 는 동일. 위험 낮음.

#### vite 5 → 8 / electron-vite 2 → 6 / plugin-react 4 → 6
- `externalizeDepsPlugin()` (electron.vite.config.ts:2·43) → electron-vite 5+ 는 `build.externalizeDeps` 옵션(기본 켜짐). Orca 형태: D:\orca\electron.vite.config.ts:215.
- `build.rollupOptions` (electron.vite.config.ts:45·49·55) → vite 8 은 `rolldownOptions` 가 정식, rollupOptions 는 호환 별칭(Orca 도 아직 rollupOptions 사용).
- 출력 포맷: Orca 주석 "Rolldown’s SSR ESM default"(D:\orca\electron.vite.config.ts:222 부근) — main/preload 가 CJS 로 나오는지 확인. 아라는 `__dirname` 과 `../preload/index.js` 를 쓴다(src/main/index.ts:176). 출력이 `.mjs` 가 되면 preload 경로가 깨진다.
- **esbuild 직접 import**: `scripts/bundle-*-harness.mjs` 7개(f6·f7·fixdestroy·shutdown·w1b·w2·w4sat)가 `import esbuild from 'esbuild'` — 지금은 vite 5 의 전이 의존. vite 8 은 esbuild 를 필수로 안 끌어오므로 **devDependency 로 명시 추가** 필요.
- `rdpWasmDataUrlFix` (electron.vite.config.ts:23-37): vite 내부 `vite:asset-import-meta-url` 동작에 기대는 dev 교정 — vite 8 에서 재검증.
- vite 8 은 Node 20.19+/22.12+ 필요(현 호스트 22.17 OK). Orca 는 Node 24.

#### TypeScript 5 → 7
- `tsconfig.json`: `"baseUrl": "."` — TS6 deprecated / TS7 제거. `paths` 는 baseUrl 없이 tsconfig 기준이라 그냥 삭제하면 됨.
- `"lib": ["ES2022","DOM","DOM.Iterable"]` 유지 가능. `types` 명시돼 있어 TS6 의 `types` 기본값 변화 영향 없음.
- TS7 은 JS API 없음 → typescript 를 import 하는 도구가 있으면 Orca 처럼 `typescript@6` 별칭 병설. 아라는 `typecheck` 스크립트만 쓰므로 영향 작음.
- 권고: **TS 는 6 까지만 먼저**(deprecation 경고로 정리) → 7 은 나중.

#### vitest 2 → 5
- `vitest.config.ts:28` `poolOptions: { forks: { singleFork: true } }` — vitest 4 에서 `poolOptions` 제거. 같은 의미는 최상위 `maxWorkers: 1, isolate: false`(Orca config/vitest.config.ts:135·147 이 top-level maxWorkers 사용). 그대로 두면 설정이 **조용히 무시**되어 병렬 실행 → 고정 포트 39217 충돌(파일 주석 22-24 가 예고).
- `environment: 'node'`, include 만 사용 → 그 외 영향 작음.

#### Playwright 1.62 → 1.64
- `tests/e2e/fixtures.ts:8·64` `_electron.launch` — Electron 43 은 1.64 대가 안전(Orca 기준). 같이 올린다.

#### xterm 5.5 → 6 (Electron 과 무관 — 따로)
- **`windowsMode` 제거** [X6]: `src/renderer/terminal/TerminalPane.tsx:208` (`windowsMode: isWindows && local`), 근거 주석 TerminalPane.tsx:114-117, `src/renderer/terminal/termRegistry.ts:45`. 아라는 이것으로 **reflow 를 끈다** — 6 에선 `windowsPty: { backend: 'conpty', buildNumber }` 로만 제어(buildNumber < 21376 이면 reflow off). 동작 동등성 재설계 필요.
- viewport·스크롤바 재작성 [X6]: `src/renderer/styles/shell.css:9093` `.xterm-viewport` 커서 스타일, `.xterm-screen` 측정(TerminalPane.tsx:306) 재확인.
- Alt→Ctrl+화살표 자동 매핑 제거 [X6].
- 권고: Electron 43 은 xterm 5.5 로 충분 → **xterm 6 은 별도 라운드**(Orca 도 아직 beta + 패치).

---

### 5. 권장 순서

단계적. 한 번에 올리면 실패 원인을 못 가른다.

0. **(31 에서 먼저) File.path → `webUtils.getPathForFile`** — 작고, 지금 판에서 바꿔 확인한 뒤 올리면 업그레이드 라운드에서 원인 하나가 줄어든다(결정 9).
1. **Electron 31 → 43 + electron-builder 26 + Playwright 1.64 + @types/node 24** (React·vite·TS 그대로)
   - 같이: navigationHistory, RDP 자식 창 `resizable:false`, dialog defaultPath 정책, `npmRebuild` 결정.
   - 확인: typecheck, vitest, e2e:full, smoke, check:rdpwasm, dist:win 설치본에서 pty·ssh·RDP·드래그앤드롭.
2. **vite 8 + electron-vite 6 + plugin-react 6 + esbuild devDep** (externalizeDeps, 출력 포맷, rdp wasm 교정, 하네스 번들)
3. **vitest 5** (poolOptions → maxWorkers/isolate)
4. **React 19 + @types/react 19** (JSX 네임스페이스 43줄 치환)
5. **TS 6 → 7** (baseUrl 제거 후)
6. (선택·별도) **xterm 6** — windowsMode 대체 설계 후

### 업그레이드 전에 먼저 고칠 것

- **File.path 제거(32) 대비 — 작음.** `pasteFiles.ts:76`·`AraChatPanel.tsx:418` 을 preload 로 노출한 `webUtils.getPathForFile` 로 바꾼다. 31.7.7 타입에 이미 있다(위 3절). v2 는 이것을 위험 1위로 적었지만, 고칠 곳이 두 군데로 정해져 있고 지금 고칠 수 있으므로 위험 목록에서 뺐다(결정 9).

### 위험 상위 4개

1. **vitest 4+ `poolOptions` 제거** — `vitest.config.ts:28` singleFork 가 조용히 무시 → 병렬 실행, MCP 고정 포트 39217 충돌로 flaky.
2. **electron-vite 6/vite 8 출력·의존 변화** — main/preload 포맷(CJS vs ESM, `../preload/index.js` 경로), `externalizeDepsPlugin` 폐기, 하네스 7개의 숨은 `esbuild` 의존, RDP wasm dev 교정.
3. **네이티브 재빌드 경로(33 C++20) + Electron 42 바이너리 지연 다운로드** — 패키징 시 npmRebuild 가 node-pty/ssh2/cpu-features 를 C++20·Spectre 로 재빌드하다 실패, 사내망에서 electron 바이너리 다운로드 실패. 런타임 자체는 node-pty N-API prebuild 라 안전.
4. **xterm 6 을 같이 올릴 경우 `windowsMode` 제거** — reflow 차단 장치(TerminalPane.tsx:208)가 사라져 Windows 로컬 셸 줄접힘 회귀. Electron 업그레이드와 분리하면 회피.

---

## E-3. macOS 대응 재료 (결정 12)

> 읽기 전용 조사다. 아라 코드는 고치지 않았다. 근거는 `D:\AI\OFA`(master a0a024e) 파일:줄이다.

**한 줄 요약**: 코드는 이미 대부분 플랫폼으로 갈라 두었다. 맥을 막는 것은 코드보다 **패키징·서명·자동 업데이트·릴리스 파이프라인**이다.

### 1. 빌드·서명·공증·업데이트

| 항목 | 지금 | 맥에서 필요한 것 |
|---|---|---|
| 빌드 대상 | `electron-builder.yml:47-52` `mac: target: dmg` 하나, 아이콘 PNG | 자동 업데이트를 하려면 `zip` 대상도 같이 낸다(electron-updater 의 맥 경로는 zip 을 받는다). x64·arm64 를 따로 낼지 universal 로 낼지 정한다 |
| 서명·공증 | ad-hoc 서명만(`scripts/sign-adhoc.sh`, yml 주석 "정식 Developer ID 서명·공증은 배포 직전") | Apple Developer ID 인증서, `hardenedRuntime: true`, entitlements(Electron 기본: JIT·서명 안 된 실행 메모리 허용), `notarize` 설정. 서명·공증 없이는 Gatekeeper 가 막고 자동 업데이트도 안 된다 |
| 자동 업데이트 | `main/update/AutoUpdate.ts` 는 NSIS 설치 흐름 기준(`:157` 주석), 피드 `publish.url` generic | 맥은 서명된 zip + `latest-mac.yml` 이 피드에 있어야 한다. 사내 배포 서버(`http://192.168.100.56:8899/downloads/v2/`)에 맥 파일을 같이 올린다 |
| 릴리스 파이프라인 | `scripts/ops/*.ps1`(PowerShell, Windows 빌드·배포) | 맥 빌드는 맥에서만 서명·공증된다. 맥 빌드 머신(또는 CI 맥 러너)과 그 단계를 파이프라인에 더한다 |
| Electron 42 바이너리 지연 다운로드 | E-2 3절 | 맥 빌드 머신에서도 같은 미러·선실행이 필요하다 |

### 2. 네이티브 모듈 (mac)

| 모듈 | 맥 상태 | 할 일 |
|---|---|---|
| node-pty 1.1.0 | `node_modules/node-pty/prebuilds/` 에 `darwin-arm64`·`darwin-x64` 가 이미 있다(N-API) | 맥은 `spawn-helper` 실행 파일을 쓴다. `asarUnpack: node_modules/node-pty/**`(electron-builder.yml:11-12)로 asar 밖에 두는 것은 그대로, **서명·공증 대상에 spawn-helper·.node 가 들어가는지** 확인한다(공증은 안 서명된 바이너리를 거부한다). Orca 의 node-pty 패치 중 mac fd 재사용 방어(E-2 1절)는 맥에서 가치가 생긴다 |
| ssh2 `sshcrypto.node`·cpu-features | Windows 와 같이 optional, 로드 실패 시 JS 폴백 | Orca 처럼 빌드를 끄면(`allowBuilds ssh2:false`) 공증할 바이너리도 줄어든다 |
| RDP wasm | 플랫폼 무관 | — |

### 3. 아라 코드의 Windows 가정 — 대표 사례

`process.platform` 분기는 15곳이고 대부분 맥 쪽 길이 있다. 맥 지원 때 볼 곳만 적는다.

| 위치 | 내용 | 맥 영향 |
|---|---|---|
| `src/main/sessions/PtyBackend.ts:19-27` | Windows 는 pwsh→powershell→cmd, 그 밖은 `$SHELL`→`/bin/zsh` | 길은 있다. 다만 스폰 실패 폴백(`:202-206`)은 Windows 의 `cmd.exe` 뿐이라 맥은 폴백이 없다 |
| `src/main/ai/engine/ClaudeCliEngine.ts:134·159` | Windows 는 `cmd.exe` + `.cmd` 인용 규칙(`:60-110`), 그 밖은 직접 spawn | 길은 있다. 맥 쪽 경로는 실제로 돌려 본 적이 없을 가능성이 크다 — 첫 맥 스모크 대상 |
| `src/main/rdp/rdpClipboard.ts:126·142` | 파일 클립보드는 "Windows 에서만 됩니다" | 맥 RDP 에서 파일 붙여넣기가 안 된다(기능 축소, 막지는 않음) |
| `src/main/agent/claudeHooks.ts:63` | 훅 스크립트를 bash 문법으로 쓴다(Windows 는 Git Bash 전제) | 맥은 bash/zsh 가 있으므로 오히려 자연스럽다. 확인만 |
| `src/renderer/terminal/TerminalPane.tsx:119·208` | `isWindows`(userAgent)일 때만 `windowsMode` | 맥은 reflow 가 켜진 기본 동작 — 문제없음 |
| `src/main/index.ts:660·764` | `window-all-closed` 에서 darwin 은 종료 안 함, `activate` 처리 있음 | 맥 관례를 이미 따른다 |
| `src/shared/keymap.ts:97·102-113` | 단축키 표에 `mac` 열(Cmd·Opt)이 있다 | 이미 대응 |
| `src/main/secrets/SafeStorageSecretStore.ts` | Electron `safeStorage` 사용(맥은 Keychain) | 길은 있다. 다른 PC·프로필로 옮기면 못 푸는 점은 Windows 와 같다 |
| `src/main/util/localGit.ts:37`, `src/main/util/localCli.ts:14`, `src/main/fs/LocalFs.ts:151` | 경로 구분자·`where`/`which`·로컬 파일 처리 분기 | 길은 있다 |

**결론**: 코드 쪽에서 맥을 막는 자리는 grep 범위에서 찾지 못했다(실행은 안 해 봤다). 맥 지원의 실제 일은 1절(서명·공증·zip·맥 빌드 파이프라인)과 첫 맥 스모크(셸 스폰·Claude CLI 실행·훅·드래그앤드롭)다.

---

# F. 업데이트 리듬 — 모니터링 설계 재료

**최근 30일(10-01~10-31)**: 커밋 **6,006**(하루 ~200, 스쿼시 머지 1 PR = 1 커밋). 주별 W40 447 → W41 1,017 → W42 1,321 → W43 1,452 → **W44 1,753** (가속 중). 주 기여자 6명(Neil 2,520 · OrcaWin(봇성 계정) 1,147 · Brennan Benson 753 · Jinwoo Hong 693 …).
**릴리스**: 데스크톱 안정 태그 10월에 **25개**(거의 매일, 8-29~10-30 53개). 모바일 Android 태그 10월 7개. **RC 태그는 8-28(v1.4.192-rc.1) 이후 끊겼다** — 지금은 안정판을 바로 자른다.

| 출처 | 위치·형식 | 모니터링 적합성 |
|---|---|---|
| **GitHub Releases** | `github.com/stablyai/orca/releases`. 데스크톱 `v1.4.N` 은 Latest 표시, 본문은 **사람이 다듬은 노트**: 제목·요약 → highlights → 호환성/업그레이드 노트 → "Product experience" 하위 절(Native chat·Browser·Plugins…) 각 불릿에 `@작성자` + `#PR`. 모바일 `mobile-android-v0.0.N` 은 Pre-release, 자동 생성 "What's Changed" PR 목록. 생성 경로: `config/scripts/create-draft-release.mjs` 가 `releases/generate-notes` API 로 초안 → 다듬어 공개 | **1순위.** API `GET /repos/stablyai/orca/releases` 로 tag·body 를 받으면 된다 |
| 앱 내 changelog | `https://onorca.dev/whats-new/changelog.json` (`src/main/updater-changelog.ts:32`) — `{version,title,description,mediaUrl,releaseNotesUrl}` 배열. 사람용 요약 | 2순위(짧은 요약). 외부 도메인 |
| git 태그 | 경량 태그(메시지 없음) — `git for-each-ref refs/tags/v1.4.245` 내용 공백 | 버전 경계 용도만 |
| CHANGELOG 파일 | **없다**(저장소에 `CHANGELOG*` 0개) | — |
| 커밋 제목 | conventional commit 접두 + `(#PR)` | `feat(<scope>)` 집계로 "어느 영역이 움직였나" 신호가 된다(§D 집계 방식 그대로) |
| 사용자 문서 | `docs/site/content/docs/**/*.mdx` (fumadocs) | 기능 명세 대조용 — 이번 목록의 1차 근거 |

⚠️ 리듬이 하루 200 커밋·매일 릴리스다. **"Orca 를 따라간다"는 커밋 추적이 아니라 릴리스 노트의 "Product experience" 절을 영역별로 걸러 읽는 일**이어야 한다. `D:\orca` 를 계속 fetch 한다면 얕은 클론을 깊게(`--unshallow`) 할지 결정이 필요하다(이번엔 안 했다 — 읽기 전용).

---


### 월요일 모니터링에 쓰는 법 (준영님 결정 ④)

- **대응표**: `docs/orca-port-map.json`. 항목마다 `orcaPaths` 와 `orcaRef`(지금은 `7a7f46f8a3`)가 있다. 주간 점검은 `git -C D:/orca fetch` 한 뒤 `git log --oneline <orcaRef>..origin/main -- <orcaPaths...>` 와 `--stat` 을 항목별로 뽑는다. 이식을 반영한 뒤에는 그 항목의 `orcaRef` 를 올린다.
- **한계 1**: Orca 의 `src/shared` 는 같은 접두어 파일 수십 개가 한 폴더에 나란히 있다. 그래서 대응표에는 대표 파일만 넣은 곳이 있다(AI 쪽). 형제 파일 변화를 놓치지 않으려면 pathspec glob(`':(glob)src/shared/agent-status-*'`)을 같이 쓰는 것이 좋다.
- **한계 2**: `src/renderer/src/components/editor/` 는 Monaco·diff·마크다운·뷰어가 한 폴더에 있다. 그래서 WS-07·08·10 에 같은 diff 가 여러 번 잡힌다.
- **한계 3**: 대응표에는 1차 42항목만 있다(v3 에서 TM-01, v4 에서 AI-11~19·DM-01~05·FD-01~04 추가). 2차를 시작할 때 항목을 더한다. 모바일(3차)을 시작할 때는 모바일 프로토콜 경로(`mobile/`, `src/shared/mobile-*`, `src/main/runtime/runtime-rpc/runtime-rpc-mobile-*`)를 주간 점검에 더한다(묶음 9 — 스토어 앱이 자동 업데이트되므로).
- **한계 4**: DM-01(`src/main/daemon`, 664파일)·DM-02(`src/main/orcad`)·AI-12(`native-chat`, 약 1,800파일)는 폴더가 커서 매주 diff 가 많이 잡힌다. 릴리스 노트로 먼저 거른다.
- 같은 주에 릴리스가 5~7개 나오므로, 릴리스 노트의 "Product experience" 절과 대응표 diff 를 함께 본다.

---

# G. 불확실한 곳 (종합)

- **신규 판정은 파일 최초 추가일 기준이다.** 이름을 바꾸거나 옮긴 파일은 새로 생긴 것으로 잡힐 수 있다. 탭 제목 규칙과 턴 끝 판정(둘 다 10-22)이 그 위험에 해당한다. 기능이 폴더 하나에 깔끔히 대응하지 않는 행은 `git log -S` 로 키워드를 따로 봤으므로, 키워드를 잘못 고르면 틀릴 수 있다.
- **아라 현황은 grep 과 파일 열람으로 판정했다.** 실행해서 확인하지는 않았다.
- **v4 에서 판단으로 정한 곳**: ① 기반 1차 중 멈춤 감시·진단 프로브·렌더러 복구는 분류를 `터미널 개선` 그대로 두고 우선순위 칸에 `기반`을 적었다(분류 값이 여섯 개로 고정이라). ② 펫·셋업 가이드는 묶음 13 "넣기"에 차수가 없어 3차로 두었다. ③ "별 요청·펫" 한 행은 펫만 넣으므로 이식 3차로 바꾸고 메모에 "별 요청은 빼기"를 적었다(행을 나누지 않았다). ④ "여러 프로바이더 사용량" 행은 Gemini 만 넣으므로 이식 2차로 바꾸고 나머지는 빼기로 적었다. ⑤ C-6 의 이식 행은 모두 3차로 내렸다.
- **B 표의 행 수**: v2 는 154 로 적었지만 v3 에서 9칸 행을 스크립트로 다시 세면 155행이다(절별 19·9·20·24·15·8·11·14·2·9·6·9·9). v3 요약은 155 를 쓴다.
- **macOS**: E-3 은 grep·파일 열람으로만 봤다. 맥에서 빌드·실행해 보지 않았다.
- **ai-browser**(`D:\AI\ai-browser`): README 와 `package.json`(electron ^45.1.0)만 봤다. 정상 동작 여부는 확인하지 않았다. 아라(43 목표)와 Electron 판이 다르다는 점은 이식 때 볼 일이다.
- **빌드 스위치 뒤 기능**(`ORCA_LAYOUT_OWNER`, WSL Mover·WSL 호스트, 커넥터)은 기본 꺼짐이다. 일반 사용자에게 보이는지는 확인하지 않았다.
- **Electron 31.7.7 의 정확한 내장 Node 패치 버전**은 실행하지 않고는 알 수 없다. E-2 는 31.0.0 기준(Node 20.14, Chromium 126)으로 적었다.
- **모바일**: 실제 앱을 돌려 보지 않았다.
- **origin/main 은 이미 앞서 있다.** fetch 시점에 14 커밋 앞인 `0d94c0ba8f` 였다. 이 문서는 `7a7f46f8a3` 기준이다.
- 영역별 세부는 각 절 끝의 "불확실한 점"에 있다.
