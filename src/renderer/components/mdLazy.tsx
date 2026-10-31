import { memo, useEffect, useState } from 'react'

/**
 * 마크다운 지연 로드(M0 4-B). `md.tsx` 가 끄는 react-markdown·unified·micromark 묶음(≈588 kB)을
 * 진입 청크에서 뺀다 — 쓰는 곳은 아라 채팅뿐이고, 그 패널은 처음 열 때 마운트된다(Shell 의 araEver).
 *
 * **한 번 불러오면 동기로 그린다**(`React.lazy`+`Suspense` 를 쓰지 않는 이유): Suspense 는 경계 안을
 * 통째로 fallback 으로 바꾼다 — 답변 하나가 늦게 들어오면 이미 그려진 것까지 깜박인다. 모듈을 변수에
 * 쥐고 있으면 그 뒤로는 그냥 컴포넌트다.
 * 불러오기 전에 그릴 일이 생기면 같은 `.md` 상자에 평문(줄바꿈 유지)으로 둔다. 패널이 열릴 때
 * `loadMarkdown()` 을 먼저 부르므로(첫 답변은 엔진이 뜨고 나서 온다) 실제로 평문이 보일 일은 드물다.
 */
type Mod = typeof import('./md')
let mod: Mod | null = null
let pending: Promise<Mod> | null = null

export function loadMarkdown(): Promise<Mod> {
  return (pending ??= import('./md').then((m) => (mod = m)))
}

export const Markdown = memo(function Markdown({ text }: { text: string }): JSX.Element {
  const [, setReady] = useState(mod !== null)
  useEffect(() => {
    if (!mod) void loadMarkdown().then(() => setReady(true))
  }, [])
  if (mod) return <mod.Markdown text={text} />
  return (
    <div className="md" style={{ whiteSpace: 'pre-wrap' }}>
      {text}
    </div>
  )
})
