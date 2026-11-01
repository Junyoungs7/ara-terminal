// M12 R3 RV-03 AI 작성 줄 — 에디터 거터·diff(바뀐 쪽) 장식. 판정은 main(code/aiLines.ts)이 한다: 지금 보이는 글을 주면 AI 줄 범위가 온다.
// 성능: 렌더러는 줄을 세지 않는다(맞추기는 main) · 고치는 동안은 묶어서(AI_LINES_DEBOUNCE_MS) 한 번 · 큰 글은 묻지 않는다.
// 사람이 고친 줄은 Monaco 장식이 따라 움직이다가 다음 물음에서 사람 것으로 바뀐다.
import { AI_LINES_MAX_BYTES } from '@shared/aiLines'
import { t } from '../../i18n'
import { monaco } from './monacoSetup'

type Ed = ReturnType<typeof monaco.editor.create>
const AI_LINES_DEBOUNCE_MS = 400
const RELOAD_WINDOW_MS = 5_000

/** pathOf: 지금 모델의 로컬 절대 경로(원격·모르는 파일이면 null — 표시 없음). */
export function watchAiLines(ed: Ed, pathOf: () => string | null): void {
  const deco = ed.createDecorationsCollection()
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0
  /** 지금 모델에 AI 줄이 있었나 — 없던 파일은 칠 때마다 묻지 않는다(대부분의 파일). */
  let any = false
  /** 마지막 알림(에이전트가 이 파일을 썼다) 시각 — 에디터는 디스크 글을 1초 남짓 뒤에 받는다(감시 폴링). 그 갈아 끼움에서도 다시 묻게. */
  let pushedAt = 0
  const ask = async (): Promise<void> => {
    const my = ++seq
    const path = pathOf()
    const text = path ? (ed.getModel()?.getValue() ?? '') : ''
    if (!path || text.length > AI_LINES_MAX_BYTES) {
      any = false
      return void deco.clear()
    }
    const ranges = await window.ev.code.aiLines(path, text)
    if (my !== seq) return // 그사이 모델이 바뀌었거나 다시 물었다
    any = ranges.length > 0
    deco.set(
      ranges.map(([s, e]) => ({
        range: new monaco.Range(s, 1, e, 1),
        options: { isWholeLine: true, linesDecorationsClassName: 'ai-line-mark', linesDecorationsTooltip: t('code.aiLine') }
      }))
    )
  }
  const later = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void ask(), AI_LINES_DEBOUNCE_MS)
  }
  ed.onDidChangeModel(() => void ask())
  ed.onDidChangeModelContent(() => (any || Date.now() - pushedAt < RELOAD_WINDOW_MS) && later())
  const off = window.ev.code.onAiLinesChanged(({ path }) => {
    const mine = pathOf()
    if (!mine || !sameFile(mine, path)) return
    pushedAt = Date.now()
    later()
  })
  ed.onDidDispose(() => {
    if (timer) clearTimeout(timer)
    off()
  })
  void ask()
}

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
/** 경로 비교 — Windows 의 '\'·'/', 대소문자 차이를 무시한다(로컬 파일만 온다). */
const sameFile = (a: string, b: string): boolean => norm(a) === norm(b)
