// F8 터미널 링크 라우팅 — planLink 가 §3.2 규칙의 유일한 진실이므로 표 기반으로 전부 덮는다.
// "OAuth 원클릭이 성립하는가"와 "로컬 셸이 어디로 가는가"가 여기서 갈린다.
import { describe, it, expect } from 'vitest'
import { localUrl, planLink } from '../src/shared/linkTarget'

describe('planLink — 로컬 셸', () => {
  /**
   * 2026-09-10 에 뒤집었다. 전에는 로컬 세션이면 무조건 OS 브라우저였는데, 그 근거가
   * **세션을 보고 URL 을 안 봤다** — 로컬 셸에서 찍히는 주소가 늘 내 PC 인 것이 아니다.
   * 준영님 제보의 반례가 사내 배포 서버였다(`192.168.100.56:8899`).
   */
  it('★ 로컬 셸의 http/https 도 아라 브라우저로 간다 — 사내 주소가 반례였다', () => {
    expect(planLink('http://192.168.100.56:8899/', false)).toEqual({
      kind: 'inApp',
      url: 'http://192.168.100.56:8899/'
    })
    expect(planLink('https://github.com/anthropics', false).kind).toBe('inApp')
  })

  it('로컬의 localhost 도 같다 — 포워딩은 안 탄다(내 PC 라 터널이 필요 없다)', () => {
    expect(planLink('http://localhost:3000/', false).kind).toBe('inApp')
    expect(planLink('http://127.0.0.1:8765/callback', false).kind).toBe('inApp')
  })

  it('★ http/https 가 아니면 로컬도 그대로 바깥으로 — 스킴 게이트가 최종 판정한다', () => {
    expect(planLink('mailto:a@b.c', false).kind).toBe('external')
    expect(planLink('file:///etc/passwd', false).kind).toBe('external')
  })

  it('★ 규칙이 SSH 와 같아졌다 — 어디서 눌렀든 Ctrl+클릭은 아라 브라우저다', () => {
    // Ctrl+Alt+클릭(OS 브라우저)은 planLink 를 아예 안 거친다 — MainArea.openLink 의 external 분기.
    for (const u of ['https://example.com/', 'http://10.0.0.5:8080/x']) {
      expect(planLink(u, false).kind).toBe(planLink(u, true).kind)
    }
  })
})

describe('planLink — SSH 세션 loopback', () => {
  const cases: [string, number][] = [
    ['http://localhost:3000/', 3000],
    ['http://127.0.0.1:8080/path?q=1', 8080],
    ['http://[::1]:5173/', 5173],
    ['https://localhost:8443/admin', 8443],
    // 포트가 생략되면 스킴 기본값이 포워딩 대상이다.
    ['http://localhost/', 80],
    ['https://localhost/', 443],
    // L5(W2 보안 리뷰): 개발 서버가 흔히 찍는 형태도 loopback 이어야 한다 — 안 그러면 F8 이
    // 조용히 동작 안 하는 것처럼 보인다.
    ['http://0.0.0.0:3000/', 3000],
    ['http://[::ffff:127.0.0.1]:9000/', 9000],
    ['http://localhost.:4000/', 4000]
  ]
  for (const [url, port] of cases) {
    it(`${url} → loopback:${port}`, () => {
      expect(planLink(url, true)).toEqual({ kind: 'loopback', port, url })
    })
  }
})

describe('planLink — OAuth 콜백', () => {
  it('인코딩된 redirect_uri 의 loopback 포트를 집어낸다', () => {
    const url =
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A8765%2Fcallback&scope=email'
    expect(planLink(url, true)).toEqual({ kind: 'oauth', port: 8765, url })
  })

  it('인코딩되지 않은 redirect_uri 도 같은 결과다', () => {
    const url = 'https://example.com/auth?redirect_uri=http://127.0.0.1:9999/cb'
    expect(planLink(url, true)).toEqual({ kind: 'oauth', port: 9999, url })
  })

  it('redirect_url · callback 파라미터 이름도 받는다', () => {
    expect(planLink('https://a.example/x?redirect_url=http://localhost:1234/', true).kind).toBe('oauth')
    expect(planLink('https://a.example/x?callback=http://localhost:1234/', true).kind).toBe('oauth')
  })

  // 2026-08-22 준영님 제보 6번: 원격 gemini 로그인 링크가 내장 브라우저로 안 갔다.
  // 판단 기준은 파라미터 **이름**이 아니라 **값이 loopback URL 인가**다 — CLI 마다 이름이 다르다.
  it('이름을 모르는 파라미터라도 값이 loopback 이면 OAuth 다', () => {
    expect(planLink('https://accounts.google.com/o/oauth2/v2/auth?continue=http://localhost:45289/cb', true)).toEqual({
      kind: 'oauth',
      port: 45289,
      url: 'https://accounts.google.com/o/oauth2/v2/auth?continue=http://localhost:45289/cb'
    })
    expect(planLink('https://a.example/x?return_to=http%3A%2F%2F127.0.0.1%3A7777%2Fdone', true).kind).toBe('oauth')
  })

  it('이름 있는 콜백이 먼저다 — 여러 개면 redirect_uri 의 포트를 쓴다', () => {
    const url = 'https://a.example/x?state=http://localhost:1111/&redirect_uri=http://localhost:2222/cb'
    expect(planLink(url, true)).toEqual({ kind: 'oauth', port: 2222, url })
  })

  // 2026-08-22: 포워딩이 **필요 없다**는 판정일 뿐, OS 브라우저로 나가라는 뜻이 아니다.
  // SSH 세션의 링크는 내장 브라우저로 간다(아래 'SSH 세션의 보통 링크' 묶음 참고).
  it('콜백이 loopback 이 아니면 OAuth 가 아니다 — 터널 없이 내장 브라우저로', () => {
    expect(planLink('https://a.example/x?redirect_uri=https://app.example.com/cb', true).kind).toBe('inApp')
  })

  it('콜백 값이 URL 이 아니면 무시한다', () => {
    expect(planLink('https://a.example/x?redirect_uri=not-a-url', true).kind).toBe('inApp')
  })
})

// 2026-08-22 준영님 제보 16번: "gemini 로그인 시 Ctrl+클릭하면 내 로컬 브라우저에서 뜨는데
// 아라 브라우저에서 떠야 한다. 그래야 이 세션이랑 바로 연결되게."
describe('planLink — SSH 세션의 보통 링크는 내장 브라우저', () => {
  it('포워딩이 필요 없는 https 도 내장 브라우저로 간다', () => {
    expect(planLink('https://github.com/anthropics', true).kind).toBe('inApp')
    expect(planLink('https://accounts.google.com/signin', true).kind).toBe('inApp')
  })

  it('http/https 가 아니면 판단하지 않는다(스킴 게이트가 최종 판정)', () => {
    expect(planLink('mailto:a@b.c', true).kind).toBe('external')
    expect(planLink('file:///etc/passwd', true).kind).toBe('external')
  })
})

describe('planLink — 그 외', () => {

  it('http/https 가 아닌 스킴은 판단하지 않는다(스킴 게이트가 최종 판정)', () => {
    expect(planLink('file:///C:/Windows/win.ini', true).kind).toBe('external')
    expect(planLink('ms-msdt:/id', true).kind).toBe('external')
    expect(planLink('slack://open', true).kind).toBe('external')
  })

  it('파싱 불가 문자열도 크래시 없이 external', () => {
    expect(planLink('not a url', true)).toEqual({ kind: 'external', url: 'not a url' })
  })
})

describe('localUrl — 포워딩이 열린 뒤의 실제 주소', () => {
  it('loopback 은 호스트·포트만 터널 입구로 갈아 끼운다(경로·쿼리 보존)', () => {
    const plan = planLink('http://localhost:3000/app?x=1#top', true)
    expect(localUrl(plan, 51234)).toBe('http://localhost:51234/app?x=1#top')
  })

  it('IPv6 loopback 도 같은 규칙', () => {
    const plan = planLink('http://[::1]:5173/', true)
    expect(localUrl(plan, 5173)).toBe('http://localhost:5173/')
  })

  it('OAuth 는 원본 URL 그대로다 — 구글이 리다이렉트할 곳이 곧 터널 입구다', () => {
    const url = 'https://accounts.google.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8765%2Fcb'
    expect(localUrl(planLink(url, true), 8765)).toBe(url)
  })

  it('external 은 손대지 않는다', () => {
    expect(localUrl(planLink('https://github.com/', true), 1)).toBe('https://github.com/')
  })
})
