// 3차 R2-B shiki/TextMate 언어 6종 — stablyai/orca @ec112c6b01 (MIT) src/renderer/src/lib/monaco-languages/register-lean.ts 그대로(가져오는 경로만). 파일을 열 때만 불린다.
import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

export async function loadLeanTextMateGrammar(): Promise<LanguageRegistration> {
  const { default: grammars } = await import('shiki/langs/lean.mjs')
  const grammar = grammars[0]
  const repository = Object.assign({}, grammar.repository)
  // TextMate drops this rule when its only pattern includes the unbundled Lean Markdown grammar.
  repository.dashComment = { ...repository.dashComment, patterns: [] }
  return { ...grammar, repository }
}

export function registerLeanLanguage(monaco: typeof Monaco): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: 'lean',
      extensions: ['.lean'],
      aliases: ['Lean 4', 'Lean', 'lean', 'lean4']
    },
    loadGrammar: loadLeanTextMateGrammar
  })
}
