import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'

/**
 * 신고 #27: MCP `session_read` 가 **사람이 보는 화면 그대로**를 돌려주게 하는 자리.
 *
 * 예전엔 재생 버퍼(peek)에서 ANSI 만 걷었다. Claude Code·vim·top 처럼 커서를 옮겨 다시 그리는 앱은
 * 걷고 나면 **지나간 프레임 조각**만 남아, 아라가 "실행 전 명령 줄만 보인다"고 했다.
 * 여기서는 같은 바이트를 헤드리스 xterm 에 그 세션의 치수로 재생해 **그려진 결과**를 읽는다.
 * 렌더러도 탭을 다시 열 때 같은 재생 버퍼를 새 xterm 에 그대로 넣는다 — 그래서 결과가 같다.
 * (렌더러의 xterm 을 IPC 로 묻는 길은 숨은 탭·AI 가 만든 탭처럼 xterm 이 없는 세션에서 못 쓴다.)
 *
 * 대체 화면(alt screen)이면 `buffer.active` 가 곧 그 화면이다(스크롤백 없음).
 * 일반 화면이면 스크롤백 + 보이는 줄 — 길이는 부르는 쪽의 capContext 가 앞에서 자른다.
 */
export function renderScreen(bytes: Uint8Array, cols: number, rows: number): Promise<string> {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  // 렌더러와 같은 폭 규칙(이모지·기호 폭) — 안 맞추면 줄이 한 칸씩 밀린다.
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  return new Promise((resolve) => {
    term.write(bytes, () => {
      const buf = term.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
      term.dispose()
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
      resolve(lines.join('\n'))
    })
  })
}
