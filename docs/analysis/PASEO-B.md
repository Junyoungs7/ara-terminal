# Paseo 분석 B — 권한 경계 · 릴레이 · 라이선스 (읽기 전용 정적 분석)

대상 `D:\paseo` · HEAD `0c38749` (`fix(server): rewind paginated Codex threads (#4119)`) · v0.7.0
**빌드·실행 안 함. `D:\AI\OFA` 는 읽기만. 커밋 안 함.**

---

## 0. 라이선스 한 줄 판정

> **Paseo 는 Apache-2.0 이다. 코드를 가져와도 된다. 조건은 ① Apache-2.0 사본 동봉 ② 저작권·특허·상표·귀속 고지 보존 ③ 고친 파일에 "변경했음" 표시. NOTICE 파일은 없으므로 NOTICE 의무는 발생하지 않는다. CLA·DCO·상표 정책 없음. 단, `packages/expo-two-way-audio/` 와 `packages/highlight/src/astro/` 는 제3자 MIT 이고, `packages/app/src/terminal/local-links/` 2파일은 Microsoft MIT 유래이므로 이 셋을 가져올 때는 각각의 MIT 고지를 따로 보존해야 한다.**

메인의 판정("서두는 제3자 캐리아웃일 뿐, 본문은 Apache-2.0 전문")은 **맞다.** 아래에서 바이트로 검증했다.

### 어떻게 확인했나 (요약이 아니라 절차)

1. `LICENSE` 전체 211줄을 눈으로 읽었다(1–60 / 60–160 / 160–211 세 번에 나눠). 파일 크기 11,919 B, `md5 = eac59c3a044cb4eb176ec69b76eb4f31`.
2. **바이트 비교**: 로컬에 있던 정본 Apache-2.0(`D:\AI\OFA\node_modules\playwright\LICENSE`)과 `LICENSE` 의 11–211줄을 CRLF 정규화 후 `diff` 했다. 결과 **차이 1곳뿐**:

```
189,190c189
<    Portions Copyright (c) Microsoft Corporation.        ← playwright 가 부칙에 자기 이름을 채운 것
<    Portions Copyright 2017 Google Inc.
---
>    Copyright [yyyy] [name of copyright owner]           ← Paseo 는 부칙 자리표시자를 그대로 둠
```

즉 **조항 본문(1–9조 + END OF TERMS)은 정본과 한 바이트도 다르지 않다.** Commons Clause·비상업 조항·추가 제한 **없음**.

### 원문 인용 — 캐리아웃 서두 (`LICENSE:1-8`)

```
Copyright (c) 2025-present Mohamed Boudra

Portions of this software are licensed as follows:

* Third-party components incorporated into Paseo remain licensed under
  the licenses provided by their respective copyright holders.
* Except for those third-party components, Paseo is licensed under the
  Apache License, Version 2.0, reproduced below.
```

→ "Portions … as follows" 는 **AGPL/BSL 혼합 신호가 아니라** 제3자 컴포넌트를 빼놓겠다는 문장이다. 두 번째 불릿이 "그 제3자를 **제외한 Paseo 는** Apache-2.0" 이라고 못 박는다.

### 패키지별 `license` 필드 — 전수 (16개 `package.json` 전부, `node_modules` 제외)

| 파일 | 이름 | `license` |
|---|---|---|
| `package.json:14` | `paseo` (private) | **`"Apache-2.0"`** |
| `packages/desktop/package.json:7` | `@getpaseo/desktop` (private) | **`"Apache-2.0"`** |
| `packages/expo-two-way-audio/package.json:15` | `@getpaseo/expo-two-way-audio` (**공개 배포**) | **`"MIT"`** |
| `packages/app/package.json` | `@getpaseo/app` (private) | 없음 |
| `packages/website/package.json` | `@getpaseo/website` (private) | 없음 |
| `packages/cli`·`client`·`highlight`·`plugin`·`protocol`·`relay`·`server` | `@getpaseo/*` (**공개 배포**, `private` 아님) | **없음** |
| `packages/app/modules/paseo-hardware-keyboard`·`paseo-native-trace` | (private) | 없음 |
| `packages/expo-two-way-audio/examples/{basic-usage,flow-api}` | 예제 | 없음 |

- **`license` 필드가 없는 것은 무라이선스라는 뜻이 아니다.** 저장소 루트 `LICENSE` 가 저장소 전체를 덮는다. 우리가 **git 저장소에서** 코드를 가져오는 한 Apache-2.0 이 적용된다.
- 다만 `@getpaseo/cli`·`relay`·`server` 등은 npm 에 공개 배포되면서도 tarball `files` 에 `LICENSE` 를 넣지 않고 `license` 필드도 비어 있다 → **npm 레지스트리 상으로는 라이선스 미표기**다. 저쪽의 위생 문제이지 우리 위험은 아니다. **npm tarball 이 아니라 git 저장소를 출처로 삼아라.**

### 제3자 캐리아웃 — 실제로 무엇인가 (파일 전수)

`node_modules`·`.git` 제외하고 트리 전체에서 `LICENSE*`·`NOTICE*`·`COPYING*`·`COPYRIGHT*` 를 찾은 결과 **정확히 3개**:

1. `LICENSE` (루트, 위 참조)
2. `packages/expo-two-way-audio/LICENSE:1-3` — 원문:
   ```
   MIT License

   Copyright (c) 2023, Cantab Research Ltd.
   ```
   (`package.json:15` 의 `"license": "MIT"` 와 일치)
3. `packages/highlight/src/astro/LICENSE:1-3` — 원문:
   ```
   MIT License

   Copyright (c) 2026 Zulfazli (Fazelllyyy)
   ```

**`NOTICE` 파일은 저장소에 없다.** → Apache-2.0 4조(d)의 NOTICE 재배포 의무는 **발생하지 않는다.**

### 헤더 주석의 라이선스 고지 — 전수

소스 전체(`*.ts,tsx,js,swift,kt,java,m,h,astro,css,md`)에서 `Copyright` 를 grep 한 결과 **3곳뿐**:

- `packages/app/src/terminal/local-links/terminal-local-link-parsing.ts:1-4`
  ```
  /*
   * Adapted from MIT-licensed upstream terminal link parsing.
   * Copyright (c) Microsoft Corporation.
   */
  ```
- `packages/app/src/terminal/local-links/terminal-local-link-provider.ts:1-4` — 같은 형태(`link provider behavior`)
- `packages/desktop/src/features/browser-automation/aria-snapshot-script.ts:3-4`
  ```
  // Adapted from Playwright's injected ARIA snapshot model.
  // Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0.
  ```

우리가 **터미널 링크 파싱**을 가져온다면 이건 VS Code(MIT) 유래이므로 MIT 고지를 유지해야 한다 — 실수하기 쉬운 자리다.

### 상표 · CLA

- **상표 조항**: `LICENSE:148-151` 의 Apache 6조가 전부다. 별도 상표 정책 파일 없음. `--include="*.md"` 로 `trademark|™|®` grep → **0건**(LICENSE·CHANGELOG 제외). → "Paseo" 이름·로고는 쓰지 말고 코드만 가져오면 된다.
- **CLA/DCO**: `contributor license agreement|CLA|Developer Certificate of Origin|DCO|cla-assistant|signed-off-by` 를 `*.md,*.yml,*.yaml` 전수 grep → **0건**. `CONTRIBUTING.md` 140줄 정독 — 서명 요구 없음. 기여자는 Apache-2.0 5조(Submission of Contributions) 기본 규칙으로 들어온다.
- **표기 일관성**: `README.md:193-195` = "## License / Apache-2.0", `docs/product.md:19` = "**Open source** — Apache-2.0". 루트 `LICENSE` 와 어긋나는 표기 **없음**.

### 우리가 지킬 것 (가져올 때 체크리스트)

1. 가져온 파일이 있는 우리 배포물에 **Apache-2.0 전문 사본** 포함
2. `Copyright (c) 2025-present Mohamed Boudra` **고지 보존**
3. 고친 파일에 **변경 표시**(4조 b)
4. `expo-two-way-audio`/`highlight/src/astro`/`terminal/local-links` 를 가져오면 **각 MIT 고지 별도 보존**
5. NOTICE 의무 없음 · CLA 없음 · 상표는 안 씀

---

## 1. 권한 모델 비교표 — A.R.A vs Paseo (vs Orca)

| 축 | **A.R.A (우리)** | **Paseo v0.7.0** | Orca(§6 기준) |
|---|---|---|---|
| AI 가 보내는 것 | 고정 카탈로그의 `{id, args}` **만** | **도구 40개 고정 카탈로그** — 그러나 그중 `send_terminal_keys` 가 **자유 문자열을 PTY stdin 으로** 흘린다 | 명령 ~200개 고정, 그중 3개가 자유 문자열 |
| 자유 명령 실행 | ❌ 불가 | ⚠️ **가능** (`paseo-tools.ts:2476-2509`) | ⚠️ 가능 |
| 동의 우회 | 없음 | 🔴 **에이전트가 자기/남의 승인 프롬프트를 스스로 통과시킬 수 있다** (`set_agent_mode`+`respond_to_permission`) | `agent-trust-presets.ts` (신뢰 표식 선기입) |
| 인가 단위 | 도구 id | **의미 권한 9종**(`daemon.read` … `hub.execute`) × 전 RPC 매핑표 | 없음(전송로가 유일 경계) |
| 매핑 누락 방지 | — | ✅ **`satisfies Record<InboundOperation,…>` 컴파일 타임 전수** + Zod 스키마에서 타입을 뽑아 비교하는 테스트 | `agent-context --json` 자기 직렬화 |
| 실효 권한(기본) | — | 🔴 **로컬·릴레이 세션 전부 `OWNER_PERMISSIONS`(9종 전부)**. 좁혀지는 건 Hub 뿐 | 전부 |
| 전송로 인증 | (해당 없음) | 데몬 비밀번호 **bcrypt cost 12**, MCP 능력토큰 **`timingSafeEqual`** — **Orca 보다 낫다.** 단 **기본값은 비밀번호 없음 = 무인증** | 파일의 평문 토큰 + `!==` 비교 |
| 호출자 신원 | — | ⚠️ MCP 의 `callerAgentId` 가 **쿼리스트링 자기신고** | 없음 |
| 원격 경로 | 없음 | ✅ **릴레이 E2E**(Curve25519 + XSalsa20-Poly1305) | 릴레이 데몬 |

**판정: Paseo 의 인가 모델도 통째로는 가져오면 안 된다. 우리 불변식이 더 강하다.**
다만 Orca 와 달리 **훔칠 조각이 넷** 있다(§6).

---

## 2. `docs/permissions.md` — 누가 무엇을 승인하나

문서는 59줄이고 **에이전트 승인 문서가 아니라 "누가 데몬에 말을 걸 수 있나" 문서**다. 그 점을 먼저 못 박아야 §6 비교가 어긋나지 않는다.

**모델** (`docs/permissions.md:8-16`): `principal`(지속 신원) ← `credential`(기기/서비스가 그 신원을 대리한다는 증명) ← `session`(같거나 더 좁은 권한). `pairing invitation` 은 *"an expiring, single-use exchange"* 로 규정된다.

**권한 9종** (`docs/permissions.md:20-30`): `daemon.read` / `daemon.manage` / `tunnel.manage` / `access.manage` / `workspace.read` / `workspace.write` / `workspace.manage` / `automation.manage` / `hub.execute`.

**핵심 문장 세 개 — 저쪽이 스스로 적은 한계다:**

- `docs/permissions.md:32`
  > *"Agents and terminals use workspace authority. Both can execute code and mutate the workspace, so separate write permissions would claim an isolation boundary the daemon cannot enforce."*
  → **에이전트와 터미널을 같은 권한으로 묶는다고 명시.** 즉 이 층에는 "이 도구를 써도 됩니까" 게이트가 **설계상 없다.**
- `docs/permissions.md:36`
  > *"Permissions are additive allows. Missing authority denies the operation. Do not add deny precedence."*
  → fail-closed. 이건 좋다.
- `docs/permissions.md:51`
  > *"File preview currently accepts any daemon-readable regular file, so it must gain resource enforcement before workspace-specific access ships."*
  → 워크스페이스 경계가 **아직 경계가 아니다**라고 저쪽이 먼저 적었다.

### 문서와 코드의 간극 (재서 확인한 것)

| 문서가 말하는 것 | 코드 v0.7.0 |
|---|---|
| `permissions.md:34` *"Owner, operator, and viewer are UI presets"* | 🔴 **`operator`/`viewer` 프리셋은 코드에 없다.** `packages/{server,protocol,app}/src` 전수 grep → 0건. 존재하는 건 `OWNER_PERMISSIONS = DAEMON_PERMISSIONS`(전부) 하나 (`authorization/index.ts:22`) |
| `permissions.md:16` 페어링은 *"expiring, single-use"* | 🔴 `pairing-offer.ts:41-46` 이 만드는 오퍼는 `serverId` + 데몬 공개키 + 릴레이 엔드포인트뿐. **만료도 1회성도 credential 도 없다.** |
| `permissions.md:49` *"A session may attenuate its principal's grants"* | 세션 축소 API 없음. `setPermissions()` 는 교체만 (`session.ts:1911`) |

→ **`permissions.md` 는 목표 설계서이지 v0.7.0 의 서술이 아니다.** 이 문서만 읽고 "Paseo 는 권한 모델이 있다"고 적으면 틀린다.

### 자동 승인 / 동의 우회 — **있다. Orca 보다 크다.**

Orca 의 `agent-trust-presets.ts` 는 *"유일한 문서화된 우회"* 라고 자기 주석에 적었다. Paseo 는 **우회를 제품 기능으로 노출한다:**

1. **`bypassPermissions` 가 UI 모드다** — `providers/claude/agent.ts:338-342`
   ```ts
   {
     id: "bypassPermissions",
     label: "Bypass",
     description: "Skip all permission prompts (use with caution)",
   },
   ```
2. **그 모드를 항상 켤 수 있게 런처에 못을 박는다** — `providers/claude/agent.ts:3270-3273`
   ```ts
   // Dynamic mode switching can recreate the underlying Claude query. Keep the
   // bypass launch capability available so later setPermissionMode("bypassPermissions")
   // calls do not fail after a model/thinking/rewind-driven restart.
   allowDangerouslySkipPermissions: true,
   ```
   → 사용자가 Bypass 를 고르지 않아도 **모든 Claude 세션이 bypass 가능 상태로 뜬다.**
3. **다른 프로바이더도 같다** — `providers/omp/provider-config.ts:44` 는 `"full"` 모드를 `["--approval-mode", "yolo"]` 로 번역한다. `providers/acp-agent.ts:2232-2244` 는 `canAutoAccept` 면 프롬프트 없이 `allow` 를 고르고 `"Auto-accepting ACP permission request"` 를 로그만 남긴다. OpenCode 도 같은 auto-accept 축(`opencode-agent.ts:233`).
4. **CLI 의 기본이 전건 승인** — `cli/src/commands/permit/allow.ts:108-111`
   ```ts
   if (!reqId || options.all) {
     // Default: allow all pending permissions if no req_id specified
     permissionsToAllow = pendingPermissions;
   }
   ```
   `paseo permit allow <agent>` 에 요청 id 를 안 주면 **대기 중인 승인 전부**가 통과한다(`:51` 주석: *"No validation needed"*).

---

## 3. 에이전트가 자유 문자열 명령을 실행할 수 있나 — **예. 경로 셋.**

### 경로 ① (직행) `send_terminal_keys` — `paseo-tools.ts:2476-2509`

```ts
registerTool(
  "send_terminal_keys",
  { title: "Send terminal keys",
    description: "Send literal text or special key tokens to a terminal session.",
    inputSchema: { terminalId: z.string(), keys: z.string(), literal: z.boolean().optional() },
    …
  async ({ terminalId, keys, literal = false }) => {
    const terminal = terminalManager.getTerminal(terminalId);   // ← 소유권 검사 없음
    terminal.send({ type: "input", data: resolveTerminalKeyToken(keys, literal) });
```

`keys` 는 `z.string()` 이고 그대로 PTY stdin 으로 간다. **셸이 붙은 터미널에 `"npm i evil\r"` 을 보내면 그게 실행이다.**

**그리고 cwd 샌드박스를 우회할 수 있다 — 세 단계로 검증했다:**

1. `list_terminals({ all: true })` → `paseo-tools.ts:2335-2344` 의 `all` 분기는 **`resolveScopedCwd` 를 아예 타지 않고** `terminalManager.listDirectories()` 를 돌며 **데몬의 모든 터미널 id 를 반환**한다.
2. `send_terminal_keys(그 id, …)` → `:2493` 소유권/워크스페이스 검사 없음.
3. `capture_terminal(그 id)` → `:2455` 역시 `terminalId` 만 받고 검사 없음 → 남의 터미널 출력을 읽는다.

즉 `resolveScopedCwd`(`paseo-tools.ts:649-668`)가 거는 cwd 잠금(`lockedCwd`/`allowCustomCwd`)은 **cwd 를 인자로 받는 도구에만** 걸린다. 터미널 id 를 받는 도구는 그 밖에 있다. (저쪽도 `SECURITY.md:51` 에서 *"Workspace-relative paths remain a UI convenience, not a security boundary"* 라고 인정한다.)

### 경로 ② (우회) `start_workspace_script` — 카탈로그처럼 생겼지만 카탈로그가 아니다

`paseo-tools.ts:2261-2286` 은 `scriptName` 만 받는다. 겉보기엔 우리 `{id, args}` 와 같은 모양이다. **그런데 그 이름이 가리키는 값이 파일 안의 셸 문자열이다** — `paseo.json:11-31`:

```json
"scripts": { "typecheck": { "command": "npm run typecheck" },
             "daemon":    { "command": "PASEO_DEV_MANAGED_HOME=1 … ./scripts/dev-daemon.sh" } }
```

에이전트는 워크스페이스 파일을 쓸 수 있다(`fs.file.write.request` = `workspace.write`, 그리고 애초에 코딩 에이전트다). **`paseo.json` 을 고친 뒤 이름으로 부르면 임의 셸이다.** 카탈로그의 값이 에이전트가 쓸 수 있는 파일에 있으면 카탈로그가 아니다 — 우리 설계에 그대로 적용되는 교훈이다.

### 경로 ③ (수동적) worktree 셋업 — 클론만 해도 돈다

`utils/worktree.ts:634-672` `runWorktreeSetupCommands()`:

```ts
// Read paseo.json from the worktree (it will have the same content as the source repo)
const setupCommands = getWorktreeSetupCommands(options.worktreePath);   // :643-644
…
for (const [index, cmd] of setupCommands.entries()) { … await execSetupCommand(cmd, …) }
```

워크트리를 만들 때 **그 저장소의 `paseo.json`** 에 적힌 명령들을 순서대로 셸 실행한다. 확인창도 허용목록도 없다. 저쪽 자기 `paseo.json:3-9` 의 `worktree.setup` 이 `npm ci` 등 5개를 돌린다. → **에이전트가 남의 저장소를 클론해 워크스페이스를 만들면 그 저장소가 코드를 실행한다.**

### 반대로 — Paseo 가 **잘한** 자리 (Orca 보다 나음)

- **`create_terminal` 은 명령을 안 받는다** (`paseo-tools.ts:2362-2398`): `cwd`, `name` 뿐. Orca 의 `terminal create --command "<문자열>"` 같은 구멍이 **없다.**
- **`eval`/`computer` 류 도구가 없다.** 40개 목록 전수 확인.
- **Hub 의 도구 선승인은 진짜 `{server, tool}` 카탈로그다** — `protocol/src/agent-types.ts:480-482`
  ```ts
  export interface ToolPolicy { preapproved: McpToolRef[]; }   // McpToolRef = {kind:"mcp", server, tool}
  ```
  글롭도 명령 문자열도 없다. 게다가 `hub/daemon-executions.ts:351-355` 가 **`"paseo"` 서버 이름을 예약**해 Hub 가 데몬 자기 도구를 선승인하지 못하게 막고, `:357-369` 는 같은 요청에 선언되지 않은 서버의 선승인을 거부한다.
  → **원격 서비스 주체(Hub)에는 우리 불변식과 같은 규율을 걸어 놓고, 로컬 에이전트에는 아무것도 안 걸었다.** 이 비대칭이 이 코드베이스의 핵심 성격이다.

### 🔴 가장 큰 것 — 에이전트가 동의 자체를 처리한다

`paseo-tools.ts:3068-3089` **`set_agent_mode`**:
```ts
title: "Set agent session mode",
description: "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.).",
inputSchema: { agentId: z.string(), modeId: z.string() },
```
`paseo-tools.ts:3126-3151` **`respond_to_permission`**:
```ts
description: "Approve or deny a pending permission request with an AgentManager-compatible response payload.",
inputSchema: { agentId: z.string(), requestId: z.string(), response: AgentPermissionResponseSchema },
```
구현(`agent/permission-response.ts:22-39`)에 **호출자 검사가 없다.** `agentId` 가 자기 자신인지, 호출자가 사람인지 에이전트인지 **아무 데서도 안 본다.**

그리고 이 도구들은 **모든 에이전트에게 기본으로 주입된다**: `paseo-tools.ts:1159`(`speak` 는 음성 옵션 게이트), `:1202`(브라우저 도구는 설정 게이트) 두 곳 말고는 조건부 등록이 없고, `bootstrap.ts:1400-1401` 가 `config.mcpInjectIntoAgents !== false` / `mcpEnabled ?? true` → **기본 켜짐**.

**따라서 에이전트는 (a) 자기 자신을 `bypassPermissions` 로 바꾸고 (b) 자기 앞에 뜬 승인 요청을 스스로 `allow` 할 수 있다.** Orca 의 `agent-trust-presets.ts` 는 "신뢰 폴더 표식을 미리 써 두는" 수준이었다. 여기는 **동의 루프 자체가 에이전트의 도구 표면에 올라와 있다.** §6 의 판정 *"우리 것이 더 강하다"* 는 Paseo 에 대해 **더 강하게** 성립한다.

---

## 4. 인증 · 전송로

| 항목 | 사실 | 위치 |
|---|---|---|
| 기본 바인드 | `127.0.0.1` | `bootstrap.ts:65,77` / `SECURITY.md:47` |
| 유닉스 소켓 | 지원(`listenTarget` 유니온에 소켓 있음). 다만 **경계를 소켓 퍼미션에 걸지 않는다** | `bootstrap.ts:61-77` |
| 기본 인증 | 🔴 **없음.** 비밀번호 미설정이면 도달 가능한 것이 곧 권한 | `auth.ts:38-39`, `:96`, `:148-150` |
| 비밀번호 저장 | **bcrypt cost 12** (평문 아님 — Orca 대비 우위) | `auth.ts:5,48-50` |
| 비밀번호 비교 | `bcryptjs.compare` (비동기) / `compareSync` | `auth.ts:34,45` |
| MCP 능력토큰 비교 | ✅ **상수시간** | `auth.ts:153-158` |
| 호출자 신원 | ⚠️ **자기신고**. MCP 의 `callerAgentId` 는 쿼리스트링 | `bootstrap.ts:1483-1488` |
| 릴레이 소켓 인증 | 🔴 **데몬 비밀번호를 안 탄다** | 아래 |

### 상수시간 비교 — 원문 (`auth.ts:151-159`)

```ts
const token = extractHttpBearerToken(input.authorizationHeader);
if (input.capabilityToken !== null && token !== null) {
  // Constant-time compare; length-guard first because timingSafeEqual throws
  // on differing buffer lengths.
  const provided = Buffer.from(token);
  const expected = Buffer.from(input.capabilityToken);
  if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
```

**Orca 의 `!==` 와 정확히 대비되는 자리다. 여기는 제대로 했다.** (길이는 새지만 이건 표준 관행이고 문제 아님.)

### 그러나 — 무인증이 기본 (`auth.ts:143-150`)

```ts
export async function isAgentMcpRequestAuthorized(input: {…}): Promise<boolean> {
  if (!input.password) {
    return true;      // ← 비밀번호 미설정 = /mcp/agents 완전 개방
  }
```
같은 패턴이 전역 미들웨어에도 있다(`auth.ts:96`: `if (!password || shouldBypassBearerAuth(…)) { next(); return; }`).
`/mcp/agents` 와 `/api/files/download` 는 전역 미들웨어에서 **제외**되고 각자 인증한다(`auth.ts:122` `SELF_AUTHENTICATING_ROUTES`) — 주석(`bootstrap.ts:1441-1445`)이 *"Without this, a password-protected daemon would be wide open on its agent control plane"* 라고 적어 둔 걸 보면 **한 번 그 사고가 났던 자리**로 보인다.

저쪽의 자기 서술 (`SECURITY.md:47`):
> *"By default, the daemon binds to `127.0.0.1`. With no password configured, the local control plane is trusted by network reachability — anything that can reach the daemon socket can control the daemon. This is the same security model Docker documents for its daemon."*

**정직하지만 우리 입장과 다르다.** 우리는 "같은 OS 사용자면 다 된다"를 경계로 인정하지 않기로 §6 에서 결론냈다.

### 🔴 실효 권한 — 릴레이로 붙으면 **owner** 다 (이 보고서에서 가장 실질적인 발견)

권한표는 훌륭하게 강제된다:
- `session.ts:1856-1869` — inbound 단일 초크포인트, 불허 시 `code: "access_denied"` 로 끝
- `session.ts:7538-7541` — outbound 도 `emit()` 에서 걸러 정보 유출 차단
- `session.ts:2666-2668` — 바이너리 프레임은 `workspace.write` 필요
- `authorization/index.ts:51-53` — `permission === null || has(permission)` → 매핑 없으면 거부(fail-closed)

**그런데 그 표에 넣을 권한이 어디서 오는가:**

```ts
// websocket-server.ts:500-503
const OWNER_SESSION_ADMISSION: SessionAdmission = {
  principalId: "owner",
  permissions: OWNER_PERMISSIONS,          // = DAEMON_PERMISSIONS, 9종 전부
};
```
그리고 `attachExternalSocket(…, admission: SessionAdmission = OWNER_SESSION_ADMISSION, …)` (`:965`), `attachSocket(…, admission = OWNER_SESSION_ADMISSION, …)` (`:1240`) — **기본 인자가 owner** 다.

`attachExternalSocket` 호출자는 저장소에 **둘뿐**이다:
- `bootstrap.ts:1209-1214` (**Hub**): `{ principalId: options.principalId, permissions: options.permissions, … }` 를 **명시적으로 넘긴다** → 진짜 좁혀진다
- `bootstrap.ts:1697` (**릴레이**): `await wsServer.attachExternalSocket(ws, metadata);` — **admission 인자 없음** → **owner**

→ **v0.7.0 에서 권한 시스템이 실제로 무언가를 좁히는 상대는 Hub 서비스 주체뿐이다.** 릴레이로 들어온 폰도, 로컬 CLI 도 전부 owner. 9종 권한·전 RPC 매핑표·fail-closed 초크포인트는 **Hub 를 위해 지어졌고 아직 Hub 에만 쓰인다.**

또 릴레이 경로는 HTTP 업그레이드를 안 거치므로 **데몬 비밀번호도 안 탄다.** 확인 방법(부재 주장이라 **양성 대조**를 같이 돌렸다):

```
POSITIVE CONTROL  grep -c "password|bearer|Bearer|auth"
  auth.ts        : 39
  bootstrap.ts   : 23
TARGET
  relay-runtime.ts   : 0
  relay-transport.ts : 0
```
같은 패턴이 인증하는 파일에서는 잡히고 릴레이 두 파일에서는 0 → **패턴이 안 듣는 게 아니라 정말 없다.**

---

## 5. `packages/relay` — E2E 페어링 (15파일 · 3,335줄, 이 중 핵심은 `crypto.ts` 181줄)

### 무엇을 어떻게 암호화하나

- **키 교환** Curve25519(`nacl.box.before`), **암호** XSalsa20-Poly1305(NaCl `box`)
- **번들 형식** `[nonce 24B][ciphertext]` (`crypto.ts:8-9,156-165`)
- 데몬은 첫 실행 때 영구 Curve25519 키쌍을 `$PASEO_HOME/daemon-keypair.json` 에 `0600` 으로 저장(`SECURITY.md:22`)
- 페어링 URL 이 데몬 **공개키를 URL 프래그먼트**에 담는다 → `app.paseo.sh` 서버는 키를 못 본다(`SECURITY.md:23`) — **영리하다**
- 클라이언트는 접속마다 **임시(ephemeral) 키쌍**을 만들어 `e2ee_hello` 로 공개키를 보낸다(`encrypted-channel.ts:154-172`)

### 페어링의 실제 내용물 (`pairing-offer.ts:41-46`)

```ts
const offer = await createConnectionOfferV2({
  serverId,
  daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
  relay: { endpoint: relayPublicEndpoint, useTls: relayPublicUseTls },
});
```
**만료 없음 · 1회성 아님 · credential 없음 · 권한 선택 없음.** `permissions.md:16` 이 약속한 것과 다르다(§2 표 참조). QR 한 장이 곧 영구 owner 접근이다.

### 인증 방향 — 한쪽만이다

`createDaemonChannel`(`encrypted-channel.ts:216-260`)은 들어온 `e2ee_hello` 의 **아무 공개키로나** 공유키를 유도한다. 클라이언트 신원 확인 절차가 없다.
→ **E2E 는 릴레이에 대한 기밀성·무결성을 준다. 클라이언트 인증은 주지 않는다.** 인증은 안쪽(데몬 비밀번호 / Hub credential)에 있어야 하는데, 릴레이 경로는 그 비밀번호를 안 탄다(§4) → **릴레이 세션 id 에 도달하면 owner.** 데몬 공개키를 아는 것이 사실상 유일한 관문이다.
저쪽도 `SECURITY.md:43` 에서 *"The QR code or pairing link is the trust anchor … Treat it like a password"* 라고 적었다 — **비밀번호처럼 다루라면서 만료도 폐기도 없다**는 것이 이 설계의 약한 고리다.

### 그래도 `crypto.ts` 는 **가져올 값이 있다** (181줄, 의존성 `tweetnacl` + `base64-js` 둘)

우리에게 없는 조각이고 작다. 그리고 **흔히 빼먹는 검사를 세 개나 한다**:

1. **전부-0 공유비밀 거부(소그룹 공격 차단)** — `crypto.ts:142-147`
   ```ts
   const rawSharedResult = nacl.scalarMult(ourSecretKey, peerPublicKey);
   const isAllZero = nacl.verify(rawSharedResult, ZERO_X25519_SHARED_RESULT);
   rawSharedResult.fill(0);
   if (isAllZero) { throw new Error("Invalid peer public key"); }
   ```
   대부분의 구현이 건너뛰는 자리다.
2. **base64 정규형 검사** — `crypto.ts:72-86`: 정규식 통과 + `encodeBase64(decode(x)) === x` 왕복 확인 → 같은 키의 여러 표현을 막는다.
3. **PRNG 없으면 조용히 약해지지 않고 throw** — `crypto.ts:39-62` (`"No secure PRNG available for tweetnacl"`).

**판정: `packages/relay/src/crypto.ts` 는 이식 가치가 있다(Apache-2.0, 고지만 지키면 됨).** 반면 `encrypted-channel.ts`(579줄, 재핸드셰이크·백프레셔·바이너리 협상)와 `cloudflare-adapter.ts`(614줄, Cloudflare Durable Objects 전용)는 **우리 요구(로컬 데몬)에는 과하다.** 우리는 릴레이 서버를 안 돌린다.

### 저쪽이 인정한 남은 구멍 (`SECURITY.md:39`)

> *"**Replay old messages across sessions** — … Within a live session, replay protection is not yet implemented; the protocol uses random nonces and does not track nonce reuse or message counters."*

세션 내 재전송 방어가 없다. 가져올 때 우리가 채워야 할 자리.

---

## 6. 훔칠 것 — 넷 (전부 우리 불변식을 약화하지 않는다)

1. **RPC↔권한 매핑을 컴파일러가 강제하게 한다** — `operation-permissions.ts:201`·`:412`
   ```ts
   } as const satisfies Record<InboundOperation, DaemonPermission | null>;
   ```
   **새 RPC 를 추가하면 권한을 안 적을 수가 없다.** 게다가 테스트가 Zod 스키마에서 타입 목록을 뽑아 대조한다(`authorization/index.test.ts:16-22`):
   ```ts
   return SessionInboundMessageSchema.options.map((option) => option.shape.type.value);
   ```
   → §6 의 *"카탈로그가 자기를 뱉게 하면 문서 드리프트가 영구히 사라진다"* 를 **테스트로 못 박은 형태.** 우리 MCP 카탈로그에 그대로 적용 가능하고, 값이 크다.
2. **아웃바운드도 거른다** — `session.ts:7538-7541`. 인바운드만 막으면 정보는 새어 나간다. 우리 이벤트 전송에 같은 필터가 있는지 확인할 것.
3. **`ToolPolicy.preapproved` 형태** — `{kind:"mcp", server, tool}` 배열 + **예약 네임스페이스**(`hub/daemon-executions.ts:351-355`). 우리가 나중에 "이 도구는 매번 안 물어봄"을 만들 때 **명령 문자열이 아니라 이 모양**으로 만들어야 한다.
4. **`crypto.ts` 의 세 가지 검사** (§5) — 우리가 언젠가 원격을 하면.

### 훔치면 안 되는 것

- 권한 **기본값이 owner** 인 admission 구조 (`websocket-server.ts:965,1240`)
- 에이전트 도구 표면에 **동의 처리 도구**(`set_agent_mode`/`respond_to_permission`)를 올리는 것
- `send_terminal_keys` 형태의 **id 만 받고 소유권 안 보는** 도구
- 카탈로그의 **값을 에이전트가 쓸 수 있는 파일**(`paseo.json`)에 두는 것

---

## 7. `SECURITY.md` 위협 모델 — 요약과 인상

91줄. **문체가 정직하다.** 못 막는 것을 먼저 적는다.

- **아키텍처 비유**: Docker 데몬 (`:3`, `:47`). 경계 = 소켓/리슨 주소 도달성.
- **릴레이는 신뢰 안 함**(`:16-18`): 릴레이가 보는 것은 *"IP addresses, timing, message sizes, session IDs, and the plaintext `e2ee_hello`/`e2ee_ready` handshake frames"* 뿐이라고 명시(`:29`).
- **HTML 미리보기**(`:69-79`): opaque origin + 강한 CSP. 그런데 남은 구멍을 **스스로** 적는다 — *"a sandboxed document may navigate itself, and no CSP directive in current browsers prevents that. `navigate-to` was dropped from CSP Level 3"*(`:75`), 그리고 안드로이드 WebView 는 결정이 늦으면 **허용 쪽으로 폴백**한다(`:77`). 우리가 파일 미리보기를 붙일 때 그대로 읽을 값이 있다.
- **DNS 리바인딩**(`:63-67`): Vite 방식 Host 허용목록, 기본 `localhost`/`*.localhost`/리터럴 IP. `PASEO_HOSTNAMES=true` 면 **허용목록 전체 해제**(위험한 탈출구).
- **에이전트 인증**(`:81-83`): *"Paseo never stores or transmits provider API keys. Agents run in your user context with your existing credentials."* — 우리와 같은 입장.
- **취약점 신고**: `hello@moboudra.com` 비공개 (`:91`).

**단, `SECURITY.md` 는 §3 의 에이전트 자기승인 경로를 한 줄도 다루지 않는다.** 위협 모델이 "클라이언트↔데몬" 축만 보고 "에이전트↔데몬" 축을 안 본다. 이것이 이 제품의 사각지대다.

---

## 8. 못 본 자리 (다음 라운드용)

읽지 않았거나 겉만 본 곳을 정직하게 적는다.

1. **`packages/app` (2,212 파일)** — 전혀 안 봄. UI 쪽에 승인 확인창이 실제로 어떻게 뜨는지, `bypassPermissions` 전환에 사용자 확인이 붙는지 **UI 레벨에서 확인 못 했다.** (서버 쪽엔 없다는 것만 확인)
2. **`packages/plugin` (16파일) 과 플러그인 런타임** — `plugin.*` RPC 는 전부 `daemon.manage` 로 묶여 있는 것까지만 봤다. 플러그인이 데몬 프로세스 안에서 임의 코드를 도는지, `plugin.rpc.invoke.request` 로 무엇이 되는지 안 봄.
3. **`packages/desktop` 의 browser-automation** — `browser.automation.execute.*` RPC 와 `registerBrowserTools`(설정 게이트) 가 있다. **Orca 의 `eval` 에 대응하는 자리일 가능성**이 높은데 안 열었다.
4. **`skills/`** — 지시서 범위 밖이라 안 봄(에이전트가 에이전트를 부리는 기능, A 담당 추정).
5. **`packages/server/src/server/hub/`** 전체 — 원격 Hub 가 무엇을 시킬 수 있는지 `daemon-executions.ts` 일부만 봤다.
6. **`file-download` 토큰**(`/api/files/download` 도 self-authenticating 경로) — 토큰 발급/검증 안 봄.
7. **`patches/` 디렉터리** — 제3자 패키지 패치. Apache 4(b) "변경 표시" 관점에서 우리가 그 패치를 같이 가져갈 일이 생기면 봐야 함.
8. **`package-lock.json` 의 의존성 라이선스 전수** — 1.5MB. **직접 의존성의 라이선스는 검사하지 않았다.** 우리가 `crypto.ts` 만 가져오면 `tweetnacl`(공용도메인/Unlicense 계열) + `base64-js`(MIT) 둘만 확인하면 되지만, **그 둘도 이번엔 안 쟀다.**
9. **테스트 실행 안 함** — 지시대로 빌드·실행 전혀 안 했다. 권한 테스트가 실제로 통과하는지는 **코드만 읽고 판단**한 것이다.

---

## 9. 한 문단 결론

라이선스는 **Apache-2.0 이 맞고 바이트로 확인했다** — 가져와도 된다(고지·변경표시만). 인가 모델은 **가져오면 안 된다**: Paseo 는 훌륭한 권한 *기계장치*(9종 의미 권한 · 전 RPC 컴파일타임 매핑 · fail-closed 초크포인트 · 상수시간 토큰 비교)를 지어 놓고, 그 기계에 **Hub 만 연결했다.** 로컬·릴레이 세션은 전부 owner 이고(`bootstrap.ts:1697`), 에이전트에게는 **자유 문자열 PTY 입력**(`paseo-tools.ts:2476-2509`)과 **자기 승인 프롬프트를 스스로 통과시킬 도구**(`:3068`, `:3126`)를 기본으로 쥐어 준다. §6 의 *"우리 것이 더 강하다"* 는 Orca 보다 Paseo 에 대해 **더 크게** 성립한다. 훔칠 것은 넷: **`satisfies Record` 로 매핑 누락을 컴파일러에 맡기는 법**, **아웃바운드도 거르는 것**, **`{server, tool}` 선승인 형태 + 예약 네임스페이스**, 그리고 **`crypto.ts` 181줄**.
