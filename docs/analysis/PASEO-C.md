# Paseo 분석 C — 제품 기능 전수 · 스킬 · 우리에게 없는 것

> 2026-09-10 · 대상 `getpaseo/paseo` @ `0c38749` (v0.7.0, **Apache-2.0**) · `D:\paseo`
> 방법: 읽기 전용 정적 분석. **아무것도 빌드·실행하지 않았다.** 성능 수치는 전부 저쪽 문서·주석 인용.
> 어휘·축은 `docs/orca-analysis.md` 를 따랐고, 겹치는 자리에 그 문서의 **F 번호**를 달았다.

---

## 0. 한 줄 요약 — Paseo 는 orca 와 다른 축에서 우리와 겹친다

Orca 는 **"에이전트 감독 층"** 이 값이었다. Paseo 는 그것도 있지만 **진짜 차별점은 두 개**다:

1. **에이전트가 에이전트를 부리는 것이 MCP 도구 40개로 제품에 박혀 있다.** `skills/` 6개는
   그 도구를 어떻게 쓰라는 **마크다운 설명서**일 뿐이고, 실체는 `create_agent` ·
   `list_profiles` · 서브에이전트 트랙 · `notifyOnFinish` 알림이다. **우리 #81 이 그 자리다.**
2. **데몬 권한 모델이 orca 보다 훨씬 강하다** — orca 는 유닉스 소켓+베어러 토큰 하나였는데
   여기는 principal / credential / grant 로 나뉜 **9개 의미 권한**이다(§6).
   🔴 그리고 **orca-analysis §6 의 *"AI 는 명령 문자열을 못 보낸다"* 를 우리 카탈로그 전체의
   성질로 읽으면 안 된다** — 우리 `session_input` 도 임의 문자열을 PTY 에 쓴다. 우리 우위는
   *문자열 금지*가 아니라 **호출마다 등급 붙은 승인 게이트**와 **`respond_to_permission` 이
   없다는 것**이다. §6 에서 표를 고쳐 적었다.

그리고 **터미널의 정체가 우리와 정반대다.** Paseo 에는 **SSH 터미널이 아예 없다.**
모든 터미널은 데몬 호스트의 로컬 PTY 고, 원격 셸을 쓰려면 **거기에 데몬을 깐다.**
`packages/cli/src/ssh/ssh-tunnel.ts` 의 ssh 는 OS `ssh` 바이너리를 띄워 **원격 데몬까지 포트를
뚫는 터널**이지 셸이 아니다(`ssh2` 의존성 0건 — 전 패키지 `package.json` grep 결과 없음).

---

## 1. 기능 전수 목록

**크기(S/M/L)** 는 *우리 저장소에 이식할 때의 짐작*이지 저쪽 구현 규모가 아니다.
**우리에게 있나**: ✅ 있음 · ◐ 절반/원재료만 · ✕ 없음. (기준선 = `orca-analysis` §2 + 우리 저장소 확인)

### A. 에이전트 오케스트레이션 — 저쪽의 핵심 (🔴 §2 에서 자세히)

| 기능 | 한 줄 | 근거 | 크기 | orca 중복 | 우리에게 있나 |
|---|---|---|---|---|---|
| **A1 에이전트→에이전트 MCP 도구 40개** | 실행 중인 에이전트가 워크스페이스·에이전트·터미널·스케줄·권한을 직접 조작 | `packages/server/src/server/agent/tools/paseo-tools.ts` (3,217줄, `registerTool` 40회) | **L** | — | ✕ (우리 MCP 는 터미널 조종용, 에이전트 생성 없음) |
| **A2 Agent profiles** | 사람이 `provider/model/mode/thinking/features` 를 이름 붙여 저장 + `notes` 자유서술. 위임하는 에이전트가 `notes` 를 읽고 고른다 | `paseo-tools.ts:2926-2948` (`list_profiles`), `packages/app/src/agent-profiles/` | S | — | ✕ |
| **A3 서브에이전트 트랙** | 내가 만든 에이전트는 내 자식으로 별도 트랙에 뜬다. **분리(detach)는 사람 제스처**이지 도구가 아니다 | `skills/paseo/SKILL.md:716`, `packages/app/src/subagents/` (16파일: `detach-subagent`·`archive-finished`·`close-tab-policy`) | M | — | ✕ |
| **A4 `notifyOnFinish` — 폴링 금지 규약** | 에이전트 도구 호출은 기본 `background:true`+`notifyOnFinish:true`. 스킬이 *"폴링하지 마라, 알림이 온다"* 를 명시 | `skills/paseo/SKILL.md:761-767` | S | — | ✕ |
| **A5 스케줄(cron) 에이전트** | 크론으로 **새 에이전트**를 띄운다. list/inspect/update/pause/resume/run-once/logs/delete 전부 있음 | `paseo-tools.ts:2513,2633-2877`, `packages/server/src/server/schedule/` | M | — | ✕ |
| **A6 하트비트** | 크론으로 **지금 이 대화에** 프롬프트를 되돌려 보낸다(빌드 감시·PR 감시용). **일부러 update 도구를 안 만들었다** — 지우고 다시 만들라 | `paseo-tools.ts:2563,2612`, `skills/paseo/SKILL.md:757-759` | S | — | ✕ |
| **A7 `speak` 도구** | 에이전트가 데몬 음성 출력으로 사용자에게 말한다. 재생 끝날 때까지 블록 | `paseo-tools.ts:1160-1193` | S | — | ✕ (#140 로 숨겨 둠) |
| **A8 `respond_to_permission`** | 🔴 **에이전트가 다른 에이전트의 권한 요청을 승인/거부한다** | `paseo-tools.ts:3093-3151` | — | — | ✕ **가져오면 안 된다**(§6) |

### B. 에이전트 감독·상태 (우리 P1)

| 기능 | 한 줄 | 근거 | 크기 | orca 중복 | 우리에게 있나 |
|---|---|---|---|---|---|
| **B1 훅 기반 터미널 활동 표시** | 터미널에 env 4개를 주입하고 CLI 훅이 로컬 `/api/terminal-activity` 로 POST. **터미널 탭에 에이전트와 같은 점을 찍는다** | `docs/terminal-activity.md`, `packages/server/src/terminal/agent-hooks/` | M | **F1** | ✅ F1a/F1b (다만 아래 B2~B5 차이) |
| **B2 훅 설치가 opt-in 이다** | *"사용자의 실제 에이전트 설정 파일을 고치므로 opt-in"* — `daemon.enableTerminalAgentHooks` **기본 false**, 설정 UI 에 문구까지 | `docs/terminal-activity.md` "Agent hook installation" | S | F1 | ❓ **우리 F1b 가 이 게이트를 가졌는지 확인 필요** |
| **B3 공유 토큰** | POST 본문에 `PASEO_ACTIVITY_TOKEN` 을 함께 보낸다(같은 호스트의 아무 프로세스나 상태를 위조하지 못하게) | `docs/terminal-activity.md` env 목록 | S | F1 | ❓ 확인 필요 |
| **B4 🔴 Codex 는 네이티브 훅이 있다** | `~/.codex/hooks.json` 에 설치. `UserPromptSubmit`·`PreToolUse`·`PostToolUse`→running, `PermissionRequest`→needs-input, `Stop`→idle. **Windows 명령까지 따로 넣는다**(`commandWindows`) | `packages/server/src/terminal/agent-hooks/codex/codex.ts:3-31` | S | F1 | ✕ — **orca-analysis §8 F2 의 "codex 는 훅이 없어서 늘 확인 불가"는 낡았다** |
| **B5 OpenCode 는 훅 대신 서버 플러그인** | `~/.config/opencode/plugins/paseo-terminal-activity.js` 를 통째로 깔고 버스 이벤트를 듣는다 | `packages/server/src/terminal/agent-hooks/opencode/opencode.ts` | S | F1 | ✕ |
| **B6 마커 기반 멱등 설치/제거** | 사용자 훅은 보존하고 **자기 마커가 붙은 것만** 지운다. 데몬 꺼도 훅은 남는다 | `docs/terminal-activity.md` "marker-based/idempotent" | S | F1 | ❓ |
| **B7 상태 기본값이 `null`(모른다)** | `TerminalActivityTracker` 는 unknown 에서 시작하고 **해결된 상태 전이에만** 발화 | `docs/terminal-activity.md` "defaults to unknown (`null`)" | S | **F3** | ✅ (`unverifiable`) |
| **B8 전이가 자기 이력을 들고 다닌다** | `onChange` 가 `{새 스냅샷, previous}` 를 같이 준다. **데몬은 스냅샷이 아니라 전이를 소비한다** | `docs/terminal-activity.md` "Transitions carry their own history" | S | **F2** | ◐ (`stateStartedAt` 은 있으나 previous 동반 아님) |
| **B9 Ctrl-C/Esc 는 "끝남"이 아니다** | *"Claude 는 사용자가 턴을 끊으면 `Stop` 을 안 낸다"* → 단독 Ctrl-C/Esc 입력이 working 을 **알림 없이** 지운다. 이스케이프 시퀀스·붙여넣기는 제외 | `docs/terminal-activity.md` | S | **F4** | ✕ |
| **B10 포커스가 주의를 지운다** | 클라이언트 하트비트에 **포커스된 터미널 id** 를 실어 보낸다. 보고 있으면 데몬이 attention 을 지운다 | `docs/terminal-activity.md` "Focus clearing" | S | F4 | ✕ |
| **B11 워크스페이스 상태 롤업** | 터미널 활동이 같은 `cwd` 를 쓰는 모든 활성 워크스페이스로 부챗살처럼 퍼진다 | `docs/terminal-activity.md` | M | — | ✕ |
| **B12 제공자별 사용량·레이트리밋** | **8개 제공자**(claude·codex·copilot·cursor·zai·grok·kimi·minimax). 창(window)·잔액(balance)·플랜 라벨·톤(색) | `packages/server/src/services/quota-fetcher/manifest.ts:15-55`, `packages/app/src/provider-usage/` (11파일) | M | **F5** | ✕ |
| ↑ 자격증명 출처 | Claude = `~/.claude/.credentials.json` → `https://api.anthropic.com/api/oauth/usage`. Codex = `~/.codex/auth.json` → `https://chatgpt.com/backend-api/wham/usage`. **PTY 화면 긁기는 없다** | `providers/claude.ts:438,469`, `providers/codex.ts:174-203` | — | F5 | — |

### C. 아키텍처 — 데몬·연결 (우리 P8)

| 기능 | 한 줄 | 근거 | 크기 | orca 중복 | 우리에게 있나 |
|---|---|---|---|---|---|
| **C1 데몬이 프로세스를 소유** | 클라이언트가 끊겨도 에이전트가 산다. 앱은 얇은 껍데기 | `docs/product.md` "The daemon", `docs/architecture.md` | **L** | **F24** | ✕ (앱이 죽으면 같이 죽는다) |
| **C2 node-pty 가 워커 프로세스에** | `terminal-worker-process.ts` · `worker-terminal-manager.ts` · `terminal-worker-protocol.ts` | `packages/server/src/terminal/` | **L** | **F24** | ✕ |
| **C3 데몬이 화면 모델을 든다** | 서버 의존성에 **`@xterm/headless`** | `packages/server/package.json:83` | M | **F25** | ✕ |
| **C4 백프레셔가 ACK 가 아니라 `bufferedAmount`** | 소켓 버퍼가 4MiB 를 넘으면 그 클라이언트를 **스냅샷 따라잡기 경로로 밀어낸다**. *"터미널이 얼마나 뱉었나가 아니라 전송로가 실제로 막혔나로 잰다"* | `packages/server/src/terminal/terminal-restore.ts:10-17` (`MAX_CLIENT_BUFFERED_BYTES`) | S | **F27**(다른 답) | ✕ — 우리·orca 와 **셋 다 다른 설계** |
| **C5 물리 소켓마다 8MiB 상한** | JSON·바이너리·릴레이 전부. 넘길 프레임은 안 보내고 **그 물리 소켓만** 끊는다(같은 논리 세션의 다른 소켓은 무사) | `docs/architecture.md` "8 MiB outbound high-water mark" | S | — | ✕ |
| **C6 애플리케이션 ping 임차(lease)** | 클라이언트가 10초마다 `ping`. 첫 ping 이 그 물리 소켓의 소유권을 임차하고 만료되면 데몬이 끊는다. **ping 을 안 보내는 레거시 소켓은 임차에 안 들어가서 안 끊긴다** | `docs/architecture.md` | S | — | ✕ |
| **C7 릴레이 — E2E 암호화 페어링** | Curve25519 + NaCl box(XSalsa20-Poly1305). **릴레이는 제로지식**. QR 로 데몬 공개키 전달. 새 홈은 페어링 동의 전까지 릴레이 꺼짐 | `packages/relay/` (15파일), `docs/architecture.md` | **L** | — | ✕ |
| **C8 웹 UI 자체 서빙** | 데몬의 같은 HTTP 서버가 브라우저 클라이언트를 낸다 | `public-docs/web-ui.md`, `docs/architecture.md` | M | — | ✕ |
| **C9 Docker 이미지** | `ghcr.io/getpaseo/paseo` — 데몬+웹UI. `/home/paseo` 볼륨에 자격증명 | `README.md` Docker 절, `docker/` | M | — | ✕ |
| **C10 원격 데몬에 SSH 로 붙기** | 0.7.0 신규. Desktop·CLI 가 OS `ssh` 로 터널을 뚫어 **이미 돌고 있는** 원격 데몬에 연결 | `CHANGELOG.md:16` (#3989), `packages/cli/src/ssh/ssh-tunnel.ts:27` | M | — | ◐ (우리는 ssh2 로 셸 자체를 연다 — 목적이 다르다) |
| **C11 Paseo Hub** | 옵트인 아웃바운드 연결. 조직 단위 트리거(triggers-as-code YAML), `hub.execute` 권한 | `docs/hub.md` | **L** | — | ✕ |
| **C12 멀티 윈도우** | `⌘⇧N`. ⚠️ **자기 문서가 한계를 적는다**: 첫 창만 크기/위치를 복원·저장한다 | `docs/architecture.md` "Window-state v1 limitation" | S | — | ◐ (세션 창은 있음) |
| **C13 서비스 프록시** | `paseo.json` 의 `type:"service"` 스크립트에 포트를 배정하고 `<script>--<branch>--<project>.localhost` 호스트명으로 역프록시 | `docs/service-proxy.md` | M | — | ◐ (`PortForward` 는 있으나 이름 붙은 서비스 라우팅은 없음) |

### D. 코드 보기·편집 (우리 P2 — 우리 최대 구멍)

| 기능 | 한 줄 | 근거 | 크기 | orca 중복 | 우리에게 있나 |
|---|---|---|---|---|---|
| **D1 diff 뷰어** | 인라인/분할, 파일 트리, 폴더 행, 너무 큰 diff 상태, 스크롤 순서 | `packages/app/src/components/diff-viewer.tsx`, `packages/app/src/git/diff-*` (9파일), `panels/diff-panel.tsx` | M | **F6** | ✕ (컴포넌트 0개 — 재확인함) |
| **D2 diff 줄 단위 리뷰 코멘트** | 거터에 + 버튼 → 인라인 편집기 → 스레드. 초안은 `{filePath, side, lineNumber, body}` 로 저장되고 **에이전트에게 첨부로 되돌아간다** | `packages/app/src/review/` (5파일), `review/state.ts:6-14`, `buildReviewAttachmentSnapshot` | M | **F7** | ✕ |
| ↑ 값진 세부 | diff 모드 수동 선택은 **체크아웃의 dirty 상태가 선택 시점과 같은 동안만 유효**하고 달라지면 만료된다 | `review/state.ts:16-24` 주석 | S | F7 | — |
| **D3 코드 편집기** | CodeMirror 6 + **vim 모드**(`@replit/codemirror-vim`) + 검색 | `packages/app/package.json:42-64`, `packages/app/src/file-pane/editor/` | M | — | ◐ (`EditorWindow.tsx` 있음 — 기능 비교 필요) |
| **D4 구문 강조 자체 패키지** | `packages/highlight` (28파일) — astro·csharp·nix·svelte 파서 직접 보유 | `packages/highlight/src/` | M | — | ❓ |
| **D5 파일 아이콘** | `material-icon-theme` SVG 를 **채도만 낮춰서** 캐시 | `docs/file-icons.md` | S | — | ◐ (`fileIcons.tsx`) |
| **D6 미리보기** | 이미지(줌·팬) · 마크다운 · HTML(CSP 적용) · 라이브 파일 관찰 | `packages/app/src/file-pane/` (html-preview-csp.ts·markdown-preview·live-file), `CHANGELOG.md:20` | M | **F8** | ◐ (`md.tsx` 만) |
| **D7 mermaid 렌더링** | 에이전트 출력의 마크다운 코드펜스에서 다이어그램 | `packages/app/src/components/markdown/fence/mermaid/` | S | — | ✕ |
| **D8 재귀 파일 감시** | 플랫폼별 네이티브 워처. ⚠️ *"Node 22 의 Linux `recursive:true` 는 JS 로 트리를 걸어서 리소스를 소진한다"* + 25만 항목 넘으면 폴링으로 실패 | `docs/file-observation.md` | M | — | ✕ |

### E. Git · 포지 (우리 P4)

| 기능 | 한 줄 | 근거 | 크기 | orca 중복 | 우리에게 있나 |
|---|---|---|---|---|---|
| **E1 🔴 포지 = 레지스트리/매니페스트** | 새 포지 = 디렉터리 하나 + 레지스트리 항목 하나. **GitHub 우선이 아니다** — 중앙 스위치도, 프로토콜 유니온 분기도 금지 | `docs/forge-providers.md`, `packages/protocol/src/forge-manifest.ts` | — | **F13** | ✕ |
| **E2 GitLab 어댑터** | 1,411줄. MR·파이프라인·auto-merge·체크. **`glab` CLI 를 쓴다**(REST 아님) | `packages/server/src/services/gitlab-service.ts` | **L** | **F13** | ✕ |
| ↑ 사내 자체호스팅 | `glab auth status --hostname <host>` 로 **런타임 프로브**. *"이름에 gitlab 힌트가 없는 자체관리 호스트도 잡는다."* 로그인 = `glab auth login --hostname <host>` | `gitlab-service.ts:789`, `forge-manifest.ts` gitlab 항목 | — | **F13** | — |
| ↑ 플래그 밀수 방어 | *"`-` 로 시작하는 위치 인자가 플래그로 재해석되지 못하게 막는다"* — orca `git-exec-validator` 와 같은 부류 | `gitlab-service.ts:762` 주석 | S | §6 | ❓ |
| ↑ auto-merge 실행 시점 방어 | *"`glab mr merge --auto-merge` 는 파이프라인이 살아 있을 때만 예약한다. 없으면 **즉시 머지**한다"* → UI 정책과 별개로 서버에서 거부 | `gitlab-service.ts:803-824` | S | F13 | — |
| **E3 Gitea/Forgejo/Codeberg** | 2,297줄. `forgeSpecific.forge` 는 **브랜드가 아니라 "사실 계열 태그"** 라서 셋이 같은 어댑터를 공유 | `packages/server/src/services/gitea-service.ts`, `docs/forge-providers.md:51` | — | — | ✕ |
| **E4 GitHub** | 4,118줄. PR 폴링을 API 예산 안에서 배치 | `github-service.ts`, `CHANGELOG.md:36` | — | F13 | ✕ |
| **E5 체크 상태 정규화 + traits** | `status` 는 고정 유니온으로 집계하고, `manual`·`action_required`·`warning` 같은 미세 구분은 **열린 `traits: string[]`**. 모르는 trait 은 무시 | `packages/protocol/src/check-traits.ts` | S | — | ✕ |
| **E6 커밋·풀·푸시·싱크·PR·머지 UI** | 액션 분할 버튼 + 각 액션의 "왜 안 되는지" 사유 | `packages/app/src/git/actions-split-button.tsx`·`policy.ts`·`commits-section/` | M | — | ✕ |
| **E7 브랜치 전환기 + stash 프롬프트** | 전환 전에 stash 여부를 묻는다 | `packages/app/src/git/branch-switcher-operations.ts` | S | — | ✕ |
| **E8 Git 서명 존중** | 커밋·스쿼시 머지가 설정된 서명을 우회하던 것을 고침 | `CHANGELOG.md:60` (#3976) | S | — | — |

### F. 워크스페이스 (우리 P4)

| 기능 | 한 줄 | 근거 | 크기 | orca 중복 | 우리에게 있나 |
|---|---|---|---|---|---|
| **F1 워크트리 격리 3모드** | `branch-off`(새 브랜치) · `checkout-branch`(기존) · `checkout-pr`(PR 번호 + forge) | `paseo-tools.ts:1211-1334`, `skills/paseo/SKILL.md:682` | M | **F12** | ◐ (`git.worktree.add/remove` 원재료만) |
| **F2 워크트리 셋업 스크립트** | `paseo.json` 의 `worktree.setup[]` 이 새 워크트리에서 자동 실행(`npm ci` 등) | `paseo.json:2-10` | S | — | ✕ |
| **F3 워크스페이스 스크립트 감독 실행** | `list/start/stop` + 서비스 포트·프록시 URL·health·exit code·터미널 id 를 돌려준다. MCP·CLI·앱 셋 다 | `paseo-tools.ts:2237-2313`, `docs/service-proxy.md` | M | — | ✕ |
| **F4 아카이브가 소유권을 센다** | *"소유한 워크트리는 **마지막 활성 참조**가 아카이브된 뒤에만 지운다"* | `skills/paseo/SKILL.md:686` | S | — | ✕ |
| **F5 워크스페이스 라벨** | 호스트별 색 있는 라벨 카탈로그. **호스트마다 같은 이름에 다른 색이 가능해서 행은 자기 호스트 카탈로그로 해석**한다(병합된 답은 틀리다) | `packages/app/src/workspace-labels/` (7파일), `docs/architecture.md` | M | — | ✕ |
| **F6 프로젝트 자동 탐지** | 파일시스템에서 찾고 git 리모트로 태깅 | `docs/product.md` "Projects and workspaces" | S | — | ◐ (`WorkspaceStore`) |
| **F7 분할 창(split panes)** | 에이전트·터미널·파일·diff·PR·플러그인 패널을 섞어 배치. 드래그·새 탭 | `CHANGELOG.md:97-100`, `packages/app/src/workspace-tabs/` | M | — | ✅ (`PaneGrid`) |
| **F8 Explorer 사이드바** | `Cmd+E` 토글. Files/Changes 전용 독. 사이드 페인과 셸 계약이 다르다 | `docs/explorer-sidebar.md` | M | — | ◐ (`FileTree` 두 자리) |
| **F9 워크스페이스 복구** | `packages/app/src/workspace-recovery/` | 파일 존재 | S | — | ❓ |

### G. 터미널

| 기능 | 한 줄 | 근거 | 크기 | orca 중복 | 우리에게 있나 |
|---|---|---|---|---|---|
| **G1 xterm 애드온 8종** | webgl · ligatures · **image(sixel)** · unicode11 · search · clipboard · web-links · fit | `packages/app/package.json:68-76` | S | — | ◐ (일부) |
| **G2 모바일 네이티브 렌더러** | `packages/app/src/terminal/native-renderer/` — 웹뷰 말고 RN 네이티브 그리기 | 디렉터리 존재 | **L** | — | ✕ |
| **G3 셸 통합** | `packages/server/src/terminal/shell-integration/` | 디렉터리 존재 | S | — | ◐ (`osc7.ts`) |
| **G4 터미널 크기 = 마지막 상호작용 클라이언트 승** | *"붙이기·가시성 복원·폰트 안정화·리핏은 resize 프레임을 보내면 안 된다"* — 서버는 크기 소유권을 방송하지 않는다 | `docs/architecture.md`, `terminal/terminal-size-ownership.ts` | S | — | ❓ |
| **G5 터미널 복원 스냅샷** | 구독 시 `state`/`ready` 두 모드. 보이는 복원은 기본 200줄, 최대 500줄 | `terminal/terminal-restore.ts:19-20` | M | **F26** | ◐ (F6 세션 복원) |
| **G6 MCP 터미널 도구 5종** | `create` · `kill` · `capture`(scrollback·ANSI 제거) · `send_terminal_keys` · `list` | `paseo-tools.ts:2314-2511` | M | — | ✅ (우리 MCP 카탈로그) |

### H. 확장 — 플러그인 · 스킬 (우리 P5)

| 기능 | 한 줄 | 근거 | 크기 | orca 중복 | 우리에게 있나 |
|---|---|---|---|---|---|
| **H1 플러그인 기여점 9종** | surface · sidebarItem · workspacePanel · commandCenterItem · **composerPill** · **timelineItem** · attachmentSource · **theme** · RPC 핸들러 | `docs/plugins.md`, `skills/paseo-plugin/SKILL.md` | **L** | **F16** | ✕ |
| **H2 Git 저장소에서 설치·갱신** | 0.7.0 신규. 디렉터리 설치도 됨 | `CHANGELOG.md:13` (#3920), `docs/plugins.md:80` | M | F16 | ✕ |
| **H3 플러그인 = 별도 서브프로세스** | 백엔드는 Node 전체 권한, 클라이언트는 `react`·`react-native`·`@tanstack/react-query`·`zod`·`@getpaseo/plugin` 만 | `skills/paseo-plugin/SKILL.md:450-456` | — | F16 | — |
| **H4 Zod 양방향 검증 RPC** | 입력·출력을 **양쪽에서** 검증. 자격증명·셸·벤더 호출은 핸들러에만 | `skills/paseo-plugin/SKILL.md:504-526` | S | F16 | ✕ |
| **H5 전역 스위치 `pluginsEnabled`** | **기본 false**. 스킬이 *"없는 필드는 false 로 취급하라"* 와 경고 문안까지 규정 | `skills/paseo-plugin/SKILL.md:597-614` | S | F16 | — |
| **H6 플러그인 로그 탭** | `paseo plugin logs <id>`. 초기화·핸들러·정리·크래시 출력 보존. 데몬 재시작 시 소실 | `skills/paseo-plugin/SKILL.md:530-546` | S | — | ✕ |
| **H7 스킬을 CLI 스킬 폴더에 설치** | 데몬이 번들 스킬을 `~/.agents/skills` · `~/.claude/skills` · `~/.codex/skills` 로 **동기화**한다. 상태/조정/제거/자동갱신 | `packages/server/src/server/orchestration-skills/internal/paths.ts:17-24` | S | **F17** | ✕ |
| **H8 예제 플러그인 4종** | `catppuccin`(테마) · `linear`(이슈) · `local-plugin` · `timeline-items` | `plugin-examples/` | — | F16 | — |

### I. 입력 · 탐색 (우리 P3)

| 기능 | 한 줄 | 근거 | 크기 | orca 중복 | 우리에게 있나 |
|---|---|---|---|---|---|
| **I1 Command Center** | `⌘K`. 명령·파일·워크스페이스·에이전트 + **PR/MR 번호 검색**. 부분 다중 단어 순서 무관 매칭 | `packages/app/src/command-center/` (16파일), `CHANGELOG.md:25,79` | M | **F10** | ◐ (`CommandPalette`) |
| **I2 첨부** | 파일·이미지 · 로컬 저장소 · **GC 보존 정책** · 미리보기 URL | `packages/app/src/attachments/` (20파일) | M | **F9** | ✅ #154 |
| **I3 음성 — 받아쓰기(STT)** | 스트리밍 부분 전사. Bluetooth 라우팅·재시도 타임아웃까지 다룸 | `packages/app/src/dictation/`, `CHANGELOG.md:50-52` | M | — | ✕ |
| **I4 음성 — 실시간 대화** | `@speechmatics/expo-two-way-audio` 로 AEC 걸린 16kHz PCM 양방향 | `packages/expo-two-way-audio/README.md`, `packages/app/src/voice/` | **L** | — | ✕ (#140) |
| **I5 키바인딩 커스터마이즈** | 오버라이드 저장소 · 포커스 스코프 · 라우트별 단축키 · 검색 가능한 도움말 | `packages/app/src/keyboard/` (12파일) | M | — | ◐ |
| **I6 클라이언트 슬래시 명령** | `@files` 태그 · `/commands` · `/skills` | `packages/app/src/client-slash-commands/`, `ko.ts:90` | S | — | ◐ |
| **I7 인앱 브라우저 + 에이전트 자동화 18종** | `new_tab`·`list_tabs`·`click`·`type`·`fill`·`select`·`drag`·`scroll`·`keypress`·`navigate`·`back`·`forward`·`reload`·`wait`·`screenshot`·**`snapshot`**·`logs`(콘솔+네트워크)·`resize`·`upload`·`evaluate`·`close_tab` | `packages/server/src/server/browser-tools/tools.ts` | **L** | **F18** | ◐ (`BrowserService` 있음, 도구는 없음) |
| ↑ 🔴 **경계가 있다** | *"에이전트 키 입력은 guest `sendInputEvent(skipIfUnhandled)` 로 보낸다 — 처리 안 된 Enter 는 **guest 에서 멈추고 호스트 컴포저에 도달하지 않는다**"* | `docs/architecture.md` "Browser keyboard boundary" | — | **F19** | — **우리 F19 제약의 기성 답** |
| **I8 브라우저 프로필 공유** | 모든 탭이 하나의 영속 Electron 세션. 쿠키·인증 공유. 팝업/POST 는 별도 자식 창으로 열어 OAuth·결제 프로토콜 보존 | `docs/architecture.md` "In-app browser" | M | — | ❓ |

### J. 알림 · 상태 표면

| 기능 | 한 줄 | 근거 | 크기 | orca 중복 | 우리에게 있나 |
|---|---|---|---|---|---|
| **J1 푸시 알림** | 모바일 네이티브 + 웹 | `packages/app/src/push-notifications/` | M | — | ✕ |
| **J2 데스크톱 알림 테스트 버튼** | 권한 상태 표시 + 테스트 발송 | `ko.ts`(4R 배치), `packages/app/src/desktop/` | S | — | ❓ |
| **J3 Sessions(히스토리) 화면** | 날짜 구간 헤더 · 상태 라벨 · 배지 · 더 보기 | `packages/app/src/screens/sessions-screen.tsx` | M | — | ◐ (`PastLogPanel`) |
| **J4 되감기(rewind)** | 🔴 **에이전트 대화를 이전 턴으로 되돌린다.** claude·codex·pi 제공자별 구현 | `packages/server/src/server/agent/rewind/rewind.ts` + `providers/{claude,codex,pi}/rewind.ts` | **L** | — | ✕ |
| **J5 타임라인 동기화 규약** | *"라이브 스트림은 즉시성용, `fetch_agent_timeline_request` 가 권위. 따라잡기는 페이지 단위지만 완전하다"* | `docs/timeline-sync.md` | M | — | ✕ |
| **J6 어시스턴트 텍스트를 고른 속도로** | 도착 덩어리대로가 아니라 일정 시각 속도로 흘린다 | `CHANGELOG.md:33` (#3612) | S | — | ✕ |

### K. 국제화 — §5 에서 자세히

| 기능 | 한 줄 | 근거 | 크기 | orca 중복 | 우리에게 있나 |
|---|---|---|---|---|---|
| **K1 UI 9개 언어** | en·ar·es·fr·ja·**ko**·pt-BR·ru·zh-CN. `ko.ts` **2,648줄 / 113KB** | `docs/i18n.md`, `packages/app/src/i18n/resources/` | — | — | ◐ (한국어 단일 `ko.json`) |
| **K2 번역 금지 목록이 규약이다** | 에이전트 출력·데몬 출력·터미널 내용·경로·제공자/모델명·명령명·코드·로그·서버 원문 오류는 **번역 금지** | `docs/i18n.md` "Translation Scope" | S | — | ✕(명시된 규약 없음) |
| **K3 포지 어휘 2단 규칙** | 브랜드·`PR`/`MR`·`#`/`!` 같은 **불변화 토큰**은 보간, **굴절하는 명사**(pull request/merge request)는 i18next `context`(`pullRequest` / `pullRequest_mr`) | `docs/i18n.md` "Forge-Variant Copy" | S | — | — |
| **K4 README 4개 언어** | en · zh-CN · ja · **ko** | `README.ko.md` (172줄) | — | — | — |

### L. 모바일 — 한 문단 (지시대로 깊이 안 읽음)

`packages/app` 2,212 TS 파일이 **모바일 전용이 아니다** — iOS·Android·웹·데스크톱 렌더러가 **한 Expo
코드베이스**다(데스크톱 Electron `packages/desktop` 144파일은 그 웹 빌드를 감싸는 껍데기).
따라서 *"모바일을 안 가져간다"* 는 **패키지를 통째로 버리는 선택이 아니라, 이 저장소의 UI 를
거의 못 쓴다는 뜻**이다. 모바일 고유물은 `mobile-panels`(왼쪽 목록/가운데 에이전트/오른쪽 탐색기
3택1), `push-notifications`, `native/ios-hardware-keyboard-submit`, `expo-two-way-audio`(AEC 오디오
네이티브 모듈), fastlane·eas·maestro·F-Droid 배포 파이프라인, react-native 패치 7개(`patches/`)다.
**우리가 가져올 만한 것은 UI 가 아니라 개념**이다(3택1 패널 정책, 컴팩트 레이아웃 토큰 `layout.compact`).

---

## 2. 🔴 `skills/` 정독 — 각 스킬이 실제로 무엇을 시키나

**핵심 관찰: 스킬은 코드가 아니라 마크다운 프롬프트다.** 6개 모두 `SKILL.md` 한 파일뿐이고,
실체는 §1-A 의 MCP 도구다. 스킬이 하는 일은 **그 도구를 어떤 순서로, 어떤 규율로 쓰라**는 지시다.
→ **우리 #81 에 이식할 때 코드보다 이 규율이 값어치다.** 아래는 각 스킬의 실질 내용이다.

### 2.1 `paseo` (129줄) — 나머지 다섯의 공통 레퍼런스

도구 목록 + 세 가지 **규율**:

| 규율 | 원문 요지 | 왜 값진가 |
|---|---|---|
| **프로필을 먼저 읽어라** | *"`create_agent` 에 `profile` 파라미터는 **없다**. 선택한 프로필을 호출로 **구체화(materialize)** 하라"* — `provider`+`model` 을 `provider/model` 로 합치고 `modeId`·`thinkingOptionId`·`featureValues` 를 복사 | 사람이 정한 설정을 에이전트가 **재해석하지 못하게** 한다 |
| **프로필을 기억하지 마라** | *"선택한 프로필을 기억하거나 나중에 드리프트를 추론하지 마라. 프로필은 **오직 실행 설정**이다"* | 에이전트가 "아까 그 프로필이었으니까" 로 상태를 지어내는 것을 막는다 |
| **폴링하지 마라** | *"에이전트는 10~30분+ 가 예사다. `list_agents`·`get_agent_status` 를 '확인차' 폴링하지 마라. 알림이 알려 준다"* | `skills/paseo/SKILL.md:761-767` |
| **폴백을 밝혀라** | *"맞는 프로필이 없어서 제공자 탐색으로 폴백했다면 **사용자에게 말하라**"* | 조용한 기본값 금지 |

### 2.2 `paseo-advisor` (63줄) — 조언자 하나

- **하는 일**: `list_profiles` → 질문에 맞는 프로필 선택 → `[Advisor] <주제>` 제목으로 에이전트 1개 생성 → 끝날 때까지 대기 → 사용자에게 **조언자 판정 + 내 권고**를 합쳐서 보고.
- **대비(contrast)를 규칙으로** : *"여러 프로필이 맞으면 **내 것과 다른 제공자 계열**을 골라라 — 그래야 second opinion 이 진짜 새롭다."*
- 🔴 **편집 금지 접미사가 하드코딩돼 있다** — 모든 프롬프트 끝에:
  `This is analysis only. Do NOT edit, create, or delete any files. Do NOT write code.`
- **스킬 전달(forwarding)**: `$ARGUMENTS` 안의 `/unslop` 같은 다른 스킬 참조를 파싱해서
  *"`<name>` 스킬을 Skill 도구로 먼저 로드하고 이 작업에 적용하라"* 를 브리핑에 넣는다.
  **조언자가 그 스킬을 돌리고 나는 오케스트레이터로 남는다.**
- **지속 조언자**: 사용자가 원하면 아카이브하지 않고 후속 질문을 보낸다. 주제가 바뀌면 새 컨텍스트가 낫다.

### 2.3 `paseo-committee` (46줄) — 대비되는 둘

- **언제**: *"막혔을 때, 같은 데를 돌 때, 터널비전일 때, 어려운 계획 문제."*
- **구성**: 계획/조사/근본원인에 맞는 프로필 하나 + **다른 제공자 계열**의 고추론 프로필 하나.
- **하드 룰 둘**: ① 편집 금지 접미사(위와 동일) ② *"**완료 알림을 믿어라.** 폴링·재촉·중단 금지.
  모델은 15~30분 추론할 수 있다. 놀아도 Paseo 가 알려 준다."*
- **워크플로**: 문제 수준 프롬프트 하나 → 둘을 **병렬 생성**(같은 프롬프트) → 둘 다 대기 →
  🔴 **불일치는 서로의 논거를 주고받아 해소** → **수렴할 때까지 반복** → 합의 + *어디서 갈렸고
  어떻게 풀렸는지*를 사용자에게 요약.

### 2.4 `paseo-handoff` (65줄) — 인계

- **가장 실용적인 산출물은 브리핑 템플릿이다.** 받는 에이전트는 컨텍스트가 **0** 이라는 전제:
  `## Task`(명령형) / `## Context` / `## Relevant files`(경로 + *왜 중요한지*) / `## Current state`
  (된 것·되는 것·안 되는 것) / `## What was tried`(접근 — **왜 실패했나**) / `## Decisions`(결정 — 근거) /
  `## Acceptance criteria`(체크박스) / `## Constraints`(하면 안 되는 것·보존할 것)
- 🔴 **작업 의미를 보존하라**: *"조사만 → 'DO NOT edit files.' 수정 → 'implement the fix.'
  리팩터 → 'refactor, not rewrite.' **사용자의 정확한 의도를 옮겨라.**"*
- **파일은 붙여넣지 말고 경로로 준다** — *"paste 하지 마라, 에이전트가 읽게 하라."*
- **격리**: `"in a worktree"` 라고 하면 작업 이름에서 짧은 브랜치명을 만들어 워크트리 워크스페이스 생성.
- 🔴 **분리(detach)는 도구가 아니다**: *"독립성을 create 모드로 인코딩하지 마라. CLI·와이어 수준
  detach 연산을 부르지 마라. **분리는 서브에이전트 트랙에서의 사용자 제스처다.**"*
- advisor/committee 와 달리 **대기하지 않는다**(fire-and-forget).

### 2.5 `paseo-help` (92줄) — 제품 자체 문의 (우리에게 가장 덜 관련)

값진 것은 **진단 규율**이지 내용이 아니다:
- **먼저 토폴로지를 확정하라** — *"클라이언트에서 데몬을 추론하지 마라. Desktop 은 번들 로컬
  데몬을 관리하면서 **동시에** 다른 원격 데몬에 붙을 수 있다."* 어느 데몬인지 / 어떻게 닿는지 둘을 세운다.
- **상태 바꾸기 전에 진단하라** — 읽기 전용 검사만 먼저. 🔴 *"데몬 재시작은 **진단 중인 그
  에이전트를 죽일 수 있다.**"* 사용자 명시 허락 없이 재시작·설정 편집·업데이트·리스너 노출 금지.
- **로그를 공유하기 전에 자격증명·페어링 오퍼·토큰·비밀번호·사용자 코드를 가려라.**
- *"셸 별칭과 함수는 실행 경로가 아니다"* (provider not found 진단).
- 문서는 **배포된 것**을 `llms.txt` 인덱스로 가져와 읽는다(기억보다 우선). **문서로 떠넘기지 말고 직접 답하라.**

### 2.6 `paseo-plugin` (381줄) — 가장 긴 스킬. 사실상 플러그인 SDK 문서

§1-H 가 기능 목록이고, 여기서는 **규율**만:
- 🔴 **설치 전 전역 스위치를 확인하라.** `pluginsEnabled` 가 false/부재면 **멈추고 허락을 구하되
  정해진 경고 문안을 포함**하라: *"플러그인은 신뢰되는 비샌드박스 코드입니다. 백엔드 코드는
  데몬 머신의 파일·프로세스·자격증명·네트워크에 접근할 수 있습니다…"*
  그리고 *"개별 플러그인의 `disabled` 로 전역값을 추론하지 마라."*
- 🔴 **데몬을 재시작해 소스 변경을 반영하지 마라 — 작업 중인 에이전트를 죽인다.** `plugin reload` 를 써라.
- **테마 규율**: *"모든 `Text` 는 `theme.colors` 에서 색을 가져와야 한다. 스타일 없는 텍스트는
  검은색이고 다크 테마에서 실패한다."* 패딩은 `layout.compact`.
- **검증 절차 5단계**: typecheck → 정확한 런타임 ID 로 설치/리로드 → `plugin ls` 가 `running`
  이고 오류 없음 → **넓은 데스크톱 창과 컴팩트/모바일 양쪽 + 테마 전환**으로 확인 → 오류 상태까지 실행.
- **API 선택 규칙**: 평범한 Paseo 조작은 기존 SDK, 플러그인 고유 백엔드 동작만 플러그인 RPC.
  *"surface 안에서 다른 클라이언트를 만들지 마라 — `usePaseo()` 가 선택된 호스트의 연결을 빌린다."*
- *"셀렉터는 필수다. 전체 스냅샷을 고르지 말고, 활성 워크스페이스를 알아내려고 RPC 를 추가하지 마라."*

### 2.7 → 우리 #81 로 가져올 것 (판단이 아니라 관찰)

**코드 없이 가져올 수 있는 것**(전부 S): 편집 금지 접미사 · 인계 브리핑 템플릿 8절 ·
"작업 의미 보존" 4줄 · "폴링하지 마라, 알림을 믿어라" · "대비되는 제공자를 골라라" ·
"프로필을 기억하지 마라" · "폴백했으면 말하라" · "분리는 사용자 제스처다".

**코드가 필요한 것**: `list_profiles` 저장소(S) · `create_agent`/`send_agent_prompt`(M) ·
서브에이전트 트랙 UI(M) · 완료 알림(S).

---

## 3. 우리에게 없고 저쪽에 있는 것

**Orca 와 겹치는 것**(= 이미 우리 로드맵에 F 번호가 있는 것)은 **번호만** 적는다. 두 번 세지 않기 위해서다.

### 3.1 이미 우리 로드맵에 있음 (Paseo 는 "다른 구현" 또는 "완성품")

`F5` 사용량 · `F6` diff · `F7` 줄 코멘트 · `F8` 미리보기 · `F10` quick open ·
`F12` 워크트리 병렬 · `F13` GitLab · `F16` 플러그인 · `F17` 스킬 · `F18` Design Mode ·
`F24` 별도 PTY 프로세스 · `F25` headless 화면 모델 · `F26` 복원 · `F27` 백프레셔.
→ **이식 시 Paseo 쪽을 참조하면 유리한 자리**: `F13`(포지 레지스트리·`glab` 프로브 — orca 보다 낫다),
`F7`(리뷰 초안 → 첨부 스냅샷 경로가 통째로 있다), `F19`(브라우저 키 경계의 기성 답).

### 3.2 orca 목록에 **없던** 새 항목 (= 로드맵에 F 번호가 없다)

| # | 무엇 | 크기 | 근거 |
|---|---|---|---|
| P1 | **하트비트** — 크론이 *지금 이 대화로* 프롬프트를 되돌려 보낸다 | S | §1-A6 |
| P2 | **되감기(rewind)** — 에이전트 대화를 이전 턴으로 | L | §1-J4 |
| P3 | **에이전트 프로필**(`notes` 포함) | S | §1-A2 |
| P4 | **서브에이전트 트랙 + 사용자 제스처 detach** | M | §1-A3 |
| P5 | **워크스페이스 라벨**(호스트별 색 카탈로그) | M | §1-F5 |
| P6 | **워크스페이스 스크립트 + 서비스 프록시**(`<script>--<branch>--<project>.localhost`) | M | §1-C13/F3 |
| P7 | **9개 언어 i18n + 번역 금지 목록 규약** | M | §1-K |
| P8 | **음성 — 받아쓰기 / 실시간 대화** | L | §1-I3/I4 |
| P9 | **모바일 + 웹 클라이언트 + E2E 릴레이 페어링 + Docker** | L | §1-C7~C9 |
| P10 | **Paseo Hub**(조직 트리거) | L | §1-C11 |
| P11 | **브라우저 자동화 도구 18종**(F18 보다 넓다 — snapshot·logs·upload·evaluate) | L | §1-I7 |
| P12 | **CodeMirror 편집기 + vim 모드** | M | §1-D3 |
| P13 | **mermaid 다이어그램 렌더링** | S | §1-D7 |
| P14 | **재귀 파일 감시**(플랫폼별 네이티브) | M | §1-D8 |
| P15 | **9개 의미 권한 + principal/credential/grant 모델** | M | §6 |
| P16 | **터미널 활동 훅의 세 규율** — opt-in 게이트 · 공유 토큰 · 마커 멱등 설치 | S | §1-B2/B3/B6 |
| P17 | **Codex 네이티브 훅**(우리 "codex 는 훅 없음" 가정이 낡았다) | S | §1-B4 |
| P18 | **Ctrl-C 억제 + 포커스가 주의를 지운다** | S | §1-B9/B10 |
| P19 | **체크 상태 `traits` 열린 배열**(정규화 유니온은 고정) | S | §1-E5 |
| P20 | **8MiB 소켓 상한 + ping 임차** | S | §1-C5/C6 |

### 3.3 우리에게 있고 저쪽에 없는 것 (전부 확인함)

| 무엇 | 확인 방법 |
|---|---|
| **RDP** | `src/main/rdp/`, `RdpView.tsx`·`RdpSpanWindow.tsx` ↔ paseo 전체 grep 0건 |
| **SFTP** | `src/main/sftp/`, `registerSftpIpc.ts` ↔ paseo `sftp` grep **0건** |
| **포트 모니터 / 포워딩** | `src/main/forward/PortForward.ts`, `PortMonitor.tsx`·`PortWindow.tsx` ↔ paseo `port.forward` grep 0건 |
| **서버 콘솔** | `ProcessTable`·`ServiceTable`·`DiskTable`·`PkgTable`·`ContainerTable`·`K8sPanel`·`SysMonitorPanel`·`ServerOverview`, `src/main/remote/RemoteConsoleService.ts` ↔ paseo `systemctl`·`kubectl`·`docker ps` grep **전부 0건** |
| **SSH 터미널 자체** | `src/main/sessions/ssh/SshBackend.ts` (ssh2) ↔ **paseo 에 `ssh2` 의존성 0건.** 저쪽 ssh 는 원격 *데몬*까지의 포트 터널뿐(`packages/cli/src/ssh/ssh-tunnel.ts:27`) |
| **여러 서버를 운영하는 관점** | 우리 `ConnTree`·`ServerTool`·`WorkProfileModal` ↔ 저쪽은 "여러 **데몬**"이지 "여러 **서버**"가 아니다 |
| **MCP 호출별 승인 게이트 + 감사 로그** | 우리 `src/main/mcp/approval.ts`(3등급)·`askUser.ts`·`auditLog.ts` ↔ 저쪽은 principal 권한만 보고 호출마다 묻지 않는다(§6) |
| **에이전트에게 안 주기로 한 것을 도구 부재로 표현** | `tools.ts:8-12` — `ai:*`·`profile:*`·`ssh:forgetHostKey`·`window:*`·`fs:*` 를 **툴을 안 만드는 것으로** 표현 불가능하게 했다 ↔ 저쪽은 `respond_to_permission` 이 있다 |
| **사내 배포·자동 업데이트** | `src/main/update/` ↔ 저쪽은 공개 릴리스/스토어/F-Droid |

⚠️ **정정 하나**: orca-analysis §2 표의 *"우리만: MCP 서버"* 는 **Paseo 상대로는 틀리다.**
Paseo 도 MCP 서버가 있고 **도구가 40개로 우리보다 많다**. 우리 우위는 존재가 아니라 **경계**다(§6).

---

## 4. Orca 와 겹치는 자리 — 어느 쪽을 보는 게 나은가 (중복 이식 방지)

| F | 우리 항목 | Orca | Paseo | 비고 |
|---|---|---|---|---|
| F1 | 훅 상태 | 로컬 HTTP + curl 한 줄 | **CLI 서브명령 `paseo hooks <p> <e>` + 토큰 + opt-in 게이트** | ✅ 우리는 orca 식으로 이미 냈다. **Paseo 에서 가져올 것은 B2·B3·B6·B9·B10 다섯 개 규율** |
| F5 | 사용량 | 폴백 사다리(끝은 PTY 화면 긁기) | **8제공자 · 화면 긁기 없음** | Paseo 쪽이 깨끗하다 |
| F6/F7 | diff + 코멘트 | 있음 | **초안→첨부 스냅샷 경로까지 있음** | Paseo 를 보는 게 낫다 |
| F12 | 워크트리 병렬 | UI 있음 | **3모드 + PR 체크아웃 + 셋업 스크립트** | Paseo 가 넓다 |
| F13 | GitLab | ⚠️ orca 는 "GitHub 우선, GitLab 뒤따라" | 🔴 **레지스트리/매니페스트가 원칙. 자체호스팅 런타임 프로브** | **Paseo 를 봐라** |
| F16 | 플러그인 | 109파일/7능력 | **기여점 9종 + Git 설치 + Zod RPC** | 능력 열거형은 orca, 기여 표면은 Paseo |
| F17 | 스킬 | 클라우드 배포까지 | **CLI 스킬 폴더 동기화(3곳)** | Paseo 가 우리 규모에 맞다 |
| F18/F19 | Design Mode / Computer Use | OS 앱 조종(위험) | **인앱 브라우저로 한정 + 키 경계** | 🔴 **Paseo 의 범위 한정이 우리 F19 제약과 같다** |
| F24~F26 | 데몬·PTY·복원 | daemon 342 + runtime 997 | server 931 전체 | 둘 다 L. 우리 기준으론 Paseo 가 작다 |
| F27 | 백프레셔 | 누적 ACK | **`bufferedAmount` + 스냅샷 강등** | 🔴 **셋 다 다르다.** Paseo 식은 C3(headless 화면 모델)이 있어야 성립한다 |

---

## 5. 한국어 지원 실태

**결론: UI 번역은 실재하고 상당히 넓다. 다만 orca 식 "사람이 고친 오역을 못 박는 테스트"는 사실상 없다.**

| | 사실 | 근거 |
|---|---|---|
| 범위 | UI 9개 언어. `ko.ts` **2,648줄 / 112,991바이트**(en 2,743줄과 키 동수) | `packages/app/src/i18n/resources/ko.ts` |
| 도입 시점 | **Batch 5B 로 가장 늦게 추가**(pt-BR 5A 다음, ar/fr/ru/es 는 4Z) | `docs/i18n.md` "Progress" |
| 품질 | 자연스러운 편. `"명령, 파일, 워크스페이스 및 에이전트 검색..."`, `"에이전트에게 메시지를 보내거나 @files 태그, /commands, /skills를 사용하세요"` | `ko.ts:58,90` |
| 게이트 ① | **키 동수** — 모든 언어가 en 과 정확히 같은 키 집합 | `resources.test.ts:107-117` |
| 게이트 ② | **폴백 비율 상한** — 영어와 똑같은 문자열이 **전체의 25% 미만**이어야 한다 | `resources.test.ts:119-130` |
| 게이트 ③ | **보간 자리표시자 보존** — `{{count}}` 등이 유실되면 실패 | `resources.test.ts:141-150` |
| 게이트 ④ | **`{{count}}` 어순 못 박기** — 한국어는 `"모델 {{count}}개"` 로 고정 | `resources.test.ts:170` |
| 게이트 ⑤ | ⚠️ **"검토된 한국어 상태 라벨 보존" — 딱 2개뿐**: `common.states.starting === "시작 중..."`, `desktop.daemon.status.notRunning === "실행 중이 아님"` | `resources.test.ts:181-184` |

→ orca 는 **전용 테스트 파일**(`ko-ui-semantic-mistranslations.test.ts`)로 사람이 고친 오역을 못 박았는데
Paseo 는 **범용 테스트 안의 2줄**이다. 같은 아이디어의 **훨씬 얕은 버전**이다.
(⚠️ 방법 메모: `mistranslat` 로 grep 했을 때 0건이 나왔는데, `fallbackRatio`·`interpolation` 으로
**양성 대조**를 걸어 검색 자체는 동작함을 확인한 뒤에야 이 2줄을 찾았다. 검색어가 틀렸던 것이지 부재가 아니었다.)

**번역 금지 목록이 규약으로 적혀 있다**(우리에게 없는 것):
에이전트 출력 · 데몬 출력 · 터미널 내용 · 파일 경로 · **제공자·모델명** · 명령명 · 사용자 작성 텍스트 ·
코드 블록 · 로그 · **원시 프로토콜/서버 오류 문자열**. (`docs/i18n.md` "Translation Scope")

**한국어 README** 는 172줄로 영어(195줄)와 거의 대등하다. 마케팅 문구까지 번역돼 있다.

---

## 6. 인가 모델 — 🔴 **orca 와 정반대의 판정이 필요하다**

orca-analysis §6 은 *"인가 모델은 가져오면 안 된다. 우리 것이 더 강하다"* 였다.
**그 문장은 orca 에만 맞다.** Paseo 의 데몬 인가는 orca 보다 훨씬 정교하다.

**Paseo 가 더 나은 부분** (`docs/permissions.md`):
- **principal(지속 신원) / credential(장치·서비스 증명) / grant(권한 부여)를 분리.**
  *"자격증명을 회전하고, 장치를 여러 개 붙이고, Hub 사용자를 폐기할 수 있게 — 데몬 사용자 계정을
  발명하지 않고."*
- **9개 의미 권한**: `daemon.read/manage` · `tunnel.manage` · `access.manage` ·
  `workspace.read/write/manage` · `automation.manage` · `hub.execute`.
  🔴 *"**RPC 이름과 프로토콜 네임스페이스는 권한이 아니다.**"*
- **약화(attenuate)는 되고 확대는 안 된다** — *"위임하는 principal 은 자기가 이미 가진 권한만 줄 수 있다."*
- **덧셈만, 거부 우선순위 없음** — *"권한을 추가하는 것이 기존 principal 을 조용히 넓혀서는 안 된다."*
- **Owner/operator/viewer 는 UI 프리셋이지 저장되는 역할이 아니다.**
- **자기 한계를 문서가 적는다**: *"파일 미리보기는 지금 데몬이 읽을 수 있는 **아무 정규 파일이나**
  받으므로, 워크스페이스 단위 접근이 나가기 전에 리소스 강제를 얻어야 한다."*
- **에이전트와 터미널을 일부러 같은 권한에 둔다**: *"둘 다 코드를 실행하고 워크스페이스를 바꾼다.
  쓰기 권한을 나누면 **데몬이 강제할 수 없는 격리 경계를 주장하게 된다.**"* — 정직한 설계다.

**우리 것이 더 강한 지점 — 그런데 내가 처음 적은 표는 틀렸다. 우리 저장소를 읽고 고쳤다.**

⚠️ 처음에 *"에이전트가 명령 문자열을 보낼 수 있나 → Paseo 예 / 우리 아니오"* 라고 적었다.
**틀렸다.** 우리 `session_input{sessionId, data: z.string()}` 도 임의 문자열을 PTY 에 그대로 쓴다
(`src/main/mcp/tools.ts:383-395`). orca-analysis §6 의 *"AI 는 명령 문자열을 못 보낸다"* 는
**`server_run` 에만 해당하는 불변식**이지 카탈로그 전체의 성질이 아니다.

| | Paseo | A.R.A |
|---|---|---|
| 임의 문자열을 PTY 에 | `send_terminal_keys{terminalId, keys}` (`paseo-tools.ts:2476-2500`) | **똑같이 있다** — `session_input{sessionId, data}` (`tools.ts:383-395`) |
| 그 호출마다 사람 승인이 붙나 | ✕ — `workspace.write` 권한이면 끝 | ✅ **`gated(...)` 래퍼 + 3등급**(`readOnly`/`sessionInput`/`writeAlways`) + 감사 로그. ⚠️ 단 `sessionInput` 은 사용자가 `autoAllow` 로 풀 수 있다(`approval.ts:216`) |
| 고정 카탈로그 `{id, args}` 경로 | 없음 | ✅ `server_run{cmdId, args}` — `isPrivileged(cmdId, args)` 가 등급을 표에서 읽는다(`tools.ts:634-664`) |
| 🔴 **에이전트가 승인 요청에 스스로 응답** | **예** — `respond_to_permission{agentId, requestId, response}` (`paseo-tools.ts:3124-3151`) | **없다** — 카탈로그가 `ai:*` 를 *"툴 자체를 안 만드는 것으로 표현 불가능하게"* 뺐다(`tools.ts:8-12` 주석) |

→ **진짜 차이는 "문자열을 보낼 수 있나"가 아니라 두 가지다:**
① **모든 호출이 등급 붙은 승인 게이트를 지나는가** ② **에이전트가 승인 자체를 대신할 수 있는가.**
`workspace.write` 하나면 Paseo 는 `create_terminal` + `send_terminal_keys` 로 **무제한 셸**이고,
`respond_to_permission` 은 orca 의 `agent-trust-presets.ts` 보다 **한 걸음 더 갔다** — orca 는
신뢰 표식을 미리 써 두는 우회였는데 여기는 **승인 응답 자체가 도구다.**
(저쪽 문서는 이걸 숨기지 않는다 — *"에이전트와 터미널은 같은 권한"*. **일관된 입장이지 사고는
아니다.** 다만 우리 입장과 다르다.)

⚠️ **우리 쪽 값싼 확인거리 하나**: `sessionInput` 등급의 `autoAllow` 모드가 켜져 있으면
우리도 무인 임의 실행이 된다. **그 모드가 언제 켜지고 사용자에게 어떻게 보이는지**는 이번에 안 봤다.

→ **판정: 권한 *모델*(principal/credential/grant · 9권한 · attenuation · "RPC 이름은 권한이 아니다")은
배울 것이 많다. 도구 표면(`send_terminal_keys`·`respond_to_permission`)은 우리 게이트를 무너뜨린다.**
둘을 갈라서 봐야 한다.

**저쪽 경계에서 훔칠 것 둘**:
1. *"RPC 이름과 프로토콜 네임스페이스는 권한이 아니다"* — 우리 MCP 카탈로그가 도구 이름으로
   권한을 암시하고 있으면 같은 실수다.
2. `gitlab-service.ts:762`: *"`-` 로 시작하는 위치 인자가 플래그로 재해석되지 못하게 막는다"* —
   orca `git-exec-validator.ts:37-40`(플래그 밀수)의 **다른 얼굴**이다.
   ✅ **우리는 이미 한 번 맞고 고쳤다** — `tools.ts:660-664` 주석: *"`args` 는
   `z.record(...unknown)` 이라 `{sudo:true}` 가 그대로 통과하는데 wrapSudo 를 쓰는 셋
   (ctr.list·k8s.list·app.trace)은 읽기 명령이라 `write` 가 없다 — 그래서 아라가 **다이얼로그 없이
   원격 root 실행**을 할 수 있었다(2026-08-28 감사)."* 지금은 `isPrivileged(cmdId, args)` 가 막는다.
   → 저쪽 두 사례와 합쳐 **같은 실패 모드가 세 저장소에서 각각 한 번씩 났다.** 새 도구가
   자유 인자를 받을 때마다 되묻는 것이 값싸다.

---

## 7. `custom-providers` · `forge-providers` — 사내 GitLab 자리인가 (우리 F13)

**둘은 다른 축이다. 사내 GitLab 은 `forge-providers` 쪽이다.**

### 7.1 `forge-providers` = 우리 F13 의 자리 ✅

- **자체호스팅 GitLab 을 이름 추측이 아니라 런타임 프로브로 잡는다.**
  `glab auth status --hostname <host>` 가 exit 0 이면 GitLab 이다
  (`gitlab-service.ts:784-795`). → **`gitlab.내부도메인.com` 처럼 이름에 힌트가 없어도 된다.**
- **인증 전제**: `glab` CLI 설치 + `glab auth login --hostname <host>`.
  OAuth 앱 등록도, 토큰 관리 코드도 우리가 안 짠다(`forge-manifest.ts` gitlab 항목의 `signIn`).
- **어휘가 매니페스트에 데이터로 있다**: MR / merge request / `!` 접두어. UI 문안이 자동으로 따라간다.
- **레지스트리가 원칙이다** — *"중앙 포지 스위치를 만들지 마라"*, *"프로토콜 유니온 분기 금지"*.
  ⚠️ **orca-analysis F13 의 경고(*"GitHub 우선이고 GitLab 은 뒤따라 붙였으니 그쪽 추상화를 믿지 마라"*)는
  Paseo 에는 해당하지 않는다.** 여기는 설계가 먼저다.
- ⚠️ 다만 **규모는 정직하게**: gitlab 1,411 + gitea 2,297 + github 4,118 = 7,826줄.
  우리가 MR 목록·상태 정도만 원한다면 **어댑터 인터페이스와 매니페스트 아이디어만** 가져오면 된다.

### 7.2 `custom-providers` = **AI 제공자**이지 git 이 아니다 ✕

`$PASEO_HOME/config.json` 의 `agents.providers` — 내장 제공자 확장(`extends`), 커스텀 바이너리,
제공자 비활성화, **ACP**(Agent Client Protocol — *"LSP 같은데 AI 에이전트용"*) 제공자 추가.
805줄 문서에 Z.AI·Qwen·커스텀 OpenAI 호환 엔드포인트 레시피가 있다.
→ **사내 GitLab 과 무관하다.** 다만 *"사내에 자체 LLM 엔드포인트를 붙인다"* 가 언젠가 필요하면 이 자리다.
(내장 ACP 카탈로그: CodeWhale · Cursor · DeepAgents · DimCode · Gemini CLI · Hermes · Qwen Code · Kimi Code —
`docs/custom-providers.md:458`)

---

## 8. 못 본 자리 (정직하게)

- **아무것도 빌드·실행하지 않았다.** 모든 수치는 파일 수·줄 수이거나 저쪽 문서 인용이다.
- `packages/app` 2,212파일 중 **읽은 것은 디렉터리 목록과 파일 10개 미만**이다. UI 동작은 문서와
  i18n 문자열로 유추했다.
- **모바일은 지시대로 안 읽었다**(§1-L 한 문단).
- **`packages/server` 931파일 중 읽은 것**: MCP 도구 카탈로그, 훅 제공자 3개, quota-fetcher 매니페스트,
  forge 레지스트리·매니페스트, gitlab 일부, terminal-restore 일부, orchestration-skills 일부.
  `agent-manager.ts`·`session.ts`·`websocket-server.ts`·`rewind/`·`schedule/`·`file-observer/` **안 읽음**.
- **CHANGELOG 174KB 중 최근 2개 버전만** 읽었다(0.7.0·0.6.x). 0.5.0 이하는 목차만 봤다.
- **우리 저장소는 §6 관련만 읽었다** — `src/main/mcp/tools.ts`(943줄) 앞부분·`session_input`·
  `server_run`·`approval.ts` 의 등급 정의. 그 덕에 **§6 표를 한 번 고쳤다**(처음 적은
  *"우리는 명령 문자열을 못 보낸다"* 가 틀렸다). 나머지 비교는 디렉터리·파일명 수준이다.
- **아래는 검증 못 한 것들** — 표에 ❓ 로 표시한 자리:
  - 우리 F1b 가 opt-in 게이트·공유 토큰·마커 멱등 설치를 갖고 있는지 (`src/main/agent/` 를 안 읽었다)
  - `sessionInput` 등급의 `autoAllow` 가 언제 켜지고 사용자에게 어떻게 보이는지
  - 우리 `EditorWindow.tsx` 와 저쪽 CodeMirror 편집기의 기능 대비
  - 저쪽 워크트리 지문 게이트(orca F14)·`GitCapabilityCache`(F15) 대응물 — **찾지 못했다.**
    ⚠️ 이건 "없다"가 아니라 **"내 검색이 못 찾았다"** 다(양성 대조를 안 걸었다).
  - `terminal-restore.ts` 의 기록 프레이밍(orca F26)이 길이 접두어+seq 를 쓰는지 — 앞 30줄만 봤다.
- **`docs/` 41개 중 전문을 읽은 것**: `product.md` · `permissions.md` · `terminal-activity.md` ·
  `i18n.md` · `file-observation.md`. 나머지는 앞 14~140줄.
- **`SECURITY.md`(9.9KB) 안 읽음** — 저쪽 위협 모델이 여기 있다.
- **`CLAUDE.md`(21.5KB)·`docs/coding-standards.md`·`docs/qa.md`·`docs/testing.md` 안 읽음** —
  orca-analysis §5(유지보수 기계장치)에 대응하는 축이다. `knip.json`·`.oxlintrc.json`(14KB)·
  `lefthook.yml` 존재만 확인했다.
