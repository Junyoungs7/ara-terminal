import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { insertText } from '../src/renderer/components/aiBlocks'

// 2026-09-08 준영님 제보 넷 중 ①②③ 이 여기서 만난다(agent_talk/CHAT-usability-task.md).
//
// ②*"가로 스크롤이 생길때 계속 처음으로 돌아가는 버그"* 의 원인은 스크롤 코드가 아니라 **렌더**였다.
// md.tsx 의 `components` 객체가 렌더 안에서 만들어져 화살표 함수의 참조가 매번 바뀌었고, React 는
// 엘리먼트 type 이 바뀌면 재조정 대신 언마운트→마운트를 한다 — `<pre>` 가 새 노드로 태어나면서
// scrollLeft 가 0 이 되고 잡아 둔 드래그 선택도 함께 사라졌다(③ 의 진짜 원인이기도 하다).
// 되감기는 주기는 **2.5초**, 텔레메트리 폴링과 같은 박자였다(#190 과 같은 뿌리).
//
// 실측은 tests/chat-usability-probe.cjs(offscreen)가 했다. 여기 있는 것은 **그 실측이 다시 필요해지지
// 않게 하는 래칫**이다: 아래 모양이 무너지면 증상은 조용히 돌아오는데, 화면을 열어 봐야만 보인다.
const SRC = readFileSync(join(__dirname, '../src/renderer/components/md.tsx'), 'utf8')
const CSS = readFileSync(join(__dirname, '../src/renderer/styles/shell.css'), 'utf8')

describe('md.tsx — 리렌더가 코드블록을 다시 태어나게 하면 안 된다 (제보 ②③)', () => {
  it('components 를 렌더 안에서 만들지 않는다(인라인 객체 리터럴 금지)', () => {
    // `components={{ … }}` 가 되살아나는 순간 매 렌더가 새 함수 참조를 만든다.
    expect(SRC).not.toMatch(/components=\{\{/)
    expect(SRC).toMatch(/components=\{COMPONENTS\}/)
  })

  it('COMPONENTS 가 모듈 스코프에 있다(들여쓰기 0 = 함수 밖)', () => {
    expect(SRC).toMatch(/^const COMPONENTS: Components = \{/m)
  })

  it('Markdown 이 memo 로 싸여 있다 — text 가 그대로면 다시 파싱하지 않는다', () => {
    expect(SRC).toMatch(/export const Markdown = memo\(/)
  })
})

describe('md.tsx — 코드블록 복사 (제보 ①)', () => {
  it('복사는 clipboardWrite 를 거친다(navigator.clipboard 직접 호출 금지)', () => {
    // 문서에 포커스가 없으면 Chromium 이 거부한다 — store/clipboardWrite.ts 주석 참고.
    expect(SRC).toMatch(/writeClipboard\(/)
    expect(SRC).not.toMatch(/navigator\.clipboard/)
  })

  it('꼬리 개행은 insertText() 하나로 뗀다 — 두 번째 구현을 만들지 않는다', () => {
    expect(SRC).toMatch(/writeClipboard\(insertText\(/)
    // 여기서 직접 개행을 걷는 정규식이 또 생기면 둘이 어긋나는 날이 온다.
    expect(SRC).not.toMatch(/replace\(\s*\/\\n/)
  })

  it('insertText 가 실제로 꼬리 개행을 뗀다 — 붙여넣는 순간 실행되지 않게', () => {
    // react-markdown 이 그리는 `<pre>` 의 textContent 는 개행으로 끝난다(하네스 실측:
    // rawEndsWithNewline=true). 그대로 복사하면 터미널에 붙는 순간 실행된다.
    expect(insertText('docker ps -a\n')).toBe('docker ps -a')
  })

  it('버튼이 `<pre>` 밖 윗줄에 있다 — 가로로 밀어도 안 사라지고 명령을 안 가린다', () => {
    // `<pre>` 안에 두면 스크롤하는 것이 `<pre>` 자신이라 버튼이 왼쪽으로 흘러나간다.
    // 겹쳐 띄우면(absolute) 좁은 레일에서 명령의 오른쪽을 가린다 — 실측 후 흐름 배치로 되돌렸다.
    expect(/\.md-prewrap\s*\{[^}]*flex-direction:\s*column/.test(CSS)).toBe(true)
    expect(/\.md-copy\s*\{[^}]*position:\s*absolute/.test(CSS)).toBe(false)
    // md.tsx 의 CopyBtn 이 nextElementSibling 으로 `<pre>` 를 찾는다 — 순서가 뒤집히면 빈 복사가 된다.
    expect(SRC).toMatch(/<CopyBtn \/>\s*<pre className="md-pre"/)
  })
})

describe('선택 표시 (제보 ④)', () => {
  const TOKENS = readFileSync(join(__dirname, '../src/renderer/styles/tokens.css'), 'utf8')

  it('::selection 이 터미널과 같은 --sel-bg 를 쓴다(--accent-glow 15% 로 되돌리지 않는다)', () => {
    const rule = /::selection\s*\{[^}]*\}/.exec(TOKENS)
    expect(rule, '::selection 규칙을 못 찾음').toBeTruthy()
    expect(rule![0]).toMatch(/background:\s*var\(--sel-bg\)/)
    expect(rule![0]).not.toMatch(/--accent-glow/)
  })
})
