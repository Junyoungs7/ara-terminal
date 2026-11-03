// 3차 R2-B shiki/TextMate 언어 6종 — stablyai/orca @ec112c6b01 (MIT) src/renderer/src/lib/monaco-languages/register-zig.ts 그대로(가져오는 경로만). 파일을 열 때만 불린다.
import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

function mapZigTokenScopes(scopes: readonly string[]): string {
  const scope = scopes.at(-1) ?? 'source.zig'
  if (scope.startsWith('constant.numeric.')) {
    return 'number.zig'
  }
  if (scope.startsWith('constant.character.escape.')) {
    return 'string.escape.zig'
  }
  if (scope.startsWith('storage.type.')) {
    return 'keyword.zig'
  }
  if (scope.startsWith('keyword.type.')) {
    return 'type.zig'
  }
  if (scope.startsWith('support.function.') || scope.startsWith('entity.name.')) {
    return 'type.zig'
  }
  return scope
}

export async function loadZigTextMateGrammar(): Promise<LanguageRegistration> {
  const { default: grammars } = await import('shiki/langs/zig.mjs')
  return grammars[0]
}

export function registerZigLanguage(monaco: Pick<typeof Monaco, 'languages'>): void {
  registerTextMateLanguage(monaco, {
    language: { id: 'zig', extensions: ['.zig'], aliases: ['Zig', 'zig'] },
    configuration: {
      comments: { lineComment: '//' },
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')']
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string', 'comment'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] }
      ]
    },
    loadGrammar: loadZigTextMateGrammar,
    mapTokenScopes: mapZigTokenScopes
  })
}
