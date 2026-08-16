// compatible 프로바이더의 사용자 지정 base URL — 새 데이터 반출 표면(설계 W5 §보안). 렌더러(설정
// 화면의 즉석 검증 피드백)와 main(전송 직전 실제 방어선)이 **같은 함수**를 쓴다 — maskSecrets 와 같은
// 패턴: 규칙이 두 곳에서 갈라질 수 없다.
export type BaseUrlResult =
  | { ok: true; url: URL }
  | { ok: false; reason: 'invalid' | 'scheme' | 'credentials'; message: string }

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * 평문 http 를 허용해도 되는 호스트인가(순수 — 단위 테스트 대상).
 *
 * 2026-08-16 준영님 요청으로 **사설망**까지 넓혔다: "사내에서는 사내 서버의 vLLM 에 연결하여 쓸 수
 * 있는 구조". 사내 추론 서버는 대개 `http://192.168.x.x:8000/v1` 이고 사내용 인증서가 없다.
 * 예전 규칙(loopback 만)으로는 **저장 자체가 안 됐다.**
 *
 * 넓힌 범위는 딱 여기까지다:
 *  · loopback — 예전 그대로(로컬 Ollama/vLLM)
 *  · RFC1918 사설 IPv4 — 10/8 · 172.16/12 · 192.168/16
 *  · **점 없는 단일 이름**(`ai-server`) — 공개 DNS 는 TLD 를 요구하므로 공개 호스트가 될 수 없다
 *
 * 점이 든 이름(`ai.example.com`)은 평문으로 **허용하지 않는다.** 사내 FQDN 인지 바깥인지 검증 시점에
 * 알 방법이 없고, 허용하면 `http://attacker.com/v1` 이 그대로 통과한다 — 이 값은 터미널 출력·파일
 * 경로가 실려 나가는 **반출 표면**이다. 사내 FQDN 을 쓰셔야 하면 IP 를 넣거나 https 를 붙이면 된다.
 *
 * 남는 위험: 사내망 안에서는 평문이라 같은 망에서 엿볼 수 있다. 사내 모델과 사내 클라이언트 사이라
 * 통상 감수하는 범위지만, 규칙을 넓힌 것 자체는 사실이다(준영님 확인 2026-08-16).
 */
export function isPlainHttpAllowed(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true
  const m = IPV4.exec(hostname)
  if (m) {
    const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    if (o.some((n) => n > 255)) return false
    if (o[0] === 10) return true
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true
    return o[0] === 192 && o[1] === 168
  }
  return hostname.length > 0 && !hostname.includes('.')
}

// https:// 는 어디든 허용. 평문 http:// 는 **사설망만**(위 isPlainHttpAllowed).
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
  if (url.protocol === 'http:' && isPlainHttpAllowed(url.hostname)) return { ok: true, url }
  return {
    ok: false,
    reason: 'scheme',
    message: 'https:// 만 허용됩니다(사내·로컬 주소는 http:// 허용 — 예: http://192.168.0.10:8000/v1)'
  }
}

// base + suffix 를 안전하게 잇는다. 문자열 접합(`base + '/' + suffix`)은 base 끝의 슬래시 개수·쿼리
// 문자열 유무에 따라 경로가 뭉개지는 경우가 있다(경로 조작 방지 — 설계 §보안). base 는 이미
// validateBaseUrl 을 통과한 URL 이라는 전제.
export function joinUrl(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, '')
  const s = suffix.replace(/^\/+/, '')
  return `${b}/${s}`
}
