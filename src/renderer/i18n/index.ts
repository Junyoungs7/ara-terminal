// i18n 로더. 지금은 ko 하나뿐이라 정적 로드가 전부다 —
// 로케일이 늘면 여기에 번들 맵과 전환 함수를 다시 세운다(AUDIT-R5 에서 안 오는 다국어 발판을
// 걷어냈다: setLocale·getLocale 은 참조가 0이었고 Locale 은 멤버 하나짜리 타입이었다).
import ko from './ko.json'

export type Messages = Record<string, string>

const messages: Messages = ko

// 키 미존재 시 키 자체를 반환(개발 중 누락 가시화).
export function t(key: string): string {
  return messages[key] ?? key
}
