// 3차 R2-B shiki/TextMate 언어 6종 — stablyai/orca @ec112c6b01 (MIT) src/renderer/src/lib/monaco-languages/register-nim.ts 그대로(가져오는 경로만). 파일을 열 때만 불린다.
import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const NIM_LANGUAGE_ID = 'nim'

export const nimLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '#',
    blockComment: ['#[', ']#']
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
}

export async function loadNimTextMateGrammar(): Promise<LanguageRegistration> {
  // Why: Nim highlighting uses the maintained VS Code TextMate grammar from
  // nim-lang/vscode-nim (MIT; see textmate-grammars/nim-LICENSE.txt).
  const grammarModule = await import('./textmate-grammars/nim.tmLanguage.json')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TextMate injects the $self/$base repository entries a registration's type requires; real tokenization tests validate this vendored JSON.
  const grammar = grammarModule.default as unknown as LanguageRegistration
  return { ...grammar, name: NIM_LANGUAGE_ID }
}

export function registerNimLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: NIM_LANGUAGE_ID,
      extensions: ['.nim', '.nims', '.nimble'],
      aliases: ['Nim', 'nim']
    },
    configuration: nimLanguageConfiguration,
    loadGrammar: loadNimTextMateGrammar
  })
}
