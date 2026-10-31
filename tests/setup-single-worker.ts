// 단위 시험은 한 번에 한 워커에서만 돈다(vitest.config.ts maxWorkers: 1 의 이유 — 고정 포트 39217·공유 상태).
// 설정이 조용히 무시되면(vitest 4 의 poolOptions 처럼) 병렬이 되어 가끔만 깨진다 — 여기서 바로 던진다.
const slot = Number(process.env['VITEST_POOL_ID'] ?? '1')
if (slot > 1) throw new Error(`단위 시험이 병렬로 돈다(VITEST_POOL_ID=${slot}) — vitest.config.ts 의 maxWorkers: 1 이 안 먹었다`)
