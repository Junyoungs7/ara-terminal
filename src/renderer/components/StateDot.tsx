import { t } from '../i18n'
import type { SessionState } from '../store/sessionState'

/**
 * 세션 점 — **한 가지 뜻**만 그린다(#166, store/sessionState.ts 가 그 뜻을 정의한다).
 *
 * 자리마다 크기·여백이 달라 바깥 클래스(`tdot`·`pdot`·`mini-dot`)는 받고, **색과 툴팁은 여기서**
 * 정한다: 세 자리가 각자 인라인으로 칠하던 것이 곧 "같은 점이 세 가지 뜻"의 원인이었다.
 *
 * 툴팁이 **필수**인 이유는 §6("상태는 색 + 형태로 이중 표현")이다. 6px 원에 형태를 더 넣을
 * 자리가 없으므로(테두리·점선은 그 크기에서 뭉갠다 — AiBenchTree 의 `.unk` 주석이 같은 판단)
 * 글자가 그 몫을 진다.
 */
export function StateDot({ cls, state }: { cls: string; state: SessionState }): JSX.Element {
  return <span className={`${cls} sdot ${state}`} title={t(`session.st.${state}`)} />
}
