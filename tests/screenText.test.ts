// #27: session_read 는 ANSI 를 걷은 원문이 아니라 **그려진 화면**을 돌려준다.
import { describe, it, expect } from 'vitest'
import { renderScreen } from '../src/main/sessions/screenText'

const b = (s: string) => new TextEncoder().encode(s)

describe('renderScreen', () => {
  it('같은 줄을 \r\x1b[2K 로 덮어쓰면 마지막 글만 남는다', async () => {
    const out = await renderScreen(b('$ claude\r\n⠋ 생각 중\r\x1b[2K⠙ 생각 중\r\x1b[2K✻ 완료'), 40, 5)
    expect(out).toBe('$ claude\n✻ 완료')
  })

  it('커서를 위로 올려 다시 그리면 지금 프레임이 나온다', async () => {
    const out = await renderScreen(b('> 입력칸\r\n상태: 대기\x1b[1A\r\x1b[2K> 확인해 줘\r\n\x1b[2K상태: 실행 중'), 40, 5)
    expect(out).toBe('> 확인해 줘\n상태: 실행 중')
  })

  it('대체 화면(alt screen)에 들어가면 그 화면을 준다 — 앞의 명령 줄은 안 보인다', async () => {
    const out = await renderScreen(b('$ vim a.txt\r\n\x1b[?1049h\x1b[H\x1b[2J~ 편집 화면\x1b[3;1H~'), 40, 4)
    expect(out).toBe('~ 편집 화면\n\n~')
  })
})
