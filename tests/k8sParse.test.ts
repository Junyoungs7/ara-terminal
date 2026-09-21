// #192 쿠버네티스 — `kubectl get pods -o json` 읽기. **가짜 JSON 문자열로만** 시험한다
// (실서버는 준영님의 운영 클러스터다).
//
// 이 파일이 지키는 것: 화면이 이미 쓰는 두 타입(CtrRow · CtrPodInfo)으로 떨어지는가 ·
// "0개"와 "못 읽었다"가 갈리는가 · 단위(ms)가 crictl(나노초)과 섞이지 않는가.
import { describe, it, expect } from 'vitest'
import { CTR_MARK, parseCtrList, parseKubectlPods, parseNamespaces } from '../src/shared/remoteCatalog'
import { groupPods } from '../src/renderer/components/K8sPanel'

/** 파드 둘 · 컨테이너 각 2개. api-7d9 는 정상, web-2f1 은 한 컨테이너가 죽었다. */
const PODS = JSON.stringify({
  items: [
    {
      metadata: { name: 'api-7d9f4c6b8-x2kqp', namespace: 'vgt-erp', creationTimestamp: '2026-09-20T01:00:00Z' },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'app',
            ready: true,
            restartCount: 2,
            image: 'reg.local:5000/team/api:1.2.3',
            containerID: 'containerd://' + 'a'.repeat(64),
            state: { running: { startedAt: '2026-09-20T01:01:00Z' } }
          },
          {
            name: 'istio-proxy',
            ready: true,
            restartCount: 0,
            image: 'docker.io/istio/proxyv2:1.20',
            containerID: 'containerd://' + 'b'.repeat(64),
            state: { running: { startedAt: '2026-09-20T01:01:05Z' } }
          }
        ]
      }
    },
    {
      metadata: { name: 'web-2f1', namespace: 'vgt-erp', creationTimestamp: '2026-09-19T00:00:00Z' },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'web',
            ready: false,
            restartCount: 7,
            image: 'nginx:1.24',
            containerID: 'containerd://' + 'c'.repeat(64),
            state: { terminated: { startedAt: '2026-09-19T00:00:10Z', exitCode: 1 } }
          },
          {
            name: 'istio-proxy',
            ready: true,
            restartCount: 0,
            image: 'docker.io/istio/proxyv2:1.20',
            containerID: 'containerd://' + 'd'.repeat(64),
            state: { running: { startedAt: '2026-09-19T00:00:05Z' } }
          }
        ]
      }
    }
  ]
})

describe('kubectl 파드 목록 파싱', () => {
  it('★ 컨테이너 하나가 행 하나, 파드는 묶음 — 화면이 이미 쓰는 두 타입 그대로다', () => {
    const { rows, pods } = parseKubectlPods(PODS)
    expect(rows).toHaveLength(4)
    expect(pods).toHaveLength(2)
    expect(rows.map((r) => r.name)).toEqual(['app', 'istio-proxy', 'web', 'istio-proxy'])
    // ns·pod 는 **파드 묶기의 키**다 — 비면 컨테이너가 제각각 흩어진다.
    expect(rows.every((r) => r.ns === 'vgt-erp')).toBe(true)
    expect(rows.map((r) => r.pod)).toEqual(['api-7d9f4c6b8-x2kqp', 'api-7d9f4c6b8-x2kqp', 'web-2f1', 'web-2f1'])
    const g = groupPods(rows, pods)
    expect(g).toHaveLength(2)
    expect(g.map((x) => x.key).sort()).toEqual(['vgt-erp/api-7d9f4c6b8-x2kqp', 'vgt-erp/web-2f1'])
  })

  it('★ id 는 containerID 의 뒷부분 — 겹치면 표의 행이 합쳐진다', () => {
    const { rows } = parseKubectlPods(PODS)
    expect(rows[0].id).toBe('a'.repeat(64)) // containerd:// 접두어가 벗겨진다
    expect(new Set(rows.map((r) => r.id)).size).toBe(4)
  })

  it('상태 낱말을 docker 와 맞춘다 — running 판정이 화면에서 한 규칙으로 돈다', () => {
    const { rows } = parseKubectlPods(PODS)
    expect(rows[0].state).toBe('running')
    expect(rows[2].state).toBe('exited') // terminated → exited
  })

  it('재시작 횟수와 이미지를 싣는다', () => {
    const { rows } = parseKubectlPods(PODS)
    expect(rows[0].restarts).toBe(2)
    expect(rows[2].restarts).toBe(7)
    expect(rows[0].image).toBe('reg.local:5000/team/api:1.2.3')
  })

  it('★ 파드가 Running 이어도 컨테이너 하나가 ready 가 아니면 notready 다', () => {
    const { pods } = parseKubectlPods(PODS)
    expect(pods[0].state).toBe('ready')
    expect(pods[1].state).toBe('notready')
    // 그 파드가 위로 올라오는가(podRank 0).
    const { rows } = parseKubectlPods(PODS)
    expect(groupPods(rows, pods)[0].key).toBe('vgt-erp/web-2f1')
  })

  /**
   * ★ **단위 사고 방지.** crictl 은 나노초 문자열이었고 kubectl 은 ISO 문자열이다.
   * `CtrRow.createdAt` 은 epoch **ms** 다(K8sPanel.age 가 `Date.now() - ms` 로 센다) —
   * 초로 넣으면 모든 파드의 나이가 57년이 된다.
   */
  it('★ creationTimestamp 는 epoch ms 로 내려온다(초도, 나노초도 아니다)', () => {
    const { pods, rows } = parseKubectlPods(PODS)
    expect(pods[0].createdAt).toBe(Date.parse('2026-09-20T01:00:00Z'))
    expect(pods[0].createdAt).toBe(1_789_866_000_000)
    // 컨테이너 줄은 자기가 뜬 시각을 쓴다(파드보다 늦을 수 있다).
    expect(rows[0].createdAt).toBe(Date.parse('2026-09-20T01:01:00Z'))
    // 2026년이 13자리 ms 인가 — 초(10자리)·나노초(19자리)가 섞이면 여기서 걸린다.
    expect(String(pods[0].createdAt)).toHaveLength(13)
  })

  /**
   * 🔴 `kubectl get pods` 에는 자원이 **없다**(`kubectl top` 은 metrics-server 가 있어야 한다).
   * 0 을 넣으면 "안 쓰는 중"이라는 거짓말이 된다 — 비워 두면 화면이 `—`(모름)를 그린다.
   */
  it('★ CPU·메모리는 0 이 아니라 비어 있다 — "안 쓴다"와 "모른다"는 다르다', () => {
    const { rows, pods } = parseKubectlPods(PODS)
    expect(rows.every((r) => r.cpuNs === undefined && r.memBytes === undefined)).toBe(true)
    expect(groupPods(rows, pods)[0].cpuNs).toBeNull()
    expect(groupPods(rows, pods)[0].memBytes).toBeNull()
  })
})

describe('아직 안 뜬 파드 — id 가 겹치면 안 된다', () => {
  const PENDING = JSON.stringify({
    items: [
      {
        metadata: { name: 'job-a', namespace: 'vgt-erp', creationTimestamp: '2026-09-21T00:00:00Z' },
        status: {
          phase: 'Pending',
          containerStatuses: [
            { name: 'run', ready: false, restartCount: 0, image: 'busybox', state: { waiting: { reason: 'ImagePullBackOff' } } },
            { name: 'sidecar', ready: false, restartCount: 0, image: 'busybox', state: { waiting: { reason: 'PodInitializing' } } }
          ]
        }
      },
      {
        metadata: { name: 'job-b', namespace: 'vgt-erp', creationTimestamp: '2026-09-21T00:00:00Z' },
        status: {
          phase: 'Pending',
          containerStatuses: [{ name: 'run', ready: false, restartCount: 0, image: 'busybox', state: { waiting: {} } }]
        }
      }
    ]
  })

  it('★ containerID 가 없어도 id 가 파드마다 다르다(같으면 세 행이 한 줄로 합쳐진다)', () => {
    const { rows } = parseKubectlPods(PENDING)
    expect(rows.map((r) => r.id)).toEqual(['vgt-erp/job-a/run', 'vgt-erp/job-a/sidecar', 'vgt-erp/job-b/run'])
    expect(new Set(rows.map((r) => r.id)).size).toBe(3)
    expect(rows[0].state).toBe('waiting')
  })

  it('★ 컨테이너 상태가 아예 없는 파드도 한 줄은 낸다 — 제일 아픈 파드가 사라지면 안 된다', () => {
    const unsched = JSON.stringify({
      items: [{ metadata: { name: 'stuck', namespace: 'vgt-erp' }, status: { phase: 'Pending' } }]
    })
    const { rows, pods } = parseKubectlPods(unsched)
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('pending')
    expect(pods[0].state).toBe('notready')
    expect(groupPods(rows, pods)).toHaveLength(1)
  })
})

describe('0개와 "못 읽었다"를 가른다', () => {
  it('★ {"items":[]} 는 진짜 0개다 — 안내로 덮지 않는다', () => {
    const list = parseCtrList(`${CTR_MARK}kubectl\n{"items":[]}`)
    expect(list.runtime).toBe('kubectl')
    expect(list.rows).toEqual([])
    expect(list.unavailable).toBe(false)
    expect(list.reason).toBeNull()
  })

  /**
   * ★ 기본이 `-n vgt-erp` 인데 그 네임스페이스가 없는 클러스터가 있다. 이 문장을 "0개"로 읽으면
   * 사람이 네임스페이스를 잘못 골랐다는 것을 알 길이 없다.
   */
  it('★ NotFound 는 0개가 아니라 실패다 — 서버 문장이 그대로 이유가 된다', () => {
    const err = 'Error from server (NotFound): namespaces "vgt-erp" not found'
    const list = parseCtrList(`${CTR_MARK}kubectl\n${err}`)
    expect(list.runtime).toBe('kubectl')
    expect(list.unavailable).toBe(true)
    expect(list.reason).toBe(err)
  })

  it('kubectl 이 없는 서버는 none — "파드 0개"와 다른 안내다', () => {
    const list = parseCtrList(`${CTR_MARK}none\n`)
    expect(list.unavailable).toBe(true)
    expect(list.reason).toBeNull()
  })

  it('목록이 오면 파드 묶음도 같은 왕복에서 나온다(pods 토막이 따로 없다)', () => {
    const list = parseCtrList(`${CTR_MARK}kubectl\n${PODS}`)
    expect(list.rows).toHaveLength(4)
    expect(list.pods.map((p) => p.name)).toEqual(['api-7d9f4c6b8-x2kqp', 'web-2f1'])
  })

  it('잡소리가 앞에 섞여도 JSON 만 꺼내 읽는다', () => {
    const noisy = `${CTR_MARK}kubectl\nW0921 09:00:00 client_config.go:1 Using in-cluster configuration\n${PODS}`
    expect(parseCtrList(noisy).rows).toHaveLength(4)
  })
})

describe('네임스페이스 목록', () => {
  it('`-o name` 의 접두어를 벗기고 이름만 남긴다', () => {
    const out = 'namespace/default\nnamespace/kube-system\nnamespace/vgt-erp\nnamespace/vgt-web\n'
    expect(parseNamespaces(out)).toEqual(['default', 'kube-system', 'vgt-erp', 'vgt-web'])
  })

  /**
   * ★ 여기를 통과한 이름은 **그대로 다시 명령줄에 들어간다**(셀렉트에서 고르면 k8s.list 의 ns).
   * 그래서 오류 출력이든 처음 보는 형식이든 RFC1123 이 아니면 올리지 않는다.
   */
  it('★ RFC1123 이 아닌 줄은 올라오지 않는다 — 오류 출력도 포함해서', () => {
    expect(parseNamespaces('Error from server (Forbidden): namespaces is forbidden')).toEqual([])
    expect(parseNamespaces('namespace/BAD\nnamespace/a b\nnamespace/ok\n')).toEqual(['ok'])
    expect(parseNamespaces('')).toEqual([])
  })
})
