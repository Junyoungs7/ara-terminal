// M12 R2 — monaco-editor 의 언어 정의 js 는 타입이 없다(Orca src/renderer/src/env.d.ts 와 같은 선언). CUDA 는 C++, Quarto 는 Markdown 위에 얹는다.
declare module 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js' {
  export const conf: import('monaco-editor').languages.LanguageConfiguration
  export const language: import('monaco-editor').languages.IMonarchLanguage
}
declare module 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js' {
  export const conf: import('monaco-editor').languages.LanguageConfiguration
  export const language: import('monaco-editor').languages.IMonarchLanguage
}
