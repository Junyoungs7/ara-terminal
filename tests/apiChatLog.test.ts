/**
 * API 엔진 대화 기록(2026-08-26 준영님 요청 — *"api를 사용했을때도 이 아라 세션, 대화 관리도"*).
 *
 * CLI 는 Claude Code 가 남겨 주지만 API 는 **남겨 줄 사람이 없다** — 우리가 안 쓰면 앱을 끌 때
 * 대화가 통째로 사라지고, 같은 화면에서 엔진에 따라 "지난 대화" 가 있다 없다 한다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendTurn, readTurns, chatPath } from '../src/main/ai/apiChatLog'
import { listApiChats } from '../src/main/ai/araChats'

let dir: string
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ara-apichat-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('기록 파일 자리', () => {
  it('★ uuid 가 아닌 id 는 파일을 만들지 않는다(파일명으로 폴더 밖에 못 나간다)', () => {
    expect(chatPath(dir, '../../etc/passwd')).toBeNull()
    expect(chatPath(dir, 'nope')).toBeNull()
    appendTurn(dir, '../evil', 'user', '나쁜 것')
    expect(readTurns(dir, '../evil')).toEqual([])
  })
})

describe('쓰고 되살리기', () => {
  it('★ 주고받은 말이 순서대로 되살아난다', () => {
    appendTurn(dir, ID, 'user', '서버 상태 어때?')
    appendTurn(dir, ID, 'assistant', '괜찮습니다.')
    appendTurn(dir, ID, 'user', '디스크는?')
    const turns = readTurns(dir, ID)
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ['user', '서버 상태 어때?'],
      ['assistant', '괜찮습니다.'],
      ['user', '디스크는?']
    ])
  })

  it('빈 답은 남기지 않는다(할 말이 없으면 줄도 없다)', () => {
    appendTurn(dir, ID, 'assistant', '')
    expect(readTurns(dir, ID)).toEqual([])
  })

  it('★ 깨진 줄이 있어도 나머지는 살린다 — 한 줄 때문에 지난 대화를 통째로 잃지 않는다', () => {
    appendTurn(dir, ID, 'user', '첫 질문')
    const path = chatPath(dir, ID)!
    writeFileSync(path, readFileSync(path, 'utf8') + '{"type":"user","message":{"con', 'utf8')
    expect(readTurns(dir, ID).map((t) => t.text)).toEqual(['첫 질문'])
  })

  it('없는 대화는 빈 배열', () => {
    expect(readTurns(dir, 'ffffffff-ffff-ffff-ffff-ffffffffffff')).toEqual([])
  })
})

describe('목록에 함께 뜬다', () => {
  it('★ 같은 파서를 쓴다 — 첫 질문이 제목이 되고 engine 은 api 다', () => {
    appendTurn(dir, ID, 'user', 'API 로 물어본 것')
    appendTurn(dir, ID, 'assistant', '답')
    const rows = listApiChats(dir, {})
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('API 로 물어본 것')
    expect(rows[0].engine).toBe('api')
  })

  it('붙인 이름이 함께 온다(이름 저장소는 엔진과 무관하게 하나다)', () => {
    appendTurn(dir, ID, 'user', '무언가')
    expect(listApiChats(dir, { [ID]: '비용 조사' })[0].name).toBe('비용 조사')
  })
})
