// i18n 로더 골격 (계획서 F1: 구조만 준비). 현재는 ko 기본 번들만 정적 로드.
// 로케일 추가 시 loaders 맵에 동적 import를 등록한다.
import ko from './ko.json'

export type Locale = 'ko'
export type Messages = Record<string, string>

const bundles: Record<Locale, Messages> = { ko }

let current: Locale = 'ko'
let messages: Messages = bundles.ko

export function setLocale(locale: Locale): void {
  current = locale
  messages = bundles[locale] ?? bundles.ko
}

export function getLocale(): Locale {
  return current
}

// 키 미존재 시 키 자체를 반환(개발 중 누락 가시화).
export function t(key: string): string {
  return messages[key] ?? key
}
