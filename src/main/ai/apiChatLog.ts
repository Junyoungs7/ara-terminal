/**
 * API 엔진 대화 기록(2026-08-26 준영님 요청 — *"claude code 대신 api를 사용했을때도 이 아라 세션,
 * 대화 관리도 진행해야해"*).
 *
 * **왜 우리가 써야 하나**: A 엔진(로컬 Claude Code)은 CLI 가 `~/.claude/projects/` 에 기록을 남겨서
 * 우리는 읽기만 하면 된다(araChats.ts). B 엔진(API 키)은 우리가 직접 부르는 길이라 **기록해 주는
 * 사람이 없다** — 앱을 끄면 대화가 통째로 사라진다. 그러면 같은 화면에서 엔진에 따라 "지난 대화"가
 * 있다 없다 한다.
 *
 * **줄 모양을 Claude Code 와 맞춘다.** 목록의 제목은 첫 질문에서 뽑는데, 그 파서(araChats.ts 의
 * firstQuestion)를 두 벌로 만들 이유가 없다. 필요한 것은 `type` 과 `message.content` 둘뿐이라
 * 그 둘만 같은 자리에 둔다 — 나머지는 우리 것이다.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AiTurn } from '@shared/types'

export type ApiChatLine = { type: 'user' | 'assistant'; message: { content: string }; at: number }

const NAME_RE = /^[0-9a-f-]{36}$/i

/** 그 대화의 기록 파일. id 가 uuid 가 아니면 null — 파일명을 통해 폴더 밖으로 나가지 못하게 한다. */
export function chatPath(dir: string, id: string): string | null {
  return NAME_RE.test(id) ? join(dir, `${id}.jsonl`) : null
}

/** 한 줄 붙인다. 실패해도 대화는 계속된다 — 기록을 못 남긴다고 답을 못 받을 이유는 없다. */
export function appendTurn(dir: string, id: string, role: 'user' | 'assistant', text: string): void {
  const path = chatPath(dir, id)
  if (!path || !text) return
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const line: ApiChatLine = { type: role, message: { content: text }, at: Date.now() }
    appendFileSync(path, JSON.stringify(line) + '\n', 'utf8')
  } catch {
    /* 디스크가 꽉 찼거나 권한이 없다 — 기록만 못 남기고 대화는 그대로 간다 */
  }
}

let seq = 0

/**
 * 기록을 대화 턴으로 되살린다(이어서 열기).
 *
 * 깨진 줄은 **건너뛴다**: 기록 파일은 append-only 라 마지막 줄이 잘려 있을 수 있고(쓰는 도중 종료),
 * 그 한 줄 때문에 지난 대화 전체를 못 여는 편이 훨씬 나쁘다.
 */
export function readTurns(dir: string, id: string): AiTurn[] {
  const path = chatPath(dir, id)
  if (!path) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const turns: AiTurn[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec: ApiChatLine
    try {
      rec = JSON.parse(line) as ApiChatLine
    } catch {
      continue
    }
    const text = rec?.message?.content
    if ((rec.type !== 'user' && rec.type !== 'assistant') || typeof text !== 'string') continue
    turns.push({
      id: `r${(seq += 1)}`,
      at: typeof rec.at === 'number' ? rec.at : 0,
      role: rec.type,
      text,
      ...(rec.type === 'assistant' ? { end: 'done' as const } : {})
    })
  }
  return turns
}
