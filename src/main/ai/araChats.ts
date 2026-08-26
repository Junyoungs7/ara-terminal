/**
 * 지난 아라 대화 목록(2026-08-26 준영님 요청).
 *
 * > *"아라 대화 세션 목록은 어디서 확인해? claude code의 --resume 을 하면 대화 및 세션 목록이 나오고
 * > rename으로 이름도 변경이 가능하잖아."*
 *
 * **Claude Code 가 이미 기록을 갖고 있다.** `~/.claude/projects/<폴더>/<uuid>.jsonl` 이 대화 하나다.
 * 우리는 그걸 **읽기만** 한다 — 우리 형식으로 다시 저장하면 두 벌이 되고, CLI 가 형식을 바꾸는 날
 * 조용히 어긋난다. 이어서 열 때도 그 uuid 를 `--resume` 에 그대로 넘긴다(이미 되던 길이다).
 *
 * **이름만 우리 것이다.** Claude Code 에는 대화 이름이라는 개념이 없다(파일명이 uuid 다). 그래서
 * 사람이 붙인 이름은 workspace.json 에 두고, 없으면 **첫 질문**을 제목으로 쓴다.
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type AraChatRow = {
  /** Claude Code 세션 id = 파일 이름. `--resume` 에 그대로 넘긴다. */
  id: string
  /** 마지막으로 오간 시각(파일 mtime, epoch ms). 최근 순 정렬의 기준. */
  at: number
  /** 사람이 붙인 이름. 없으면 빈 문자열 — 그때 화면은 title 을 쓴다. */
  name: string
  /** 첫 질문에서 뽑은 제목. 이름이 없을 때 목록에 보이는 글. */
  title: string
}

/**
 * cwd → Claude Code 의 프로젝트 폴더 이름.
 *
 * 규칙은 실측으로 확인했다(2026-08-26): 영숫자가 아닌 글자를 전부 `-` 로 바꾼다.
 *   `D:\AI\OFA`                              → `D--AI-OFA`
 *   `C:\Users\P24086\AppData\Roaming\A.R.A\ara-home` → `C--Users-P24086-AppData-Roaming-A-R-A-ara-home`
 */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export function projectDir(cwd: string, home = homedir()): string {
  return join(home, '.claude', 'projects', projectKey(cwd))
}

/** 제목으로 쓸 만큼만 다듬는다 — 목록 한 줄에 들어가야 한다. */
export function titleOf(raw: string): string {
  const one = raw.replace(/\s+/g, ' ').trim()
  return one.length > 60 ? one.slice(0, 60) + '…' : one
}

/**
 * 파일 **앞부분만** 읽어 첫 질문을 찾는다.
 *
 * 대화 기록은 수 MB 가 되기도 한다 — 목록 한 줄을 그리려고 전부 읽을 이유가 없다. 첫 질문은 훅·
 * 시스템 줄 뒤 스무 줄 안에 나온다(실측: 8번째 줄).
 */
const HEAD_BYTES = 64 * 1024
function firstQuestion(path: string): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    const text = buf.subarray(0, n).toString('utf8')
    // 마지막 줄은 잘렸을 수 있다 — 통째로 버린다(그 줄이 첫 질문이면 다음 기회에 잡힌다).
    const lines = text.split('\n')
    lines.pop()
    for (const line of lines) {
      if (!line.includes('"user"')) continue
      let rec: unknown
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const r = rec as { type?: string; message?: { content?: unknown } }
      if (r.type !== 'user') continue
      const c = r.message?.content
      const t =
        typeof c === 'string'
          ? c
          : Array.isArray(c) && typeof (c[0] as { text?: string } | undefined)?.text === 'string'
            ? (c[0] as { text: string }).text
            : ''
      // 사람이 친 것이 아니라 도구 결과·훅이 되돌아온 줄은 건너뛴다(질문처럼 보이지 않는다).
      const title = titleOf(t)
      if (title) return title
    }
  } catch {
    /* 읽을 수 없는 파일은 제목 없이 둔다 — 목록에서 빼면 이어서 열 길이 사라진다 */
  } finally {
    if (fd !== null) closeSync(fd)
  }
  return ''
}

const NAME_RE = /^([0-9a-f-]{36})\.jsonl$/i

/**
 * 그 폴더의 대화들을 최근 순으로. `names` 는 사람이 붙인 이름(workspace.json).
 *
 * 폴더가 없으면 빈 목록이다 — 아직 대화를 한 번도 안 한 것이고, 그건 오류가 아니다.
 */
export function listAraChats(cwd: string, names: Record<string, string> = {}, home = homedir()): AraChatRow[] {
  const dir = projectDir(cwd, home)
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const rows: AraChatRow[] = []
  for (const f of files) {
    const m = NAME_RE.exec(f)
    if (!m) continue
    const path = join(dir, f)
    let at = 0
    try {
      const st = statSync(path)
      if (!st.isFile() || st.size === 0) continue
      at = st.mtimeMs
    } catch {
      continue
    }
    const id = m[1]
    rows.push({ id, at, name: names[id] ?? '', title: firstQuestion(path) })
  }
  return rows.sort((a, b) => b.at - a.at)
}
