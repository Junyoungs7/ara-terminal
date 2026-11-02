// M15 R2 TM-06 복원 파일 백업·스냅샷 회전(herdr src/persist/{restore,snapshot}.rs, Apache-2.0 — 생각만 옮기고 코드는 새로 씀).
// 작업대 복원 파일(workspace.json — 세션·레이아웃·탭 묶음·프로필)은 지금까지 `.bak` 한 겹뿐이었다. 본 파일이 깨진 채로 저장이
// 한 번 더 돌면 깨진 것이 `.bak` 으로 밀려 좋은 사본이 사라진다. herdr 처럼 두 겹을 더한다:
//  · 깨진 원본 보존 — 읽다가 JSON 이 깨져 있으면 덮어쓰기 전에 `<이름>-backups/` 로 복사(최근 3개). 무엇이 깨졌는지 볼 수 있게.
//  · 스냅샷 회전 — 저장할 때 마지막 스냅샷이 15분보다 오래됐으면 `<이름>-snapshots/` 에 한 장(최근 48개 = 약 12시간). 본 파일·.bak 이
//    둘 다 깨졌으면 가장 최근의 읽히는 스냅샷으로 뜬다(지금까지는 빈 기본값 — 서버 목록까지 사라진 것처럼 보였다).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const BACKUP_KEEP = 3
export const SNAPSHOT_KEEP = 48
export const SNAPSHOT_EVERY_MS = 15 * 60_000

const dirOf = (path: string, kind: 'backups' | 'snapshots'): string =>
  join(dirname(path), basename(path).replace(/\.json$/i, '') + '-' + kind)

/** 이름에 시각을 넣는다(정렬 = 시간순). 같은 밀리초 충돌은 뒤에 번호. */
const stamp = (now: number): string => new Date(now).toISOString().replace(/[:.]/g, '-')

function listNewestFirst(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function prune(dir: string, keep: number): void {
  for (const n of listNewestFirst(dir).slice(keep)) {
    try {
      unlinkSync(join(dir, n))
    } catch {
      /* 다음 회전에 다시 */
    }
  }
}

function copyInto(src: string, dir: string, now: number, keep: number): void {
  mkdirSync(dir, { recursive: true })
  let name = stamp(now) + '.json'
  for (let i = 1; existsSync(join(dir, name)); i++) name = `${stamp(now)}-${i}.json`
  copyFileSync(src, join(dir, name))
  prune(dir, keep)
}

/** 본 파일이 있는데 JSON 으로 안 읽히면 원본을 backups 에 남기고 true. 없거나 멀쩡하면 false. 실패해도 던지지 않는다(부팅을 막지 않는다). */
export function preserveIfCorrupt(path: string, now = Date.now()): boolean {
  if (!existsSync(path)) return false
  try {
    JSON.parse(readFileSync(path, 'utf8'))
    return false
  } catch {
    try {
      copyInto(path, dirOf(path, 'backups'), now, BACKUP_KEEP)
    } catch {
      /* 보존 실패는 복원을 막지 않는다 */
    }
    return true
  }
}

/** 방금 쓴 본 파일을 스냅샷으로(마지막 것이 everyMs 보다 오래됐을 때만). 실패는 삼킨다 — 저장 자체는 이미 끝났다. */
export function rotateSnapshot(path: string, now = Date.now(), everyMs = SNAPSHOT_EVERY_MS): void {
  const dir = dirOf(path, 'snapshots')
  const last = listNewestFirst(dir)[0]
  if (last) {
    // 이름 앞 24자가 ISO 시각(콜론·점을 - 로 바꾼 것) — 되돌려 읽는다.
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(last)
    const at = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : NaN
    if (Number.isFinite(at) && now - at < everyMs && now >= at) return
  }
  try {
    copyInto(path, dir, now, SNAPSHOT_KEEP)
  } catch {
    /* 다음 저장에 다시 */
  }
}

/** 가장 최근의 **읽히는** 스냅샷(깨진 것은 건너뛴다). 없으면 null. */
export function readNewestSnapshot<T>(path: string): T | null {
  const dir = dirOf(path, 'snapshots')
  for (const n of listNewestFirst(dir)) {
    try {
      return JSON.parse(readFileSync(join(dir, n), 'utf8')) as T
    } catch {
      /* 다음 것 */
    }
  }
  return null
}
