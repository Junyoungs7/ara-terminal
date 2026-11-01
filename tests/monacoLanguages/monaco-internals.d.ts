// M12 R2 — Orca 시험 하네스가 쓰는 monaco 내부 모듈(타입 없음). 시험에서만.
declare module 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js' {
  export const compile: (languageId: string, json: unknown) => unknown
}
declare module 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js' {
  export const MonarchTokenizer: new (...args: any[]) => any
}
