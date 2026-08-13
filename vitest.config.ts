import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // ssh-connect 는 실제 ssh2 서버를 임시 포트에 띄우고 매번 ed25519 호스트키를 생성한다.
    // 여러 워커가 동시에 키를 생성하면 ssh2 파서가 드물게 "Malformed key"로 거부하는 flaky가 있었다(F4b 검증 권고).
    // 이 파일을 별도 forks 풀(단일 fork)로 격리해 동시 키 생성 경합을 없앤다(다른 스위트는 기본 병렬 유지).
    // (W2) "Malformed OpenSSH private key" flaky 의 실제 원인은 워커 동시성이 아니라 ssh2 의
    // ed25519 생성기였다 — genHostKey 가 만든 키를 즉시 검증·재시도하도록 고쳐 근본 해결했다
    // (tests/ssh-harness.ts). 이 격리는 그 전 진단으로 넣은 것이라 그대로 두되 확장하지 않는다.
    // F23: mcp-server.test.ts 는 node-pty 세션 + 실 HTTP 리스너를 여러 개 띄운다. 기본 threads 풀은
    // 파일 수가 스레드 수보다 많으면 스레드를 재사용하는데, 이 파일이 재사용된 스레드에 남긴 힙이
    // 뒤이어 도는 무관한 파일(예: sessionlog.test.ts 의 힙 증가량 측정 테스트)의 측정치를 오염시켜
    // 스위트 전체를 돌릴 때만 재현되는 flaky 를 만들었다(단독 실행은 항상 통과). ssh-connect 와 같은
    // 처방(전용 fork로 격리)이지만 원인은 다르다 — 위 주석의 "확장하지 않는다"는 ed25519 동시성
    // 문제에 대한 말이고, 이건 별개의 힙 오염 문제라 별도 항목으로 추가한다.
    poolMatchGlobs: [
      ['**/ssh-connect.test.ts', 'forks'],
      ['**/mcp-server.test.ts', 'forks']
    ],
    poolOptions: { forks: { singleFork: true } }
  }
})
