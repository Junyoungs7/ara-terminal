// #192 쿠버네티스 — kubectl 명령 조립. 이 파일이 지키는 것은 셋이다.
//
// 1) **네임스페이스가 명령줄에 그대로 흘러들지 않는가.** 셀렉트가 고른 값이든 아라가 보낸 값이든
//    같은 관문을 지난다(remoteCatalog.ts 머리주석의 선).
// 2) **`k8s.exec` 가 표에 없는가.** 준영님 결정(2026-09-16)의 자물쇠다 — 아래 그 블록 참고.
// 3) **권한 올리기가 여전히 승인을 요구하는가.** k8s.list 는 `write` 가 없는 읽기 명령이라,
//    isPrivileged 에서 빠지면 아라가 다이얼로그 없이 원격 root 를 돌린다(2026-08-28 감사).
//
// 실서버에는 붙지 않는다 — 조립된 문자열만 본다.
import { describe, it, expect } from 'vitest'
import {
  COMMANDS,
  K8S_DEFAULT_NS,
  buildCommand,
  buildK8sExec,
  isCmdId,
  isPrivileged,
  validNsName,
  validPodName
} from '../src/shared/remoteCatalog'

describe('k8s.list — 네임스페이스 고르기', () => {
  const cmd = (args: unknown): string | null => buildCommand('k8s.list', args)?.cmd ?? null

  it('★ 인자가 없으면 기본 -n vgt-erp (준영님 확정) — 컨텍스트의 기본에 맡기지 않는다', () => {
    expect(cmd(null)).toContain(`-n ${K8S_DEFAULT_NS}`)
    expect(cmd({})).toContain('-n vgt-erp')
    expect(cmd(null)).toContain('kubectl get pods -n vgt-erp -o json')
  })

  /**
   * ★ [전체]는 `-A` 다. `-n` 을 **그냥 빼는 것이 아니다** — 빼면 kubectl 이 현재 컨텍스트의
   * 기본 네임스페이스 하나만 본다. 그건 "전체"가 아니라 "어딘지 모를 한 군데"라, 사람이
   * [전체]를 골랐는데 파드가 몇 개만 뜨는 조용한 거짓말이 된다.
   */
  it('★ ns:"*" 는 -A 가 되고 -n 은 사라진다', () => {
    const c = cmd({ ns: '*' })!
    expect(c).toContain('kubectl get pods -A -o json')
    // `-n` 이 통째로 사라졌는가. (`sudo -n` 의 `-n` 은 권한 올리기 조각의 것이라 남는다.)
    expect(c).not.toContain('get pods -n')
  })

  it('고른 네임스페이스는 그대로 -n 에 들어간다', () => {
    expect(cmd({ ns: 'vgt-web' })).toContain('-n vgt-web')
    expect(cmd({ ns: 'kube-system' })).toContain('-n kube-system')
  })

  it('★ 셸에 흘러들 수 있는 값은 명령을 조립조차 하지 않는다(null)', () => {
    for (const ns of [
      'a; rm -rf /',
      '../x',
      'A', // 대문자는 RFC1123 이 아니다
      'a'.repeat(64), // 63자 초과
      'ns name', // 공백
      '$(id)',
      '`id`',
      'a|b',
      '-leading',
      'trailing-',
      '',
      42,
      null
    ]) {
      expect(cmd({ ns }), String(ns)).toBeNull()
    }
  })

  it('kubectl 이 없는 서버는 none 표시를 돌려준다 — "파드 0개"와 구분돼야 한다', () => {
    const c = cmd(null)!
    expect(c).toContain('command -v kubectl')
    expect(c).toContain('ARA-CTR none')
  })
})

describe('k8s.describe · k8s.yaml — 파드 하나', () => {
  const pod = 'api-7d9f4c6b8-x2kqp'

  it('네임스페이스와 파드 이름이 그대로 붙는다(인용 없이 안전한 값만 통과한다)', () => {
    expect(buildCommand('k8s.describe', { ns: 'vgt-erp', pod })!.cmd).toBe(
      `kubectl describe pod ${pod} -n vgt-erp 2>&1`
    )
    expect(buildCommand('k8s.yaml', { ns: 'vgt-erp', pod })!.cmd).toBe(
      `kubectl get pod ${pod} -n vgt-erp -o yaml 2>&1`
    )
  })

  it('★ "전체"는 거절한다 — 파드 하나를 보는 명령에 그런 대상은 없다', () => {
    expect(buildCommand('k8s.describe', { ns: '*', pod })).toBeNull()
    expect(buildCommand('k8s.yaml', { ns: '*', pod })).toBeNull()
  })

  it('★ 파드 이름도 같은 관문을 지난다', () => {
    for (const bad of ['a; id', '../etc', 'Pod', 'p'.repeat(254), '', undefined]) {
      expect(buildCommand('k8s.describe', { ns: 'vgt-erp', pod: bad }), String(bad)).toBeNull()
    }
    // 네임스페이스가 없으면 기본값으로 때우지 않는다 — 어느 파드인지가 모호해진다.
    expect(buildCommand('k8s.describe', { pod })).toBeNull()
  })

  it('파드 이름은 점을 허용하고(서브도메인) 253자까지 — 네임스페이스는 63자 레이블이다', () => {
    expect(validPodName('a.b-c9')).toBe('a.b-c9')
    expect(validNsName('a.b')).toBeNull() // 레이블에는 점이 없다
    expect(validNsName('a'.repeat(63))).not.toBeNull()
    expect(validPodName('a'.repeat(253))).not.toBeNull()
  })
})

/**
 * 🔴 **준영님 결정의 자물쇠**(2026-09-16: "아라에게 exec 를 주지 않는다").
 *
 * 왜 이 한 줄이 필요한가: `server_run` 의 `cmdId` 는 `z.string()` 자유 문자열이다
 * (`src/main/mcp/tools.ts`). 별도의 "MCP 도구 표"가 있는 게 아니라 **COMMANDS 에 있으면
 * isCmdId 를 통과하고 그 순간 아라가 부를 수 있는 도구가 된다** — 도구 설명에 안 적어도
 * 마찬가지다. 그래서 "설명에서 뺀다"로는 못 막고, 표에 만들지 않는 것만이 막는다.
 */
describe('★ exec 는 표에 없다 — 아라가 부를 수 있는 도구가 되지 않는다', () => {
  it('isCmdId("k8s.exec") 가 false 다', () => {
    expect(isCmdId('k8s.exec')).toBe(false)
    expect(buildCommand('k8s.exec', { ns: 'vgt-erp', pod: 'p', container: 'c' })).toBeNull()
  })

  it('표 전체에 exec 라는 id 가 하나도 없다(다른 이름으로 슬쩍 들어오는 것도 막는다)', () => {
    expect(Object.keys(COMMANDS).filter((k) => k.includes('exec'))).toEqual([])
  })

  it('사람이 쓰는 exec 줄은 표 밖에서 조립되고, 같은 검증을 지난다', () => {
    expect(buildK8sExec('vgt-erp', 'api-7d9', 'app')).toBe(
      "kubectl exec -it api-7d9 -n vgt-erp -c app -- sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'"
    )
    // 검증을 못 지나면 줄 자체가 안 만들어진다 — 터미널에 반쪽짜리 명령이 찍히지 않는다.
    expect(buildK8sExec('*', 'api-7d9', 'app')).toBeNull()
    expect(buildK8sExec('vgt-erp', 'api; id', 'app')).toBeNull()
    expect(buildK8sExec('vgt-erp', 'api-7d9', 'app|sh')).toBeNull()
  })
})

describe('권한 올리기 회귀 방지', () => {
  /**
   * ★ k8s.list 는 `write` 가 없는 읽기 명령이지만 wrapSudo 를 쓴다. isPrivileged 가 args 의
   * sudo 를 따로 보지 않으면 `{sudo:true}` 를 실은 MCP 호출이 **다이얼로그 없이 원격 root
   * 실행**으로 떨어진다(2026-08-28 감사에서 나온 구멍 그대로다).
   */
  it('★ isPrivileged("k8s.list", {sudo:true}) 가 여전히 true 다', () => {
    expect(isPrivileged('k8s.list', { sudo: true })).toBe(true)
    expect(isPrivileged('k8s.list', null)).toBe(false)
    // sudo 를 태우는 명령이라는 사실 자체가 유지되는가(kubectl 로 바꾸면서 빠뜨리기 쉬운 자리).
    expect(buildCommand('k8s.list', { sudo: true })!.sudo).toBe(true)
  })

  it('새로 연 읽기 셋은 sudo 를 안 쓴다 — 쓰게 되면 승인이 저절로 따라와야 한다', () => {
    for (const id of ['k8s.ns', 'k8s.describe', 'k8s.yaml'] as const) {
      const r = buildCommand(id, { ns: 'vgt-erp', pod: 'api-7d9', sudo: true })!
      expect(r.sudo, id).toBe(false)
      expect(r.write, id).toBe(false)
      expect(isPrivileged(id, { sudo: true }), id).toBe(true) // 그래도 요청 자체는 승인 대상이다
    }
  })
})
