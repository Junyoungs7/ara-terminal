/**
 * 마크다운 조금(#137) — AI 답변을 읽을 만하게.
 *
 * **왜 직접 쓰나**: 라이브러리를 넣으면 그 라이브러리의 HTML 이 우리 화면에 들어온다. 이 글은
 * 모델이 쓴 것이라 **신뢰 경계 밖**이고, 이 앱에는 사내 서버 자격증명이 산다 — `dangerouslySetInnerHTML`
 * 을 쓰는 순간 그 판단을 남의 파서에 맡기게 된다. 여기서는 **React 엘리먼트만** 만든다: HTML 문자열이
 * 한 번도 생기지 않으므로 주입이라는 개념 자체가 없다.
 *
 * **왜 조금만 하나**: 답변에 실제로 나오는 것은 코드블록·굵게·목록·제목 정도다. 표·각주·이미지까지
 * 받으려면 파서가 열 배가 되고, 그건 라이브러리를 넣을 이유가 되지 갓 만든 코드가 할 일이 아니다.
 * 지원하지 않는 문법은 **글자 그대로 남는다**(사라지지 않는다 — 그게 이 판의 안전한 실패다).
 *
 * 지원: ```코드블록``` · `인라인` · **굵게** · *기울임* · # 제목 · - 목록 · 1. 목록 · > 인용 · ---
 */

type Block =
  | { k: 'code'; lang: string; text: string }
  | { k: 'h'; level: 1 | 2 | 3; text: string }
  | { k: 'ul'; items: string[] }
  | { k: 'ol'; items: string[] }
  | { k: 'quote'; text: string }
  | { k: 'hr' }
  | { k: 'p'; text: string }

/** 글 → 블록들. 순수 함수라 검사 대상이다(화면 없이 규칙을 시험한다). */
export function mdBlocks(src: string): Block[] {
  const lines = src.split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''

    // 코드블록 — **닫히지 않아도 코드로 본다**(스트리밍 중에는 늘 열려 있다).
    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? ''
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i += 1
      }
      i += 1 // 닫는 줄(없으면 끝이다)
      // 끝의 빈 줄은 버린다 — 안 닫힌 블록은 글 끝의 개행까지 삼켜서 코드 밑에 빈 칸이 남는다.
      out.push({ k: 'code', lang, text: body.join('\n').replace(/\n+$/, '') })
      continue
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push({ k: 'hr' })
      i += 1
      continue
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      out.push({ k: 'h', level: (h[1]?.length ?? 1) as 1 | 2 | 3, text: h[2] ?? '' })
      i += 1
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^\s*>\s?/, ''))
        i += 1
      }
      out.push({ k: 'quote', text: body.join('\n') })
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''))
        i += 1
      }
      out.push({ k: 'ul', items })
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''))
        i += 1
      }
      out.push({ k: 'ol', items })
      continue
    }

    // 문단 — 빈 줄까지 모은다(한 줄씩 끊으면 답변이 사다리처럼 보인다).
    const para: string[] = []
    while (i < lines.length) {
      const cur = lines[i] ?? ''
      if (cur.trim() === '' || /^\s*(```|#{1,3}\s|>|[-*+]\s|\d+[.)]\s|-{3,}\s*$)/.test(cur)) break
      para.push(cur)
      i += 1
    }
    if (para.length > 0) out.push({ k: 'p', text: para.join('\n') })
    else i += 1 // 빈 줄
  }
  return out
}

/** 한 줄 안의 강조 — `코드` · **굵게** · *기울임*. 겹치면 **코드가 이긴다**(코드 안의 별표는 글자다). */
export function mdInline(src: string): (string | { k: 'code' | 'b' | 'i'; text: string })[] {
  const out: (string | { k: 'code' | 'b' | 'i'; text: string })[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|__([^_]+)__/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index))
    if (m[1] !== undefined) out.push({ k: 'code', text: m[1] })
    else if (m[2] !== undefined) out.push({ k: 'b', text: m[2] })
    else if (m[3] !== undefined) out.push({ k: 'i', text: m[3] })
    else if (m[4] !== undefined) out.push({ k: 'b', text: m[4] })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

function Inline({ text }: { text: string }): JSX.Element {
  return (
    <>
      {mdInline(text).map((p, i) =>
        typeof p === 'string' ? (
          <span key={i}>{p}</span>
        ) : p.k === 'code' ? (
          <code key={i} className="md-code">
            {p.text}
          </code>
        ) : p.k === 'b' ? (
          <strong key={i}>{p.text}</strong>
        ) : (
          <em key={i}>{p.text}</em>
        )
      )}
    </>
  )
}

/** 블록 → 화면. HTML 문자열을 만들지 않는다(위 주석 참고). */
export function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="md">
      {mdBlocks(text).map((b, i) => {
        switch (b.k) {
          case 'code':
            // 긴 줄은 **가로로 스크롤**한다 — 줄바꿈으로 접으면 명령을 잘못 읽는다.
            return (
              <pre key={i} className="md-pre" data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            )
          case 'h':
            return (
              <div key={i} className={'md-h h' + b.level}>
                <Inline text={b.text} />
              </div>
            )
          case 'ul':
            return (
              <ul key={i} className="md-ul">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} />
                  </li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={i} className="md-ol">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} />
                  </li>
                ))}
              </ol>
            )
          case 'quote':
            return (
              <div key={i} className="md-quote">
                <Inline text={b.text} />
              </div>
            )
          case 'hr':
            return <div key={i} className="md-hr" />
          default:
            return (
              <p key={i} className="md-p">
                <Inline text={b.text} />
              </p>
            )
        }
      })}
    </div>
  )
}
