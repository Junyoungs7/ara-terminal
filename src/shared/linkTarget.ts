// F8 터미널 링크 라우팅 — 순수 함수(단위 테스트 대상). Ctrl+클릭한 URL 을 어디로 보낼지 정한다.
//
// 왜 필요한가: SSH 세션에서 원격이 찍은 `http://localhost:8765` 의 localhost 는 **원격의** localhost 다.
// 지금까지처럼 내 PC 기본 브라우저로 열면 내 PC 의 8765 를 보게 되어 아무것도 없거나 엉뚱한 것이 뜬다.
// 그래서 loopback 주소는 포워딩을 만든 뒤 내장 브라우저로 보내고, 나머지는 예전 그대로 OS 브라우저로 보낸다.
//
// 판단은 여기 한 곳에만 있다. 두 번째 화이트리스트를 만들지 않는다(스킴 게이트는 isSafeExternal 단일 소스).
export type LinkPlan =
  // 원격 localhost 직행 → 포워딩 후 내장 브라우저
  | { kind: 'loopback'; port: number; url: string }
  // 외부 https + loopback 콜백(OAuth) → 콜백 포트를 그 번호 그대로 포워딩한 뒤 원본 URL 을 연다
  | { kind: 'oauth'; port: number; url: string }
  // 그 외 → 기존 app:openExternal (OS 기본 브라우저)
  | { kind: 'external'; url: string }

// URL.hostname 이 돌려주는 형태 그대로 비교한다(IPv6 는 대괄호가 붙어 온다).
// 0.0.0.0 · IPv4-mapped IPv6(::ffff:127.0.0.1) 도 얹는다 — 개발 서버가 흔히 0.0.0.0 을 찍는데
// (W2 보안 리뷰 L5) 그걸 external 로 분류하면 F8 이 조용히 동작 안 하는 것처럼 보인다.
const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '::1',
  // URL.hostname 은 IPv4-mapped IPv6 을 압축 16진 표기로 정규화한다
  // (`::ffff:127.0.0.1` → `::ffff:7f00:1`) — 사람이 쓰는 표기가 아니라 실제 반환값을 넣는다.
  '[::ffff:7f00:1]',
  '::ffff:7f00:1'
])
// FQDN 트레일링 닷(`localhost.`)도 loopback 이다 — 마지막 점만 떼고 비교한다.
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
  return LOOPBACK_HOSTS.has(h)
}
// OAuth 콜백 주소가 실려 오는 쿼리 파라미터 이름. 값이 loopback URL 이면 그 포트가 터널 대상이다.
const CALLBACK_PARAMS = ['redirect_uri', 'redirect_url', 'callback']

function isHttp(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:'
}

// 포트가 생략된 URL 의 실제 포트(http=80 / https=443). 포워딩은 번호가 있어야 만들 수 있다.
function portOf(u: URL): number {
  if (u.port) return Number(u.port)
  return u.protocol === 'https:' ? 443 : 80
}

function loopbackPort(value: string): number | null {
  try {
    const u = new URL(value)
    if (!isHttp(u) || !isLoopbackHost(u.hostname)) return null
    return portOf(u)
  } catch {
    return null
  }
}

export function planLink(url: string, isSsh: boolean): LinkPlan {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { kind: 'external', url } // 파싱 불가 → 기존 경로(거기서 스킴 게이트가 다시 막는다)
  }
  // 로컬 셸의 localhost 는 진짜 내 PC 다. 현행 동작을 그대로 둔다.
  if (!isSsh) return { kind: 'external', url }
  // http/https 가 아니면 판단하지 않는다 — openExternal 의 스킴 게이트가 최종 판정한다.
  if (!isHttp(u)) return { kind: 'external', url }
  if (isLoopbackHost(u.hostname)) return { kind: 'loopback', port: portOf(u), url }
  // 이 규칙이 원클릭 OAuth 를 성립시킨다: 구글로 가는 URL 안에 원격의 콜백 주소가 박혀 있다.
  for (const name of CALLBACK_PARAMS) {
    const raw = u.searchParams.get(name)
    if (!raw) continue
    const port = loopbackPort(raw)
    if (port !== null) return { kind: 'oauth', port, url }
  }
  // 이름을 모르는 콜백 파라미터 — **값 전체를 훑는다**(2026-08-22 준영님 제보 6번: 원격 gemini
  // 로그인 링크가 내장 브라우저로 안 갔다). CLI 마다 이름이 다르고(redirect_uri·callback·
  // return_to·continue…) 그 목록을 다 맞힐 수는 없다. 판단 기준은 이름이 아니라 **값이 loopback
  // URL 인가**여야 한다.
  //
  // 표면이 넓어지지 않는다: oauth 분기는 확인 다이얼로그(포트·오리진을 보여 준다)를 거치고,
  // 포워딩 목적지는 어차피 **원격의 127.0.0.1 고정**이다 — 이 값으로 임의 호스트에 갈 수 없다.
  for (const [, raw] of u.searchParams) {
    const port = loopbackPort(raw)
    if (port !== null) return { kind: 'oauth', port, url }
  }
  return { kind: 'external', url }
}

// 포워딩이 열린 뒤 내장 브라우저에 넘길 실제 주소.
//  · loopback: 호스트·포트만 터널 입구로 갈아 끼운다(경로·쿼리·해시는 원본 그대로).
//  · oauth: 원본 URL 그대로 — 구글이 리다이렉트해 줄 곳이 바로 그 터널 입구다.
// 스킴은 바꾸지 않는다. 터널은 투명한 TCP 라 원격이 TLS 를 말하면 입구도 TLS 다.
export function localUrl(plan: LinkPlan, localPort: number): string {
  if (plan.kind !== 'loopback') return plan.url
  try {
    const u = new URL(plan.url)
    u.hostname = 'localhost'
    u.port = String(localPort)
    return u.toString()
  } catch {
    return plan.url
  }
}
