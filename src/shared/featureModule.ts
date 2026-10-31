// 기능 끼우는 틀(M0 0-4)의 계약. 규칙과 이유는 docs/feature-module.md.
// 묶음 13 플러그인 시스템이 같은 모양을 쓴다 — 여기 필드를 바꾸면 그쪽 계약도 바뀐다.

/** 기능이 바깥 화면에 끼워 넣는 것. main(메뉴)·renderer(설정) 양쪽이 읽으므로 shared 에 둔다. */
export type FeatureContrib = {
  id: string
  /** 설정 화면에 붙일 섹션. labelKey 는 i18n 키. */
  settings: { section: string; labelKey: string }[]
  /** 메뉴바에 붙일 명령. command 는 메뉴 명령 id, labelKey 는 i18n 키. */
  menu: { command: string; labelKey: string }[]
}
