// 아라 답변 마크다운 분해 — 순수 함수. 라이브러리를 넣지 않는다(설계 §4.4).
//
// 필요한 것은 둘뿐이다: 펜스 코드블록을 잘라내는 것, 나머지를 pre-wrap 으로 두는 것.
// react-markdown + remark + 하이라이터는 이 두 줄을 위해 번들 수백 KB 를 더한다.
//
// **스트리밍 중 아직 닫히지 않은 펜스를 정상 입력으로 처리하는 것이 이 함수의 진짜 요구사항이다.**
// 마크다운 라이브러리는 열린 펜스를 문단으로 봤다가 닫히는 순간 코드블록으로 바꾸므로 글자가
// 흘러들어오는 동안 블록이 깜빡인다. 여기서는 열린 펜스를 "진행 중인 코드블록"으로 바로 그린다.
//
// ponytail: 인라인 마크다운(**굵게**, `코드`)은 렌더하지 않고 원문 그대로 둔다.
// 실사용에서 거슬린다는 말이 나오면 정규식 두 개를 더한다.

export type AiBlock = { type: 'text'; text: string } | { type: 'code'; lang: string; code: string; open?: boolean }

// 줄 맨 앞의 펜스만 펜스로 본다 — 블록 안에 든 인라인 백틱(`du -sh`)은 건드리지 않는다.
const FENCE = /^```(\S*)\s*$/

export function splitBlocks(md: string): AiBlock[] {
  const out: AiBlock[] = []
  let buf: string[] = []
  let lang: string | null = null // null = 지금 텍스트를 모으는 중, 문자열 = 코드블록 안

  const flushText = () => {
    const text = buf.join('\n')
    // 블록 사이의 빈 줄만 남은 조각은 버린다(코드블록 위아래에 빈 문단이 생기는 것을 막는다).
    if (text.trim()) out.push({ type: 'text', text: text.replace(/^\n+|\n+$/g, '') })
    buf = []
  }

  for (const line of md.split('\n')) {
    const fence = FENCE.exec(line)
    if (lang === null) {
      if (fence) {
        flushText()
        lang = fence[1]
      } else {
        buf.push(line)
      }
      continue
    }
    // 코드블록 안: 닫는 펜스는 언어 없는 ``` 이지만, 언어가 붙어 있어도 닫는 것으로 본다
    // (모델이 실수로 ```bash 를 두 번 쓰는 경우가 있고, 그때 나머지 답이 통째로 코드가 되는 편이 더 나쁘다).
    if (fence) {
      out.push({ type: 'code', lang, code: buf.join('\n') })
      buf = []
      lang = null
      continue
    }
    buf.push(line)
  }

  if (lang !== null) {
    // 아직 닫히지 않은 펜스 = 스트리밍 진행 중. 지금까지 온 만큼을 코드블록으로 그린다.
    out.push({ type: 'code', lang, code: buf.join('\n'), open: true })
  } else {
    flushText()
  }
  return out
}

// [터미널로 보내기] 가 실제로 넣는 문자열.
// **마지막 개행을 떼는 것이 이 기능의 안전 설계 전부다** — 명령이 프롬프트에 입력된 상태로 멈추고,
// 사용자가 읽고 Enter 를 눌러야 실행된다. 클릭 = 실행이 아니라 클릭 = 붙여넣기다(설계 §4.3).
// 여러 줄 블록은 첫 줄만 보내지 않는다. 중간 개행은 그대로 두고 꼬리만 잘라낸다.
export function insertText(code: string): string {
  return code.replace(/\n+$/, '')
}
