/**
 * 2.0 첫 실행 — 1.x 의 설정·데이터 파일을 **복사**해 둔다(2026-10-29 준영님: "1.x 재설치로 돌아갈 수 있게").
 *
 * 2.0 은 같은 appId 로 덮어 깔리고 같은 userData(`%APPDATA%\A.R.A`)를 쓴다. 2.0 이 workspace 를 고쳐 쓰고
 * 잠금을 켜면 vault 를 잠금 비밀번호로 다시 봉한다 — 그 뒤엔 1.x 가 그 파일을 못 읽는다. 그래서 2.0 이
 * 무엇이든 쓰기 **전에**(index.ts whenReady 맨 앞, WorkspaceStore·AppLock 생성 전) 한 번 떠 둔다.
 *
 * 복사만 한다 — 옮기면 2.0 이 빈 폴더로 뜬다. 큰 폴더(logs·ara-chats·Chromium 캐시)는 안 뜬다:
 * 1.x 로 돌아가는 데 필요한 것은 아래 파일들뿐이고, 로그는 2.0 이 지우지 않는다.
 * 실패해도 던지지 않는다 — 백업 때문에 앱이 안 뜨면 그게 더 큰 사고다.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 뜨는 파일(userData 최상위). `.bak` 은 atomicJson 의 롤백본 — 본 파일이 깨졌을 때 1.x 가 그것으로 돌아간다. */
export const V1_BACKUP_FILES = [
  'workspace.json',
  'workspace.json.bak',
  'history.json',
  'history.json.bak',
  'secrets.vault',
  'secrets.vault.bak',
  'device-id',
  'my-reports.json'
] as const

/** 이 파일이 있으면 이미 한 번 돌았다. */
export const V1_BACKUP_MARK = '.v2-migrated'

/** 1.x 데이터가 있었다는 표지 — 둘 다 없으면 새 설치라 뜰 것이 없다. */
const V1_SIGNS = ['workspace.json', 'secrets.vault']

const stamp = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 뜬 폴더 경로를 돌려준다. 할 일이 없었으면 null. */
export function backupV1Data(userData: string, onError: (err: unknown) => void, now = new Date()): string | null {
  try {
    mkdirSync(userData, { recursive: true })
    if (existsSync(join(userData, V1_BACKUP_MARK))) return null
    if (!V1_SIGNS.some((f) => existsSync(join(userData, f)))) {
      // 새 설치 — 다음 실행에 2.0 이 만든 파일을 1.x 것으로 착각해 뜨지 않게 표식만 남긴다.
      writeFileSync(join(userData, V1_BACKUP_MARK), 'fresh\n')
      return null
    }
    const dir = join(userData, `backup-1.x-${stamp(now)}`)
    mkdirSync(dir, { recursive: true })
    for (const f of V1_BACKUP_FILES) if (existsSync(join(userData, f))) copyFileSync(join(userData, f), join(dir, f))
    // ponytail: 표식은 다 뜬 뒤에만 — 실패하면 다음 실행에 다시 뜬다(그땐 2.0 이 고친 값일 수 있다). 실제로 나면 그때 손본다.
    writeFileSync(join(userData, V1_BACKUP_MARK), `${dir}\n`)
    return dir
  } catch (e) {
    onError(e)
    return null
  }
}
