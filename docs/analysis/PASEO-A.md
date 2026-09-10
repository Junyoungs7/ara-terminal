# Paseo 분석 A — 데몬·서버 (완료 보고)

대상: `D:\paseo` v0.7.0 (`package.json`), Apache-2.0. **읽기만 했고 아무것도 빌드·실행하지 않았다.**
`D:\AI\OFA` 는 이 파일 하나만 새로 썼고 소스는 한 줄도 안 건드렸다.

인용은 전부 `파일:줄`. **저쪽 문서의 수치는 "저쪽 주장"이라고 표시했다** — 우리가 잰 게 아니다.

---

## 0. 한 줄 요약 — F24~F27 의 전제가 하나 틀렸다

우리 로드맵 P8 은 *"데몬이 있으면 앱이 죽어도 터미널이 산다"* 를 전제로 짜여 있다.
**Paseo 의 기본값은 그 반대다.**

- 데스크톱 설정 `daemon.keepRunningAfterQuit` 의 **기본값이 `false`**
  (`packages/desktop/src/settings/desktop-settings.ts:39`).
- `docs/architecture.md:426` — *"Electron app spawns daemon as subprocess, **and stops it again on
  quit so that 'restart the app' is a complete reset**"*.
- 즉 저쪽도 기본 상태에서는 **앱을 끄면 터미널이 다 죽는다.** 살리는 건 설정에서 켜는 옵트인이다.

그리고 저쪽 터미널은 **디스크에 아무것도 안 남긴다**:

> `docs/data-model.md:171` — *"Terminals are live daemon state, **not persisted JSON records**."*

`$PASEO_HOME` 레이아웃(`docs/data-model.md:45-70`)에 터미널 항목이 아예 없다.
`output.log` 도 `checkpoint.json` 도 없다. 저장소 전체 grep 에서 터미널 출력을 파일로 쓰는 자리가 0건.

→ **F26(기록 프레이밍 + 체크포인트)의 완성품은 저쪽에 없다.** 저쪽은 그 문제를 "데몬이 오래 살고
화면 모델은 RAM 에만 둔다"로 회피했다. F26 을 하려면 우리가 설계해야 한다 — 참고할 코드가 없다.

**그래서 P8 의 실제 이득은 "크래시 생존"이 아니라 "재부착"이다.** 아래 §2 가 그 자리다.

---

## 1. 데몬이 무엇을 소유하나 · 무엇이 살아남나

### 프로세스 3층

```
[Paseo Supervisor]        packages/server/scripts/supervisor-entrypoint.ts:17
   │  pid lock 보유 · 크래시 재시작 · 1초 하트비트
   │
   ├─ [Paseo Daemon]      packages/server/src/server/daemon-worker.ts:10
   │     │  HTTP+WS · AgentManager · 에이전트 프로바이더 프로세스 소유
   │     │
   │     └─ [terminal worker]  packages/server/src/terminal/terminal-worker-process.ts
   │            node-pty + @xterm/headless  ←── PTY 는 **여기** 산다
   │
   └─ (재시작 시 daemon 만 갈아끼운다)
```

`createConfiguredTerminalManager()` 는 항상 워커 매니저를 만든다
(`packages/server/src/terminal/terminal-manager-factory.ts:8-12`) — 인프로세스 경로는 남아 있지만
제품 경로가 아니다. 워커는 `fork(..., { serialization: "advanced", stdio: [ignore,ignore,inherit,ipc] })`
로 뜬다 (`worker-terminal-manager.ts:142-148`).

### 워커를 따로 뺀 이유는 생존이 아니다

`terminal-worker-process.ts:26-37` 주석이 직접 말한다:

> *"node-pty completes its Windows conpty spawn asynchronously on a separate conout worker thread.
> When that spawn fails … it throws an exception there that cannot be caught at the call site and
> **would otherwise crash this worker process and sever every existing terminal**."*

그래서 워커에 `process.on("uncaughtException")` 를 걸어 **살려 둔다**(`:34-37`). 이유 둘:
1. **conpty 스폰 실패로부터 데몬 메인을 격리** (우리도 Windows 라 그대로 해당한다)
2. **xterm-headless 파싱 CPU 를 데몬 이벤트루프에서 뺀다** (`docs/terminal-performance.md` 파이프라인)

**생존은 워커의 목적이 아니다** — 오히려 반대다:

```ts
// terminal-worker-process.ts:347-350
process.once("disconnect", () => {
  ipcClosing = true;
  manager.killAll();
});
```

데몬과의 IPC 가 끊기면 **워커가 스스로 모든 PTY 를 죽인다.** 그리고 워커가 죽으면 **재스폰도 없다** —
`worker.on("exit")` 는 대기 요청만 reject 하고 끝난다(`worker-terminal-manager.ts:609-616`).
그 뒤 모든 요청은 `"Terminal worker is not running"` 으로 실패한다(`:619-621`).

### 에이전트는 어떻게 사나 — 프로세스가 아니라 **재개**로

`docs/agent-lifecycle.md:26` — *"Runtime closure happens only through an explicit lifecycle action
such as archive, replacement, reload, workspace teardown, **or daemon shutdown**."*

데몬이 내려가면 프로바이더 프로세스도 죽는다. 대신 에이전트 **레코드**가 남고
(`$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json`), 다시 열 때 프로바이더 자체의 durable
세션에서 재개한다 — Claude 는 `~/.claude/projects/{cwd}/{session-id}.jsonl`, Codex 는
`~/.codex/sessions/…/rollout-*.jsonl` (`docs/architecture.md:378-380`).
e2e 가 정확히 이걸 잰다: `packages/server/src/server/daemon-e2e/daemon-restart-resume.e2e.test.ts:24`
*"Codex agent survives daemon restart with persistence handle"* — 데몬을 죽였다 살리고
`resumeAgent(handle)` 로 되살린다.

`docs/hub.md:44-48` 이 한계를 명시한다: *"Daemon restart preserves the Hub relationship … **but
interrupts any active turn**. The daemon persists that agent as `closed`."*

### 정리표

| 무엇 | 앱(Electron) 재시작 | 데몬 재시작/크래시 | 슈퍼바이저 죽음 |
|---|---|---|---|
| PTY(터미널) | **산다** (단, `keepRunningAfterQuit=true` 일 때만) | **죽는다** (워커가 스스로 killAll) | 죽는다 |
| 터미널 화면 내용 | 데몬 RAM 에서 복원 | **전부 소실** (디스크 기록 없음) | 소실 |
| 에이전트 프로세스 | 산다(위와 같은 조건) | 죽는다 | 죽는다 |
| 에이전트 대화 | 산다 (프로바이더 jsonl 재개) | 산다 (재개) | 산다 |

**우리 현재와의 차이**: 우리는 node-pty 가 Electron 메인의 자식이라
(`src/main/sessions/PtyBackend.ts:3`) 앱 창 재생성/렌더러 리로드는 이미 견디지만
(`MainSessionManager.attach()` 링버퍼 재생, `src/main/sessions/MainSessionManager.ts:186-193`),
**메인 프로세스가 죽으면 같이 죽는다.** Paseo 를 그대로 번역하면 우리가 얻는 것은
**"Electron 메인 크래시/재시작을 넘는 생존"** 하나이고, **"데몬 크래시를 넘는 생존"은 저쪽에도 없다.**

---

## 2. 재부착 — 화면을 어떻게 되돌리나 🔴 여기가 가장 값진 자리

### `@xterm/headless` 는 맞다. `addon-serialize` 는 **아니다**

`packages/server/package.json:96` 에 `"@xterm/headless": "^6.0.0"` 이 있고
`packages/server/src/terminal/terminal.ts:2` 에서 임포트한다.
**`addon-serialize` 는 의존성에 없다.** 저쪽은 xterm 버퍼를 **직접 읽어 셀 격자 JSON** 을 만든다:

```ts
// terminal.ts:1237-1256  getState()
{ rows, cols,
  grid: extractGrid(terminal),                 // 보이는 화면
  scrollback: extractScrollback(terminal, {scrollbackLines}),
  cursor: extractCursorState(terminal),
  gridWrapped / scrollbackWrapped }            // 소프트랩 플래그 (클라 capability gate)
```

헤드리스 터미널은 `new Terminal({ rows, cols, scrollback: 1000, allowProposedApi: true })`
(`terminal.ts:931-936`) — **스크롤백 1000줄이 화면 모델의 상한**이다.

### 되돌리는 방법: 셀 격자 → ANSI → 클라에서 RIS 후 write

1. 데몬이 셀 격자를 **정규화된 ANSI 문자열로 렌더**한다 —
   `packages/protocol/src/terminal-snapshot.ts:29` `renderTerminalSnapshotToAnsi()`.
   스타일이 바뀔 때만 SGR 을 내고(`:91-94`), 소프트랩 행은 폭까지 패딩해서 xterm 이
   "wrapped" 로 표시하게 만든다(`:40-49` 주석: 그래야 리사이즈 때 리플로우된다).
2. `Restore(0x05)` 바이너리 프레임으로 보낸다 —
   `packages/server/src/terminal/terminal-restore.ts:66-75`.
3. 클라는 **`ESC c`(RIS, 전체 리셋)를 앞에 붙여** 쓴다 —
   `packages/app/src/terminal/runtime/terminal-emulator-runtime.ts:143` (`0x1b, 0x63`) 와
   `:657-672` `restoreOutput()`.

**찢긴 꼬리(F26)를 어떻게 처리하나 — 답: 그런 상황을 안 만든다.**
저쪽엔 append 로그가 없으므로 찢길 대상이 없다. 스냅샷은 살아 있는 메모리 모델에서 한 번에
만들어지는 원자적 값이고, 클라는 적용 전에 RIS 로 화면을 통째로 비운다.
대신 **라이브 스트림과 스냅샷 사이의 중복**이라는 다른 문제를 `revision` 하나로 푼다:

```ts
// terminal.ts:1163-1172
function writeOutputToHeadless(data: string): void {
  terminal.write(data, () => {              // ← xterm 이 실제로 적용한 뒤에
    stateRevision += 1;                     //    비로소 revision 을 올린다
    for (const l of listeners) l({ type: "output", data, revision: stateRevision });
  });
}
```

스냅샷은 자기 `revision` 을 달고 나가고(`terminal.ts:1258-1263`), 스냅샷 도중 버퍼링된 출력 중
`revision <= replayRevision` 인 것은 버린다
(`terminal-session-controller.ts:1046-1057` `replayTerminalOutputAfterSnapshot`).
**"스냅샷에 이미 반영된 바이트"의 정의를 에뮬레이터의 write 콜백에 위임한 것** — 이게 이 설계의 핵심이다.
`docs/terminal-performance.md` 도 이걸 깨지기 쉬운 불변식으로 명시한다:
*"Coalesced output carries the LAST chunk's revision … a merged batch with a lower revision would be
wrongly skipped (lost output)."*

### 재부착 모드 세 가지

`SubscribeTerminalRequestSchema.restore` (`packages/protocol/src/messages.ts:2862-2878`):

| 모드 | 무엇 | 어디서 쓰나 |
|---|---|---|
| `live` | 스냅샷 없이 스트림만 | 프로토콜엔 있으나 **앱은 안 쓴다**. 데몬이 백프레셔 때 `visible-snapshot` 으로 승격(`terminal-restore.ts:32-39`) |
| `visible-snapshot` | 화면 + 스크롤백 N줄 | **앱이 항상 쓰는 유일한 모드**. 기본 200줄, 상한 500줄 |
| `full-snapshot` | 전체 스크롤백 | 앱 미사용 |

앱 쪽 선택 로직은 23줄짜리 함수 하나다 —
`packages/app/src/terminal/runtime/terminal-restore-options.ts:11-23`: 항상
`{mode:"visible-snapshot", scrollbackLines:200}`. 상한 200/500 은 `terminal-restore.ts:19-20`.

옛 클라용 `Snapshot(0x04)` 는 셀 격자 JSON 을 그대로 보내는 레거시 경로로 남아 있다
(`terminal-restore.ts:55-64`). 신 클라는 `terminal-restore-modes` capability 로 갈린다
(`messages.ts:3408`).

### 재부착 시 입력 모드 복원 — 우리가 놓칠 자리

스냅샷은 **화면**만 복원한다. bracketed paste·application cursor keys·kitty keyboard·win32 input mode
같은 **DECSET 상태**는 별도로 복원한다:
`TerminalInputModeTracker` 가 PTY 출력에서 이 시퀀스를 추적해
(`packages/protocol/src/terminal-input-mode.ts:70-`) `getReplayPreamble()` 로 재생 서문을 내놓고
(`terminal.ts:1266-1268`), 스냅샷 직후 그 서문을 먼저 쓴다
(`terminal-session-controller.ts:1035-1039`).

이게 없으면 재부착 후 **붙여넣기와 방향키가 조용히 깨진다.** 화면만 복원하면 놓치는 자리다.

---

## 3. 전송로 — WebSocket. **ACK 는 없다.**

### 프레이밍

바이너리 프레임 헤더는 **2바이트**뿐이다 (`packages/protocol/src/binary-frames/terminal.ts:65-76`):

```
[0] opcode   Output 0x01 · Input 0x02 · Resize 0x03 · Snapshot 0x04 · Restore 0x05
[1] slot     터미널 슬롯 id (1바이트 → 세션당 최대 256, terminal-session-controller.ts:40)
[2..] payload  output/input=원시 바이트, resize/snapshot=JSON
```

길이 접두어가 없다 — WebSocket 이 이미 메시지 경계를 준다. 우리 F26 이 길이 접두어를 말한 건
**파일 append** 이야기라 여기와는 층이 다르다.

### 백프레셔 — 누적 ACK 가 아니라 `socket.bufferedAmount` 2단 게이트

저장소 전체에서 터미널 ACK 프로토콜을 찾지 못했다. 대신:

**1단 — 스냅샷 캐치업 (4 MiB, 소프트)**
```ts
// terminal-session-controller.ts:873-882
if (outputBytesSinceSnapshot > 256KB && (bufferedAmount === null || bufferedAmount > 4MB)) {
  → 스트리밍을 끊고 스냅샷 한 장으로 따라잡힌다
}
```
**AND 조건인 게 핵심이다.** 잘 빨아들이는 클라는 `bufferedAmount≈0` 이라 아무리 출력이 많아도
계속 스트리밍한다. `:851-857` 주석이 그 역사를 적어 뒀다 — 예전엔 256KB 마다 무조건 스냅샷으로
떨어져서 *"~200k objects across IPC"* 가 오갔고 그게 **spiky lag 과 GC hitch 의 원인**이었다.
릴레이처럼 백프레셔 신호가 없는 전송(`null`)에서만 바이트 임계로 무조건 떨어진다.

**2단 — 물리 소켓 하드 컷 (64 MiB)**
`packages/server/src/server/websocket/physical-socket.ts:1-4, 89-95`. 넘으면 프레임을 안 보내고
그 물리 소켓만 강제 종료한다(같은 논리 세션의 다른 소켓은 안 건드린다).

> ⚠️ `docs/architecture.md:243` 은 상한을 **8 MiB** 라고 적어 뒀는데 코드는 **64 MiB** 다
> (`physical-socket.ts:4`). **문서가 코드보다 낡았다.** 숫자를 인용할 땐 코드를 봐라.

**3단 — 애플리케이션 리스 (45초)**
클라가 10초마다 보내는 앱 레벨 `ping` 으로 리스를 갱신하고, 만료되면 소켓을 끊는다
(`physical-socket.ts:5-8, 12-44`). RFC6455 control ping 이 아니라 JSON 봉투다.

### 코얼레서 — 리딩 + 트레일링 5ms, **두 층에**

`TerminalOutputCoalescer` (`packages/server/src/terminal/terminal-output-coalescer.ts`, 109줄)가
① 워커 안(IPC 앞) ② 데몬 안(클라 스트림별) 두 곳에 똑같이 걸린다.
유휴 후 첫 청크는 **동기로 즉시** 내보내고(`:52-58`) 버스트만 5ms 창으로 묶는다.
`docs/terminal-performance.md` — *"Reverting to trailing-only adds a full window (~5ms) to every
keystroke echo."*

### 🔴 우리 `postMessage` 와 비교 — 우리가 확실히 싸다

Paseo 데스크톱의 실제 바이트 경로:

```
pty bytes → (워커) utf8 string → xterm.write → coalescer 5ms
  → process.send (advanced serialization) → 데몬
  → coalescer 5ms → WS 바이너리 프레임
  → ws+unix:// named pipe → Electron main (packages/desktop/src/daemon/local-transport.ts:101-104)
  → ★ buf.toString("base64") ★                    ← local-transport.ts:414-421
  → webContents.send (모든 창에 브로드캐스트)      ← local-transport.ts:86-88
  → renderer: base64 decode → xterm.write
```

우리 경로:
```
pty bytes → 배치 → webContents.postMessage(Uint8Array)  ← src/main/util/windowPush.ts:31
  → renderer → xterm.write
```
(`src/main/ipc/registerSessionIpc.ts:1-5` 주석이 이유를 적어 뒀다: V8 직렬화 typed array 단일 복사)

**비교:**
- 프로세스 홉: 저쪽 3(워커→데몬→메인→렌더러 = 4홉), 우리 1(메인→렌더러)
- 인코딩: 저쪽 **base64 왕복**(바이트당 1.33배 + 인코드/디코드 CPU), 우리 없음
- 팬아웃: `emitTransportEvent` 가 `BrowserWindow.getAllWindows()` **전부에 보낸다**
  (`local-transport.ts:86-88`) — 창 N개면 N배. 우리는 세션을 가진 창 하나로만 라우팅한다
  (`registerSessionIpc.ts:25` `getWebContents(sessionId)`).
- 지연: 코얼레서 5ms 창이 **두 번** 겹친다.

→ **F24 를 하면 우리는 이 비용을 새로 사는 것이다.** 지금 우리가 가진 단일복사 경로를 3홉 +
base64 로 바꾸면 안 된다. 데몬을 만든다면 **메인↔데몬만 소켓/파이프로 하고, 데몬→렌더러가 아니라
데몬→메인→렌더러의 마지막 구간은 지금의 `postMessage` 를 그대로 유지**해야 한다
(저쪽이 base64 를 쓰는 건 렌더러가 브라우저/모바일과 코드를 공유해야 해서다 — 우리는 그 제약이 없다).

### F27(누적 ACK) 판정

**저쪽엔 없다. 그리고 없어도 되게 만들어져 있다.** `bufferedAmount` 는 OS 소켓 버퍼가 알려 주는
절대값이라 델타 카운터의 "한 번 유실되면 창이 영구히 좁아진다" 문제 자체가 생기지 않는다.
`postMessage` 에는 `bufferedAmount` 가 없으므로 우리가 등가물을 원한다면
저쪽 플러그인 세션이 쓰는 방식(`packages/server/src/server/plugins/session-socket.ts:24, 37-47`)이
정확한 답이다: **보내기 전에 바이트를 더하고 send 콜백에서 뺀다** — 가상 `bufferedAmount`.
ACK 프로토콜보다 훨씬 싸다. **F27 은 "누적 ACK" 대신 "가상 bufferedAmount"로 다시 쓰는 걸 권한다.**

---

## 4. 고아 정리 — 여기가 가장 바로 훔칠 만하다

데몬 자체가 새 고아 원천이라는 우리 우려는 맞다. 저쪽은 **네 겹**으로 막는다.

### ① PID 락 + mtime 하트비트 (`packages/server/src/server/pid-lock.ts`, 364줄)

`$PASEO_HOME/paseo.pid` 에 `{pid, startedAt, hostname, uid, listen, heartbeat, desktopManaged}` JSON.
- `open(path, "wx")` 로 **원자적 생성**(`:149`). EEXIST 면 경합으로 판정하고 실패한다(`:152-163`).
- 살아 있는지는 `process.kill(pid, 0)`(`:45-52`), **그와 별개로 파일 mtime 을 30초마다 touch**
  (`:265-297`). 5분(`:40`) 넘게 안 갱신되면 버려진 락으로 본다.
- 버려진 락을 지우기 직전에 **다시 읽어 확인**한다(`:131-139`) — 경계에서 도착한 하트비트가 이긴다.
- `process.getuid?.() ?? 0` (`:198`) — Windows 안전.

→ **PID 재사용을 mtime 으로 가른다.** PID 만 보면 재부팅 후 같은 번호를 쓰는 남의 프로세스를
"우리 데몬"으로 오인한다.

### ② 슈퍼바이저 → 워커 하트비트, 워커의 **자살 가드**

`daemon-worker.ts:243-299` `installSupervisorLivenessGuard()` — 워커가 **스스로** 감시한다:

```ts
process.on("disconnect", () => exitAfterSupervisorLoss("ipc_disconnect_event"));
setInterval(() => {
  if (process.connected === false)          → exit  // IPC 끊김
  if (process.ppid !== supervisorPid)       → exit  // 부모가 바뀜 = 부모가 죽어 재부모화됨
  if (하트비트 3.5초 초과 && !isPidAlive(supervisorPid)) → exit
}, 1000)
```

`:329-333` 주석이 왜 `process.exit(0)` 로 바로 죽는지 설명한다:
*"The supervisor owns the worker's stdout/stderr pipes. Once it is gone, logging during graceful
shutdown can **block on the broken pipe and leave the daemon orphaned**, so supervisor loss is a
hard process boundary."*
→ **우아한 종료를 시도하다 고아가 되는 것**이 실제 사고였다. 우리 `quit-fail-smoke.cjs` 가 잡은
것과 정확히 같은 부류다.

`process.ppid` 변화 감지는 **부모가 죽었다는 가장 빠르고 확실한 신호**다(POSIX 재부모화, Windows 도
ppid 조회 가능). 우리에게 바로 이식할 수 있다.

### ③ 터미널 워커의 자기 정리

`terminal-worker-process.ts:347-350` — IPC disconnect → `manager.killAll()`.
슈퍼바이저 쪽에서도 유예 후 **프로세스 트리 전체를 SIGKILL** 한다
(`supervisor.ts:184-209` `scheduleForceKill` → `signalProcessTree`, 유예 10초 `:8`).
`signalProcessTree` 는 `tree-kill` 패키지 + 실패 시 직접 kill 폴백
(`packages/server/src/utils/tree-kill.ts:56-83`).

### ④ 헬퍼 프로세스 원장 + 부팅 시 청소 🔴 **가장 훔칠 만한 조각**

`packages/server/src/server/managed-processes/managed-processes.ts` (455줄).
`$PASEO_HOME/runtime/managed-processes/{uuid}.json` 에 스폰한 헬퍼(현재는 OpenCode 서버 등)를
기록하고, **부팅 때 남은 것을 죽인다** (`bootstrap.ts:614-619`, 백그라운드로 — 시작을 막지 않는다).

핵심은 **PID 만 믿지 않는 신원 지문**이다(`:17-31`):
```json
{ "pid": 1234, "command": "...", "args": [...],
  "identity": { "commandLine": "...", "startedAt": "..." } }
```
`reapStale()` 판정(`:252-326`, `processIdentityMatches` `:366-390`):

| 조회 결과 | 행동 | 이유 |
|---|---|---|
| 프로세스 없음 | 레코드만 삭제 | 이미 죽었다 |
| **조회 실패** | **레코드 유지, 다음에 재시도** | *"we cannot tell whether the helper is still alive … rather than orphaning a live process by deleting its record without killing it"* (`:274-277`) |
| 살아 있는데 신원 불일치 | 레코드만 삭제, **안 죽인다** | PID 재사용 — 남의 프로세스다 |
| 살아 있고 신원 일치 | SIGTERM(5초) → SIGKILL(1초) 후 삭제 | 진짜 우리 고아 |

신원 대조도 신중하다(`:391-401`): 명령줄에 토큰이 흩어져 있는 걸 일치로 보지 않고
**연속된 서명**을 요구한다 — *"a reused PID whose command line merely mentions 'opencode', 'serve'
and the port elsewhere must not be mistaken for our leftover and killed."*
그리고 레코드 하나가 깨져도 나머지 청소를 중단하지 않는다(`:352-360`).

Windows 조회는 `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process
-Filter 'ProcessId = N' | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json"`
(`:180-203`).
⚠️ **PID 하나당 PowerShell 프로세스 하나를 띄운다.** 부팅 때 남은 레코드가 여러 개면 그만큼
powershell 이 순차로 뜬다(백그라운드라 시작은 안 막지만). 우리가 가져온다면
**한 번의 `Get-CimInstance Win32_Process` 로 전부 받아 PID 로 매칭**하는 게 맞다.

### ⑤ 슈퍼바이저의 재시작 — **백오프가 없다** (안 가져올 것)

`supervisor.ts:298-327`: 워커가 비정상 종료하면 즉시 `spawnWorker()`. **지연도 상한도 없다.**
부팅 즉시 죽는 워커(설정 오류, 포트 점유 등)는 **핫루프**로 돈다. 재시작 로그는 남지만
`daemon.log` 를 채울 뿐 아무도 멈추지 않는다. 우리는 지수 백오프 + 시도 상한을 붙여야 한다.

---

## 5. 원격 — 저쪽은 **원격에 데몬을 안 깐다** (Orca 와 다르다)

준영님이 원격 데몬을 안 하기로 결정하신 건 그대로 유효하고, **저쪽도 사실상 안 한다.**

- `docs/architecture.md:106` — *"**SSH only tunnels to an already-running daemon.**"*
- SSH 는 `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ClearAllForwardings=yes
  -o ExitOnForwardFailure=yes -W 127.0.0.1:6767 <host>` 로 stdio 프록시를 만들고
  로컬 루프백 포트에 붙인다 (`packages/protocol/src/ssh-transport.ts:63-80`,
  `packages/desktop/src/daemon/local-transport.ts:196-265`).
- 저장소 전체에 `nohup`·`remote-launch`·`assertPosix` **0건**. Orca 가 하는
  "버전 붙은 설치 디렉터리 + nohup 원격 기동"은 Paseo 에 없다.
- 요구사항: **원격에 Paseo 를 사용자가 직접 깔고 `paseo daemon start` 를 직접 띄워야 한다.**
  깔면 Node 가 필요하다(`node-pty` 네이티브 포함). POSIX 전용 제약은 없다 — Windows 데몬도 지원한다
  (`managed-processes.ts:180` 의 win32 분기, `terminal.ts:1223-1235` 의 conpty 준비 대기).

원격 접근 경로 셋: **직접 TCP** / **SSH `-W` 터널** / **릴레이**(Curve25519 + NaCl box,
`docs/architecture.md:163-176`; 프로덕션 릴레이는 별 리포의 Elixir 서비스).
그리고 **Hub**(`docs/hub.md`) — 데몬이 클라우드로 아웃바운드 연결해 GitHub/Slack 트리거로 에이전트를
돌리는 SaaS. 우리와 무관하다.

**결론: 원격은 "안 가져온다"가 맞다.** 저쪽의 원격 가치는 전부 "이미 떠 있는 데몬에 어떻게 닿나"이고,
그건 우리가 이미 SSH 로 하고 있다.

---

## 6. 세션 영속 · 데이터 모델

`$PASEO_HOME` 기본값 `~/.paseo` (`docs/data-model.md:45-70`):

```
config.json                 데몬 설정
server-id                   "srv_<base64url>" 평문, 안정적 데몬 식별자
daemon-keypair.json         릴레이 E2EE 키쌍 (mode 0600)
paseo.pid                   PID 락 (§4①)
daemon.log                  pino, rotating-file-stream
agents/{sanitized-cwd}/{agentId}.json
schedules/{scheduleId}.json
projects/{projects,workspaces,workspace-labels}.json
projects/workspace-labels.transaction.json    ← 복구 가능한 복합 커밋 저널
runtime/managed-processes/{recordId}.json     ← §4④
plugins/, push-tokens.json
```

배울 점 셋:

1. **모든 영속 쓰기는 tmp+rename** — *"Persistent server stores write atomically by writing a temp
   file in the target directory and then renaming it into place"* (`docs/data-model.md:73`).
   우리 `util/atomicJson.ts` 와 같은 규율. (우리 쪽은 try/catch 가 없어 사고가 났던 이력이 있다 —
   `tests/quit-fail-smoke.cjs` 헤더.)
2. **에이전트 저장 경로는 `workspaceId` 가 아니라 `cwd` 파생** (`docs/architecture.md:337`).
   윈도우 드라이브 문자는 `C-` 접두어로 바뀐다.
3. **`workspace-labels.transaction.json`** — 카탈로그와 배정을 하나의 저널된 커밋 경계로 묶고,
   **부팅 복구가 그 커밋을 끝낸 뒤에야** 발행한다(`docs/architecture.md:110-112`).
   두 파일을 함께 고쳐야 하는 곳에 쓰는 값싼 2단계 커밋. 우리 workspace.json 계열에 참고할 만하다.

타임라인(에이전트 대화)은 **런타임 메모리**이고 durable 권위는 프로바이더 히스토리다
(`docs/architecture.md:335-337`). 터미널은 §0 대로 **영속이 아예 없다.**

---

## 7. 🔴 우리가 안 해도 되는 것 — 사내 단일 사용자에겐 과한 것

| 저쪽 것 | 왜 저쪽엔 필요한가 | 우리에겐 |
|---|---|---|
| **Relay + E2E 암호화** (`packages/relay`) | 모바일이 방화벽 밖에서 붙는다 | **불필요.** 우리 클라는 같은 PC 의 렌더러 하나 |
| **base64 바이너리 왕복** (`local-transport.ts:414-421`) | 렌더러가 웹/모바일과 코드 공유 | **절대 가져오지 마라.** §3 |
| **capability 게이트 30여 개** (`messages.ts:3390-3435`) | 데몬/앱 버전이 따로 논다(앱스토어 심사) | 우리는 한 바이너리로 같이 나간다. **버전 협상 자체가 불필요** |
| **slot 256개 다중 스트림** (`terminal-session-controller.ts:40`) | 폰·웹·데스크톱이 동시에 붙는다 | 창 몇 개. 슬롯 대신 세션 id 그대로 써도 된다 |
| **Hub / 클라우드 트리거** (`docs/hub.md`) | SaaS 제품선 | 무관 |
| **`ApplicationSocketLease` 45초** (`physical-socket.ts:12-44`) | 모바일이 조용히 사라진다 | 로컬 파이프는 끊기면 즉시 안다. 불필요 |
| **슈퍼바이저 자기 업데이트 세션** (`session/daemon/daemon-self-updater.ts`) | 데몬을 npm 으로 따로 배포 | 우리는 앱과 함께 배포. 불필요 |
| **`full-snapshot` 모드** | 프로토콜에만 있고 앱도 안 쓴다 | 만들지 마라 |
| **터미널 워커 별도 프로세스** | conpty 크래시 격리 + 데몬 루프 보호 | ⚠️ **conpty 격리 이유는 우리에게도 유효하다** — 다만 §8 참조 |

**반대로, 저쪽이 작게 만든 것도 있다** — 재부착 모드 선택 로직은 23줄
(`terminal-restore-options.ts`), 코얼레서는 109줄, PID 락은 364줄. `daemon 342파일` 같은 숫자에
겁먹을 필요 없다. **P8 의 알맹이는 대략 이 정도다:**

| 조각 | 저쪽 줄 수(테스트 제외) |
|---|---|
| `terminal.ts` (PTY + headless + 상태 추출) | 1,560 |
| `terminal-session-controller.ts` (스트림·백프레셔·스냅샷) | 1,108 |
| `worker-terminal-manager.ts` (부모 측 미러) | 863 |
| `terminal-manager.ts` | 495 |
| `terminal-worker-process.ts` | 350 |
| `terminal-snapshot.ts` (셀격자→ANSI, protocol) | 218 |
| `terminal-worker-protocol.ts` | 154 |
| `terminal-output-coalescer.ts` | 109 |
| `terminal-restore.ts` | 82 |
| `pid-lock.ts` | 364 |
| `supervisor.ts` + `supervisor-entrypoint.ts` | 571 |
| `managed-processes.ts` | 455 |
| **터미널 서브시스템 전체(비테스트 21파일)** | **5,715** |

---

## 8. 우리가 가져올 것 / 안 가져올 것

크기 기준: **S** = 하루 이내 · **M** = 며칠 · **L** = 라운드 하나 이상.

### 가져올 것

| # | 무엇 | 크기 | 근거 (파일:줄) | 왜 |
|---|---|---|---|---|
| A1 | **`revision` = 에뮬레이터 write 콜백에서 증가** | **S** | `terminal.ts:1163-1172` | 스냅샷/스트림 중복 제거의 정의를 xterm 에 위임한다. 우리 링버퍼 재생에도 그대로 쓸 수 있다. 이거 없이 스냅샷을 넣으면 반드시 중복이 뜬다 |
| A2 | **재부착 시 클라가 `ESC c`(RIS) 먼저** | **S** | `terminal-emulator-runtime.ts:143, 657-672` | 우리 `attach()` 는 지금 링버퍼를 그냥 쓴다. 두 번 attach 하면 화면이 겹친다 |
| A3 | **입력 모드 재생 서문** (bracketed paste·app cursor·kitty·win32) | **S** | `terminal-input-mode.ts:70-`, `terminal.ts:1266-1268` | 화면만 복원하면 붙여넣기·방향키가 조용히 깨진다. **F25 를 하면 반드시 같이 와야 한다** |
| A4 | **PID 락 + mtime 하트비트 + 재확인 후 탈취** | **S** | `pid-lock.ts:40-41, 113-144, 265-297` | 데몬을 만들면 첫날 필요하다. PID 재사용을 mtime 으로 가르는 게 요점 |
| A5 | **부모 생존 가드**(ppid 변화 + IPC disconnect → 즉시 `exit`) | **S** | `daemon-worker.ts:243-299` | 우리 `quit-fail-smoke.cjs` 를 데몬까지 넓히는 합격 기준의 절반이 이거다. *"우아한 종료를 시도하다 고아가 된다"* 를 막는다 |
| A6 | **헬퍼 프로세스 원장 + 부팅 시 신원 대조 청소** | **M** | `managed-processes.ts:252-401`, `bootstrap.ts:614-619` | 우리는 conpty·ssh·claude·RDP 릴레이를 스폰한다. 지금은 종료 실패 시 전부 고아다. ⚠️ Windows 조회는 **PID 당 powershell 대신 1회 일괄 CIM** 으로 고칠 것 |
| A7 | **`bufferedAmount` 2단 백프레셔** — 단, `postMessage` 용 **가상 카운터**로 | **M** | `terminal-session-controller.ts:873-882`, `plugins/session-socket.ts:24, 37-47` | **F27 을 이걸로 대체한다.** 누적 ACK 보다 싸고, 저쪽 플러그인 세션이 이미 postMessage 형 전송에 맞춘 형태를 보여 준다 |
| A8 | **셀 격자 스냅샷 → 정규화 ANSI 렌더** (소프트랩 플래그 포함) | **M** | `terminal-snapshot.ts:29-62`, `terminal.ts:1237-1256` | **F25 의 본체.** `addon-serialize` 보다 이쪽이 낫다 — 리사이즈 리플로우가 되고, 커서 스타일까지 복원한다 |
| A9 | **바이트↔헤드리스 패리티 e2e** | **S** | `daemon-e2e/terminal-byte-headless-parity.e2e.test.ts:27` | 클라 쪽 헤드리스 터미널에 라이브 바이트를 먹이고, 데몬 스냅샷과 **셀 단위로 비교**한다. 스냅샷 구현의 유일한 정직한 게이트 |
| A10 | **리딩+트레일링 코얼레서 5ms** | **S** | `terminal-output-coalescer.ts:49-63` | 우리도 배치를 하지만 리딩 엣지가 있는지 확인 필요. 없으면 키 에코가 한 창씩 늦는다 |
| A11 | **저널된 복합 커밋**(두 파일을 함께 고칠 때) | **S** | `docs/architecture.md:110-112`, `projects/workspace-labels.transaction.json` | tmp+rename 만으로는 파일 둘의 원자성을 못 준다 |

### 안 가져올 것

| 무엇 | 왜 |
|---|---|
| **릴레이 / E2E 암호화 / QR 페어링** | 로컬 단일 사용자. §7 |
| **base64 바이너리 왕복** | 우리 단일복사 `postMessage` 가 이미 더 낫다. §3 |
| **capability 협상 30여 개** | 한 바이너리로 같이 배포한다 |
| **Hub / 클라우드** | 무관 |
| **`ApplicationSocketLease`** | 로컬 파이프는 끊김을 즉시 안다 |
| **데몬 자기 업데이트** | 앱과 함께 배포 |
| **슈퍼바이저의 무백오프 재시작** | `supervisor.ts:298-327` 은 크래시루프를 만든다. 백오프 + 상한 필수 |
| **256슬롯 다중 스트림** | 세션 id 로 충분 |
| **원격 데몬** | 준영님 결정 그대로. 저쪽도 원격 설치는 안 한다(§5) |

### 🔴 재검토가 필요한 것 — F24 를 그대로 하지 마라

**F24 를 "PTY 를 별도 프로세스로 → 앱 크래시 생존"으로 정당화하면 안 된다.**
저쪽의 기본값이 그걸 안 하기 때문이다(§0). 실제로 얻는 건 셋인데 크기가 다 다르다:

1. **conpty 스폰 실패 격리** — 저쪽이 워커를 뺀 진짜 이유(`terminal-worker-process.ts:26-33`).
   우리도 Windows 라 정확히 해당한다. **이건 `PtyBackend.ts` 에 `uncaughtException` 을 다는
   작은 조각(S)으로 대부분 얻을 수 있다** — 프로세스를 안 나눠도.
2. **xterm-headless 파싱 CPU 를 메인 루프에서 빼기** — 우리가 A8(화면 모델)을 할 때 비로소 생기는
   비용이다. **A8 을 먼저 메인 프로세스에 넣고, 실측으로 이벤트루프가 밀리면** 그때 프로세스를 나눈다.
3. **Electron 메인 크래시를 넘는 터미널 생존** — 이것만이 진짜 L 이고, 저쪽엔 참고할 완성품이
   반쯤밖에 없다(데몬은 있으나 기본값이 꺼져 있고 크래시 생존은 없다).

**권하는 순서**: A1·A2·A3 → A8(화면 모델, 메인 프로세스 안에서) → A9(패리티 게이트) →
**여기서 이벤트루프를 잰다** → 밀리면 A7 + 프로세스 분리(F24) → A4·A5·A6(고아 정리).
**F26 은 보류.** 저쪽에 참고할 코드가 없고, §0 대로 그 문제를 푸는 제품이 시장에 없다.

---

## 9. 못 읽은 자리 (읽은 척하지 않는다)

정적 읽기만 했고, 아래는 **열지 않았거나 헤더만 봤다.**

**완전히 안 본 것**
- `packages/server/src/server/agent/**` 전체 (agent-manager 4,700+줄, providers/ 6종) — 헤더 grep 만
- `packages/server/src/server/session.ts` 및 `session/**` (agent-config, workspace-* 등 12개 하위 폴더)
- `packages/server/src/server/websocket-server.ts` (2,400+줄) — `bufferedAmount` 관련 줄만 grep
- `packages/server/src/server/bootstrap.ts` 전체 (1,800+줄) — `stop()`·managed-processes 부분만
- `packages/server/src/server/directory-sync/**`, `hub/**`, `plugins/**`, `speech/**`,
  `browser-tools/**`, `schedule/**`, `orchestration-skills/**`, `file-observer/**`
- `packages/relay/**` 전부 (E2E 암호화 실구현)
- `packages/client/**` 전부 (데몬 클라이언트 드라이버)
- `packages/app/**` 대부분 — 터미널 런타임 4개 파일만 부분적으로 봄
- `packages/cli/**` — daemon/local-daemon.ts 의 detached spawn 부분만
- **테스트 파일 전부** — 파일명과 `terminal-byte-headless-parity.e2e.test.ts` 앞 45줄만

**부분만 본 것**
- `terminal.ts` (1,560줄) — 1-120, 616-700(추출기 시그니처만), 925-1300 구간.
  **`extractGrid`/`extractScrollback`/`extractCursorState` 본문은 안 읽었다** (A8 이식 시 필독)
- `terminal-session-controller.ts` (1,108줄) — 800-1108 만. 앞 800줄(입력·리사이즈·소유권 처리) 미확인
- `worker-terminal-manager.ts` (863줄) — 1-200, 595-680, 795-845
- `managed-processes.ts` — 400-455 미확인
- `docs/data-model.md` (48KB) — 목차 + 3개 절만
- `docs/agent-lifecycle.md` (21KB) — 앞 60줄 + grep

**확인 못 한 주장**
- 저쪽 문서의 성능 수치는 전부 **저쪽 주장**이다 — 우리가 재지 않았다:
  echo p50 ~2.3ms / p95 ~3.3ms, keydown→commit p50 ~18ms, 스트림 페이싱 표
  (`docs/terminal-performance.md`, `docs/agent-stream-performance.md`).
  측정 스크립트 `scripts/benchmark-terminal-latency.ts` 는 **리포 루트에 실재한다**(존재만 확인,
  열지 않았고 실행하지 않았다). 즉 재현 경로는 있으나 우리가 재지 않은 남의 수치다.
- `docs/architecture.md:243` 의 **8 MiB** 는 코드(`physical-socket.ts:4`, 64 MiB)와 **불일치**.
  다른 문서 수치도 같은 정도로 낡았을 수 있다고 보는 게 안전하다.
- HEAD 은 `git log -1` 로 확인했다: `0c38749` (2026-09-01,
  *"fix(server): rewind paginated Codex threads (#4119)"*) — 지시서와 일치.
