import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * AI 답변 마크다운(#137).
 *
 * **처음엔 직접 짰다가 걷어냈다**(2026-08-25 준영님: *"굳이 만들어야 해? 라이브러리 있는데"*).
 * 그 말이 맞았다. 직접 짠 이유로 "남의 HTML 이 우리 화면에 들어온다"를 들었는데, `react-markdown`
 * 은 **HTML 문자열을 만들지 않는다** — remark 로 AST 를 만들고 React 엘리먼트로 그린다.
 * 즉 내가 내세운 근거가 이 라이브러리에는 애초에 해당하지 않았다. 그러는 사이 손으로 짠 파서는
 * 200줄이 됐고 표 하나에 또 늘었다 — 제보 하나에 한 조각씩 붙이는 건 라이브러리를 다시 쓰는 길이다.
 *
 * **지키는 선 둘** (이건 라이브러리를 써도 우리가 정해야 한다):
 *  ① `rehype-raw` 를 **넣지 않는다.** 넣으면 답변 속 `<script>`·`<iframe>` 이 진짜 태그가 된다.
 *     기본값에서는 원문 HTML 이 글자로 남는다 — 이 앱에는 사내 자격증명이 살아서 그 선을 옮기지 않는다.
 *  ② **링크는 눌러도 안 나간다.** Electron 창에서 `<a href>` 를 누르면 그 창이 통째로 그 주소로
 *     간다(앱이 사라진다). 주소를 글자로 보여 주기만 하고, 여는 것은 사람이 정한다.
 */
export function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 코드: 인라인과 블록을 갈라 각자 클래스를 준다(블록은 pre 가 가로로 스크롤한다).
          code: ({ className, children, ...rest }) => {
            const block = /language-/.test(className ?? '')
            return block ? (
              <code className={'md-blk ' + (className ?? '')} {...rest}>
                {children}
              </code>
            ) : (
              <code className="md-code" {...rest}>
                {children}
              </code>
            )
          },
          pre: ({ children, ...rest }) => (
            <pre className="md-pre" {...rest}>
              {children}
            </pre>
          ),
          // 표는 넘치면 가로로 스크롤한다 — 좁은 레일에서 칸을 접으면 숫자를 잘못 읽는다.
          table: ({ children, ...rest }) => (
            <div className="md-tablewrap">
              <table className="md-table" {...rest}>
                {children}
              </table>
            </div>
          ),
          blockquote: ({ children }) => <div className="md-quote">{children}</div>,
          hr: () => <div className="md-hr" />,
          // 위 ②: href 를 넘기지 않는다. 누를 수 없는 글자 + 주소는 툴팁으로.
          a: ({ children, href }) => (
            <span className="md-link" title={href}>
              {children}
            </span>
          ),
          img: ({ alt, src }) => <span className="md-img">{alt || String(src ?? '')}</span>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
