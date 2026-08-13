// 원자적 JSON 쓰기 + .bak 롤백 (계획서 §B.3/§B.4 원자성·손상복구).
// temp 파일에 쓰고 기존 파일을 .bak으로 밀어낸 뒤 atomic rename. 손상 시 .bak으로 복구.
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'

export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  if (existsSync(path)) renameSync(path, path + '.bak')
  renameSync(tmp, path)
}

// path → 실패 시 path.bak → 둘 다 실패면 fallback 반환.
export function readJsonWithBackup<T>(path: string, fallback: T): T {
  for (const p of [path, path + '.bak']) {
    if (!existsSync(p)) continue
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T
    } catch {
      // 다음 후보(.bak)로 롤백
    }
  }
  return fallback
}

// 기동 시 중단된 쓰기의 잔여 temp 정리.
export function cleanupTemp(path: string): void {
  const tmp = path + '.tmp'
  if (existsSync(tmp)) {
    try {
      unlinkSync(tmp)
    } catch {
      /* best-effort */
    }
  }
}
