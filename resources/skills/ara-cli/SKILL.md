---
name: ara-cli
description: >-
  아라(ARA)가 관리하는 작업 단위(git worktree)·터미널·에이전트 탭을 `ara` 명령으로 다룬다. 사용자가 "아라 작업 단위",
  "새 워크트리에 에이전트 띄워", "다른 에이전트에게 넘겨(handoff)", "작업 메모/상태 남겨", "아라 터미널 읽기/보내기"를
  말할 때 쓴다. 아라의 상태가 걸린 일이면 git worktree·임의 PTY 대신 이것을 쓴다.
---

# ara CLI

아라가 켜져 있을 때 `ara` 로 아라의 작업 단위·터미널·에이전트 탭을 다룬다. 아라 상태와 상관없는 일은 평소 셸 도구를 쓴다.
(Orca 번들 스킬 `orca-cli` 의 아라판 — 아라에 있는 명령만 담았다.)

## 시작

- 늘 `--json` 을 붙인다. 답은 `{"ok":true,"result":...}` 또는 `{"ok":false,"error":{"code","message","nextSteps"}}`.
- 아라가 띄운 에이전트 탭·터미널 탭에서는 `ara` 가 늘 있다(그 탭의 PATH 맨 앞). 그 밖의 터미널에서 `ara` 가 없으면(명령을 못 찾음) 그렇다고 말하고 멈춘다 — 사용자가 아라 설정 › 스킬 › [CLI 설치]를 눌러야 한다(새로 연 터미널부터 보인다).
- `ara status --json` 이 `running:false` 면 아라가 꺼져 있다. `ara open --json` 이 켜 준다.
- 모르는 명령을 치면 비슷한 명령을 `nextSteps` 로 알려 준다(`Did you mean: ara worktree list`).

## 작업 단위(worktree)

id 는 `<repoId>::<경로>` 두 칸짜리다. `ara worktree list --json` 의 `id` 를 통째로 복사한다.

```text
ara repo list --json
ara worktree list [--repo id:<repoId>] --json
ara worktree current --json
ara worktree show --worktree <선택자> --json
ara worktree create --name <이름> [--repo <선택자>] [--base-branch <브랜치>] --json
ara worktree set --worktree active --comment "재현함, 고치는 중" --json
ara worktree set --worktree active --workspace-status in-review --json
ara worktree rm --worktree id:<repoId>::<경로> [--force] --json
```

- 선택자: `id:<repoId>::<경로>`, `path:<절대경로>`, `name:<표시 이름>`, `branch:<브랜치>`, `active`/`current`(지금 폴더를 품은 작업 단위).
- `--repo` 를 빼면 지금 폴더의 프로젝트에 만든다. 다른 프로젝트일 때만 `--repo` 를 준다.
- 카드 상태: `todo`·`in-progress`·`in-review`·`completed`, 지우려면 `null`. 메모(`--comment`)는 빈 글이면 지운다.
- 메모·상태는 아라 사이드바 카드에 바로 보인다 — 진행 상황을 사람에게 남길 때 쓴다.

## 넘기기(handoff)

다른 에이전트에게 일을 넘기면 원래 에이전트는 멈춘다. 새 작업 단위 id 와 에이전트 탭 id 를 보고하면 끝이다(받는 쪽이 끝나기를 기다리지 않는다).

```text
ara worktree create --name <작업 이름> --agent codex --prompt "<지시>" --json
ara agent launch --agent claude --worktree id:<repoId>::<경로> --prompt "<지시>" --json
```

- `result.launch.terminal` 이 띄운 에이전트 탭 id 다. 띄우기는 아라 앱의 [+] 와 같은 길이라 탭은 뒤에서 뜨고 화면은 옮기지 않는다.
- 에이전트: `claude`·`codex`·`gemini`.

## 터미널

```text
ara terminal list [--worktree <선택자>] --json
ara terminal create --worktree active --command "npm test" --json
ara terminal read [--terminal <id>] --json
ara terminal send [--terminal <id>] --text "계속" --enter --json
```

- `--terminal` 을 빼면 이 명령을 친 아라 에이전트 탭이다(셸 환경의 `ARA_PANE_KEY`).
- `terminal create` 는 터미널 공간에 그 폴더의 로컬 셸 탭을 연다(AI 작업 공간 탭은 에이전트 전용).
- `terminal read` 는 지금 화면 글이다. 명령을 보낸 뒤 결과는 몇 초 두고 읽는다.

## 하지 않는 것

- 아라 밖 git worktree 를 직접 만들거나 지우지 않는다(아라 목록과 어긋난다) — `ara worktree create/rm` 을 쓴다.
- 여러 줄 지시는 Windows `ara.cmd` 가 줄바꿈을 못 넘긴다 — `--prompt` 는 한 줄로.
