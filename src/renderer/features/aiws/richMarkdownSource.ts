// 3차 R1-B 리치 마크다운 — 원문 보존(Orca rich-markdown-source-transport·markdown-round-trip 의 줄인 판).
// Tiptap 은 문서 전체를 다시 직렬화한다 → 한 글자만 고쳐도 다른 블록의 `*`·`__`·빈 줄이 바뀐다. 그래서 맨 위 블록 단위로
// "안 고친 블록은 원문 그대로, 고친 블록만 Tiptap 직렬화"로 다시 잇는다. 블록 줄 번호는 리뷰 주석이 쓴다(고른 블록 → 원문 줄).
// ponytail: Orca 의 코덱(HTML 자리표시·참조 링크 보존 증명)은 뺐다 — 그런 문서는 애초에 리치 대신 미리 보기로 연다(docView.markdownRichUnsupported).
import { Lexer } from 'marked'

/** 맨 위 블록 하나 — lead = 앞 줄바꿈·빈 줄, raw = 원문 조각(끝 줄바꿈 뺌), start·end = 본문 기준 줄(1부터, 포함). */
export type SourceBlock = { lead: string; raw: string; start: number; end: number }

const lines = (s: string): number => s.split('\n').length - 1

/** 본문(LF) → 맨 위 블록들 + 끝 줄바꿈. marked 가 Tiptap 의 파서이기도 해서 블록 수가 Tiptap 맨 위 노드 수와 대개 같다. */
export function splitMarkdownBlocks(body: string): { blocks: SourceBlock[]; tail: string } {
  const blocks: SourceBlock[] = []
  let gap = ''
  let line = 1
  for (const tok of Lexer.lex(body, { gfm: true })) {
    if (tok.type === 'space') {
      gap += tok.raw
      line += lines(tok.raw)
      continue
    }
    // 블록 끝 줄바꿈은 다음 블록의 lead 로 넘긴다 — 블록 하나를 갈아 끼워도 그 뒤 빈 줄이 같이 사라지지 않게.
    const raw = tok.raw.replace(/\n+$/, '')
    blocks.push({ lead: gap, raw, start: line, end: line + lines(raw) })
    line += lines(tok.raw)
    gap = tok.raw.slice(raw.length)
  }
  return { blocks, tail: gap }
}

/**
 * 새 블록 직렬화들(sers) → 원문. 원래 블록의 직렬화(base[i])와 같은 블록은 원래 lead+raw 를(앞으로만 찾는다 — 순서 유지),
 * 아니면 Tiptap 직렬화를 빈 줄 하나로 띄워 넣는다.
 */
export function mergeMarkdownBlocks(blocks: SourceBlock[], base: string[], tail: string, sers: string[]): string {
  // 문서 맨 앞 빈 줄(머리말 뒤 빈 줄 등)은 첫 블록의 lead 다 — 그대로 둔다.
  let out = blocks[0]?.lead ?? ''
  let emitted = false
  let k = 0
  for (const s of sers) {
    let m = -1
    for (let i = k; i < base.length; i++) {
      if (base[i] === s) {
        m = i
        break
      }
    }
    if (m >= 0) {
      out += (emitted ? blocks[m].lead : '') + blocks[m].raw
      k = m + 1
    } else {
      out += (emitted ? '\n\n' : '') + s.replace(/\n+$/, '')
    }
    emitted = true
  }
  return emitted ? out + tail : ''
}
