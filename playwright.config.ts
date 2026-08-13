import { defineConfig } from '@playwright/test'

// T1 전 기능 회귀 스위트. Electron 앱을 out/ 빌드 산출물로 기동하므로 브라우저 프로젝트는 없다.
// 워커 2 상한: 테스트마다 Electron 프로세스 + pty(또는 ssh2 서버)를 하나씩 띄운다 — 그 이상은
// Windows 에서 conpty 스폰이 밀려 타이밍 실패가 늘어난다.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // 앱 기동(~3s) + pty/ssh 왕복 + 재기동 시나리오까지 한 테스트에 들어간다.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 2,
  // 실패를 숨기지 않는다 — flaky 는 테스트를 고친다(재시도로 덮지 않는다).
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: 'tests/e2e/.last-run.json' }]],
  use: { trace: 'off', video: 'off', screenshot: 'off' }
})
