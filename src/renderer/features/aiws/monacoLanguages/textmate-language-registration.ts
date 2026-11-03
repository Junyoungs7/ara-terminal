// 3차 R2-B shiki/TextMate 언어 6종 — stablyai/orca @ec112c6b01 (MIT) src/renderer/src/lib/monaco-languages/textmate-language-registration.ts 그대로(가져오는 경로만). 파일을 열 때만 불린다.
import type * as Monaco from 'monaco-editor'
import type {
  createTextMateTokensProvider as createTextMateTokensProviderType,
  TextMateGrammarLoader
} from './textmate-token-provider'

type MonacoModule = Pick<typeof Monaco, 'languages'>
type TextMateTokensProvider = Monaco.languages.TokensProvider
type TextMateTokenProviderModule = {
  createTextMateTokensProvider: typeof createTextMateTokensProviderType
}

export type TextMateLanguageRegistration = {
  language: Monaco.languages.ILanguageExtensionPoint
  configuration?: Monaco.languages.LanguageConfiguration
  loadGrammar: TextMateGrammarLoader
  mapTokenScopes?: (scopes: readonly string[]) => string
  loadProviderModule?: () => Promise<TextMateTokenProviderModule>
}

function loadDefaultProviderModule(): Promise<TextMateTokenProviderModule> {
  return import('./textmate-token-provider')
}

export function registerTextMateLanguage(
  monaco: MonacoModule,
  registration: TextMateLanguageRegistration
): void {
  const languageAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === registration.language.id)
  if (languageAlreadyRegistered) {
    return
  }

  monaco.languages.register(registration.language)
  if (registration.configuration) {
    monaco.languages.setLanguageConfiguration(registration.language.id, registration.configuration)
  }

  let tokensProviderPromise: Promise<TextMateTokensProvider> | undefined
  monaco.languages.registerTokensProviderFactory(registration.language.id, {
    create: () => {
      // Basic tokenization never fires rich-feature onLanguage; load read-only Nim through basic language features.
      tokensProviderPromise ??= (
        registration.loadProviderModule ?? loadDefaultProviderModule
      )().then(({ createTextMateTokensProvider }) =>
        createTextMateTokensProvider({
          loadGrammar: registration.loadGrammar,
          ...(registration.mapTokenScopes ? { mapTokenScopes: registration.mapTokenScopes } : {})
        })
      )
      return tokensProviderPromise
    }
  })
}
