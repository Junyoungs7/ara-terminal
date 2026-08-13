// compatible 프로바이더의 사용자 지정 base URL — 새 데이터 반출 표면(설계 W5 §보안). 렌더러(설정
// 화면의 즉석 검증 피드백)와 main(전송 직전 실제 방어선)이 **같은 함수**를 쓴다 — maskSecrets 와 같은
// 패턴: 규칙이 두 곳에서 갈라질 수 없다.
export type BaseUrlResult =
  | { ok: true; url: URL }
  | { ok: false; reason: 'invalid' | 'scheme' | 'credentials'; message: string }

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

// https:// 만 허용한다. 평문 http:// 는 loopback(로컬 LLM — Ollama/vLLM 등)일 때만 예외로 둔다.
// 그 외 스킴(file:·ftp:… )은 전부 거부. 자격증명이 URL 에 박힌 형태(https://user:pass@host)도 거부 —
// 저장되면 workspace.json 에 평문으로 앉는다(비밀은 vault 전용이 불변식이다).
export function validateBaseUrl(raw: string): BaseUrlResult {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid', message: 'URL 형식이 올바르지 않습니다' }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials', message: 'URL에 자격증명(user:pass@)을 포함할 수 없습니다' }
  }
  if (url.protocol === 'https:') return { ok: true, url }
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return { ok: true, url }
  return { ok: false, reason: 'scheme', message: 'https:// 만 허용됩니다(로컬 주소는 http:// 허용)' }
}

// base + suffix 를 안전하게 잇는다. 문자열 접합(`base + '/' + suffix`)은 base 끝의 슬래시 개수·쿼리
// 문자열 유무에 따라 경로가 뭉개지는 경우가 있다(경로 조작 방지 — 설계 §보안). base 는 이미
// validateBaseUrl 을 통과한 URL 이라는 전제.
export function joinUrl(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, '')
  const s = suffix.replace(/^\/+/, '')
  return `${b}/${s}`
}
