// 터미널 폰트 후보 — 목업 variant-final-2 pickFont 스택 그대로(전부 resources/fonts 번들).
// key(term) 는 workspace.json ui.font.term 에 저장되는 안정 식별자.
export type FontKey = 'Nanum Gothic Coding' | 'D2Coding' | 'JetBrains Mono'

export type FontOption = {
  key: FontKey
  label: string
  tag: string
  tagSys?: boolean
  desc: string
  // xterm/CSS fontFamily 스택. 한글 폴백을 항상 포함해 무결 렌더 보장.
  stack: string
}

// primary=나눔고딕코딩, 폴백=D2Coding, 라틴=JetBrains Mono(+한글 폴백). design-system §2.1.
export const FONT_OPTIONS: FontOption[] = [
  {
    key: 'Nanum Gothic Coding',
    label: '나눔고딕코딩',
    tag: '권장',
    desc: '한글 고정폭 · 13px 선명 · 번들(OFL)',
    stack: "'Nanum Gothic Coding', 'D2Coding', monospace"
  },
  {
    key: 'D2Coding',
    label: 'D2Coding',
    tag: '폴백',
    desc: '한글 고정폭 · 리거처 지원 · 번들(OFL)',
    stack: "'D2Coding', 'Nanum Gothic Coding', monospace"
  },
  {
    key: 'JetBrains Mono',
    label: 'JetBrains Mono',
    tag: '라틴',
    tagSys: true,
    desc: '라틴 리거처 특화 · 한글은 나눔고딕코딩 폴백',
    stack: "'JetBrains Mono', 'Nanum Gothic Coding', monospace"
  }
]

// UI-font4(2026-08-05): 'KR System' — 한글 음절/자모 unicode-range 로 국한된 @font-face
// (styles/fonts.css, src: local() 체인 — Malgun Gothic/Apple SD Gothic Neo/Noto Sans CJK KR).
// 라틴 코드포인트는 이 range 밖이라 항상 다음 폰트(위 opt.stack 의 1순위)로 그대로 폴백한다.
// 근거·픽셀 비교: agent_talk/UI-font4-done.md. 기본 on, 설정에서 끄면 이전 동작(번들 폰트만)으로 복귀.
const KR_SYSTEM_FACE = "'KR System'"

// FINISH-M4(2026-08-28): 'ARA Nerd Font Symbols' — 사설 사용 영역(PUA)에만 적용되는 @font-face
// (styles/fonts.css, unicode-range U+E000-F8FF · U+F0000-FFFFD · U+100000-10FFFD).
// **설정과 무관하게 항상 붙는다**: 서버 쪽 프롬프트(starship·powerlevel10k·oh-my-zsh)와 lsd/eza 가
// 찍는 아이콘·powerline 구분자가 그 구간에 있는데 번들 폰트 셋 중 어느 것도 갖고 있지 않아서
// 두부(□)로 나온다. 사용자가 무슨 글꼴을 고르든 이 결핍은 같으므로 선택지가 아니라 상수다.
// unicode-range 가 좁아 순서는 결과를 바꾸지 않지만(다른 폰트엔 그 글리프가 없다) 심볼 폰트를
// 맨 앞에 두는 것이 관용이고, 읽는 사람이 "항상 붙는다"를 바로 알아본다.
const NERD_SYMBOLS_FACE = "'ARA Nerd Font Symbols'"

export function stackFor(term: string, krSystemFallback = true): string {
  const opt = FONT_OPTIONS.find((o) => o.key === term) ?? FONT_OPTIONS[0]
  const base = krSystemFallback ? `${KR_SYSTEM_FACE}, ${opt.stack}` : opt.stack
  return `${NERD_SYMBOLS_FACE}, ${base}`
}
