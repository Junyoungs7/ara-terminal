// 3차 R2-B shiki/TextMate 언어 6종 — stablyai/orca @ec112c6b01 (MIT) src/renderer/src/lib/monaco-languages/register-cmake.ts 그대로(가져오는 경로만). 파일을 열 때만 불린다.
import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

// Why: stock Monaco themes style none of the grammar's storage/entity/argument scopes.
function mapCMakeTokenScopes(scopes: readonly string[]): string {
  const scope = scopes.at(-1) ?? 'source.cmake'
  if (scope.startsWith('constant.character.escape')) {
    return 'string.escape.cmake'
  }
  if (scope.startsWith('storage.')) {
    return 'variable.cmake'
  }
  if (scope.startsWith('entity.')) {
    return 'type.cmake'
  }
  if (scope.startsWith('argument.')) {
    return 'string.cmake'
  }
  return scope
}

async function loadCMakeTextMateGrammar(): Promise<LanguageRegistration> {
  const { default: grammars } = await import('shiki/langs/cmake.mjs')
  return grammars[0]
}

export function registerCMakeLanguage(monaco: Pick<typeof Monaco, 'languages'>): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: 'cmake',
      filenames: ['CMakeLists.txt'],
      aliases: ['CMake', 'cmake']
    },
    configuration: {
      comments: { lineComment: '#', blockComment: ['#[[', ']]'] },
      brackets: [['(', ')']],
      autoClosingPairs: [
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string', 'comment'] }
      ]
    },
    loadGrammar: loadCMakeTextMateGrammar,
    mapTokenScopes: mapCMakeTokenScopes
  })
}
