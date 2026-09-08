import { memo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { insertText } from './aiBlocks'
import { writeClipboard } from '../store/clipboardWrite'
import { t } from '../i18n'

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

/**
 * 코드블록 복사(2026-09-08 준영님: *"명령어, 코드 등 이런 것들은 복사 편하게 복사 버튼 달아주고"*).
 *
 * **복사할 글자를 DOM 에서 읽는다.** react-markdown 은 `pre` 컴포넌트에 자식 엘리먼트(`<code>`)만
 * 넘기지 원문 문자열을 안 준다 — props 를 파고들어 꺼내면 hast 구조가 바뀌는 날 조용히 빈 문자열을
 * 복사한다. `textContent` 는 **화면에 보이는 그것**이라 그 어긋남이 생길 수 없다.
 * ⚠️ `currentTarget` 은 핸들러가 끝나면 React 가 null 로 만든다 — await 앞에서 먼저 읽는다.
 *
 * ⚠️ **꼬리 개행을 뗀다**(`insertText`). 명령을 복사하는 자리라, 개행까지 붙여넣으면 터미널이
 * 그 순간 실행한다. [터미널로 보내기]가 쓰던 그 함수를 그대로 쓴다 — 두 벌을 만들면 한쪽만 고쳐진다.
 *
 * 성공 표시는 **버튼 자리에서** 한다(AiPanel·CommandBook 의 [복사]와 같은 1.2초 라벨 교체).
 * 실패는 `writeClipboard` 가 스스로 알린다 — 여기서 "복사됨"으로 덮으면 그 안내가 거짓이 된다.
 */
function CopyBtn(): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="md-copy"
      data-action="md.copy"
      title={t('ai.code.copy')}
      onClick={(e) => {
        const code = e.currentTarget.nextElementSibling?.textContent ?? ''
        if (!code) return
        void writeClipboard(insertText(code)).then((ok) => {
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {copied ? t('ai.code.copied') : t('ai.code.copy')}
    </button>
  )
}

/**
 * 🔴 **모듈 스코프에 둔다. 렌더 안으로 옮기지 마라.**
 *
 * 2026-09-08 제보 *"우측 사이드바가 작아서 가로 스크롤이 생길때 계속 처음으로 돌아가는 버그"* 의
 * 원인이 정확히 이것이었다. 이 객체가 렌더마다 새로 만들어지면 값(화살표 함수)의 **참조가 매번
 * 바뀌고**, react-markdown 은 그 함수를 엘리먼트 `type` 으로 그대로 넘긴다. React 는 type 이
 * 달라지면 재조정이 아니라 **언마운트→마운트**를 한다 — `<pre>` DOM 노드가 통째로 새로 태어나므로
 * 그 안의 `scrollLeft` 도 0 이 되고 사용자가 잡아 둔 **드래그 선택도 사라진다**.
 *
 * 되감기는 주기는 **2.5초**였다. 텔레메트리 폴링(LocalTelemetry.POLL_MS)이 그 간격으로
 * `setPorts`/`setStats` 를 **새 참조로** 갈아(값이 같아도) Shell 을 다시 그린다. 아래 `Markdown`
 * 말고는 렌더러에 `memo` 가 한 곳도 없어 그 리렌더가 아라 패널 끝까지 내려온다 — #190 과 같은 뿌리다.
 * 즉 여기 고친 것은 **증상의 한 갈래**다: 틱마다 트리 전체가 다시 그려지는 것 자체는 그대로 남아 있다.
 *
 * 실측(tests/chat-usability-probe.cjs, offscreen):
 *   틱 한 번 → scrollLeft 1391 → 0 · `<pre>` 도장 소실(= 다른 노드) · 선택 40자 → 0자
 *   같은 시간 가만히 두면(틱 없음) → 1391 유지 · 도장 유지 ← **시계가 아니라 틱이 범인**이라는 대조군
 *   재정의하지 않는 `<p>` 는 두 경우 모두 살아남았다 ← 트리 전체가 아니라 **재정의한 것만** 죽었다
 */
const COMPONENTS: Components = {
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
  /**
   * 복사 버튼은 **`<pre>` 밖·바로 윗줄**에 둔다. 안에 넣으면 가로로 스크롤하는 것이 `<pre>` 자신이라
   * 긴 명령을 오른쪽으로 밀 때 버튼이 흘러나가 사라지고, 겹쳐 띄우면 명령을 가린다(자리를 고른
   * 근거와 실측은 shell.css 의 `.md-prewrap` 주석에 있다 — 좁은 레일에서 50px 을 가렸다).
   * 순서를 뒤집지 마라: `CopyBtn` 이 `nextElementSibling` 으로 이 `<pre>` 를 찾는다.
   */
  pre: ({ children, ...rest }) => (
    <div className="md-prewrap">
      <CopyBtn />
      <pre className="md-pre" {...rest}>
        {children}
      </pre>
    </div>
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
}

const REMARK = [remarkGfm]

/**
 * `memo` — 위 COMPONENTS 와 **같은 제보에서 나온 같은 이유**다. 참조를 고정하면 노드는 살아남지만
 * 텔레메트리 틱마다 답변 전부를 remark 로 다시 파싱하는 일은 그대로 남는다(대화가 길수록 비싸진다).
 * `text` 가 그대로면 아예 다시 그리지 않는다 — 스트리밍 중에는 text 가 바뀌니 정상적으로 따라 그린다.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
