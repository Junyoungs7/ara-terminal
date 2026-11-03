// 3차 R2-B shiki/TextMate 언어 6종 — stablyai/orca @ec112c6b01 (MIT) src/renderer/src/lib/monaco-languages/register-typst.ts 그대로(가져오는 경로만). 파일을 열 때만 불린다.
import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const TYPST_LANGUAGE_ID = 'typst'

export const typstLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/']
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
    { open: '"', close: '"' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' }
  ]
}

export async function loadTypstTextMateGrammar(): Promise<LanguageRegistration> {
  // Lazy upstream grammar; provenance and Apache-2.0 license are in typst-LICENSE.txt.
  const grammarModule = await import('./textmate-grammars/typst.tmLanguage.json')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TextMate injects the $self/$base repository entries a registration's type requires; real tokenization tests validate this vendored JSON.
  const grammar = grammarModule.default as unknown as LanguageRegistration
  return { ...grammar, name: TYPST_LANGUAGE_ID }
}

export function registerTypstLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: TYPST_LANGUAGE_ID,
      extensions: ['.typ'],
      aliases: ['Typst', 'typst']
    },
    configuration: typstLanguageConfiguration,
    loadGrammar: loadTypstTextMateGrammar
  })
}
