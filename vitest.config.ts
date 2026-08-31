import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // #164: 여기 있던 poolMatchGlobs(ssh-connect·mcp-server 를 'forks' 로 격리)를 지웠다 —
    // **아무 일도 하지 않는 설정**이었다. vitest 2 의 기본 pool 이 이미 'forks' 라
    // (node_modules/vitest/dist/config.cjs:101) 아래 singleFork 가 스위트 전체에 걸린다:
    // 105개 파일이 한 프로세스에서 순차로 돈다(PID 실측 — mcp-server 와 sessionlog 가 같은 PID였다,
    // 즉 그 주석이 막으려던 바로 그 상태다).
    // 두 항목을 부른 사유도 이미 끝났다:
    //  · ssh-connect 의 "Malformed key" flaky 는 워커 동시성이 아니라 ssh2 의 ed25519 생성기였다 —
    //    genHostKey 가 만든 키를 즉시 검증·재시도하도록 고쳐 근본 해결했다(tests/ssh-harness.ts, W2).
    //  · mcp-server 격리를 부른 것은 sessionlog 의 **힙 증가량 측정** 검사인데, 그 검사는
    //    2026-08-23 에 없어졌다 — 재는 대상을 힙에서 꼬리 버퍼(e.buf)로 바꿔 GC 타이밍과
    //    무관해졌다(tests/sessionlog.test.ts:382-386). 지킬 대상이 없다.
    // singleFork 자체는 이번에 건드리지 않는다 — 병렬로 되돌리면 공유 상태·고정 포트(39217)가
    // 드러나므로 검증을 붙일 별도 라운드감이다.
    poolOptions: { forks: { singleFork: true } }
  }
})
