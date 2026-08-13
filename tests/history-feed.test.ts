// M-4/HIST-15 회귀: 단말 응답 시퀀스(DA·포커스 리포트·CPR)가 term.onData 로 사용자 입력과 섞여
// 들어와도 feedInput 이 줄 버퍼를 비우지 않아야 한다. 실측 청크 재현(BUG-BACKLOG.md M-4 참고):
// ["e","c","h","\x1b[?1;2c","\x1b[I","o"," ","b","b","d","e","b","u","g","\r"]
import { describe, it, expect } from 'vitest'
import { feedInput } from '../src/renderer/store/history'

function feed(buf: string, chunks: string[]): { buf: string; commands: string[] } {
  const commands: string[] = []
  for (const chunk of chunks) {
    const r = feedInput(buf, chunk)
    buf = r.buf
    commands.push(...r.commands)
  }
  return { buf, commands }
}

describe('feedInput — 단말 응답 시퀀스', () => {
  it('DA 응답(ESC[?1;2c)이 타이핑 중간에 끼어도 그때까지 친 글자가 남는다', () => {
    const r = feed('', ['e', 'c', 'h', '\x1b[?1;2c', 'o', ' ', 'b', 'b', 'd', 'e', 'b', 'u', 'g', '\r'])
    expect(r.commands).toEqual(['echo bbdebug'])
  })

  it('DA + 포커스 리포트(ESC[I)가 연달아 끼어도(실측 재현) 명령이 온전하다', () => {
    const r = feed('', ['e', 'c', 'h', '\x1b[?1;2c', '\x1b[I', 'o', ' ', '수', '집', '확', '인', '\r'])
    expect(r.commands).toEqual(['echo 수집확인'])
  })

  it('CPR 응답(ESC[24;80R)도 버퍼를 비우지 않는다', () => {
    const r = feed('', ['p', 'w', 'd', '\x1b[24;80R', '\r'])
    expect(r.commands).toEqual(['pwd'])
  })

  it('응답 시퀀스만 단독으로 와도 명령이 생기지 않고 버퍼도 그대로다', () => {
    const r = feedInput('ec', '\x1b[?1;2c')
    expect(r).toEqual({ buf: 'ec', commands: [] })
  })

  it('진짜 리드라인 편집(방향키 ESC[A 등)은 여전히 버퍼를 비운다(회귀 방지)', () => {
    const r = feedInput('partial', '\x1b[A')
    expect(r.buf).toBe('')
    expect(r.commands).toEqual([])
  })
})
