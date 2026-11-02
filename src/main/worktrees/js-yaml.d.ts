// js-yaml 4 — electron-updater 가 이미 끌어온 패키지(새 의존성 아님). 타입 패키지가 없어 쓰는 만큼만 적는다.
declare module 'js-yaml' {
  export function load(str: string, opts?: { filename?: string; json?: boolean }): unknown
}
