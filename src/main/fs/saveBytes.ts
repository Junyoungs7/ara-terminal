// RDP 클립보드 파일 받기 — 원격에서 내려온 바이트를 사용자가 고른 폴더에 쓴다.
//
// 이름·하위 경로는 **원격 Windows 가 준 문자열**이다. 그대로 join 하면 `..\..\` 나 `C:\Windows\` 로
// 폴더 밖에 쓸 수 있다(원격이 악의적이거나 감염됐을 때). 그래서 조각마다 검사해 통과한 것만 이어 붙인다.
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { FileOpResult } from '@shared/ipc'

// 한 파일 상한. 브라우저 쪽(RdpFileTransferProvider)도 2GB 를 막지만 여기서도 막는다 —
// main 은 렌더러를 신뢰하지 않는다.
export const SAVE_BYTES_MAX = 2 * 1024 * 1024 * 1024

/**
 * Windows 가 파일 이름에 못 쓰는 글자. 폴더째 받기의 `LocalFs.localName` 도 이 집합을 쓴다 —
 * 한 앱에 두 벌이면 한쪽만 고쳐지는 날이 온다(R15).
 */
export const WIN_BAD_CHARS = /[<>:"|?*\u0000-\u001f]/

/** 파일명 → 안전한 basename. 경로 구분자·상위 참조·빈 이름은 거른다. */
export function safeBase(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') return null
  // 예약 문자는 경로 조각을 떼기 **전에** 본다. 뒤에 검사하면 'a:b' 가 조용히 'b' 로 바뀐다 —
  // win32 basename 이 `a:` 를 드라이브 접두로 읽기 때문이다(단위 테스트가 잡아낸 실제 동작).
  // 역슬래시와 슬래시는 여기서 빼 둔다 — 그건 아래에서 정당하게 떼어 낸다.
  if (WIN_BAD_CHARS.test(trimmed)) return null
  // basename 으로 디렉토리 부분을 떼어 내고, 그래도 구분자가 남으면(이상한 입력) 거절한다.
  const base = basename(trimmed.replace(/\\/g, '/'))
  if (!base || base === '.' || base === '..' || /[\\/]/.test(base)) return null
  return base
}

/**
 * 원격이 준 상대 폴더(`docs\images`) → 안전한 조각 배열. 하나라도 수상하면 null(전체 거절).
 * 빈 문자열·undefined 는 "루트"라 빈 배열이다.
 */
export function safeSegments(sub: unknown): string[] | null {
  if (sub === undefined || sub === null || sub === '') return []
  if (typeof sub !== 'string') return null
  const parts = sub.split(/[\\/]+/).filter((p) => p !== '')
  const out: string[] = []
  for (const p of parts) {
    const seg = safeBase(p)
    if (!seg) return null
    out.push(seg)
  }
  return out
}

/** 같은 이름이 있으면 `이름 (2).txt` 로 비켜 간다 — 두 번 받았을 때 조용히 덮어쓰지 않는다. */
export function uniqueName(name: string, exists: (n: string) => boolean): string {
  if (!exists(name)) return name
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

export async function saveBytes(req: {
  dir: unknown
  sub?: unknown
  name: unknown
  bytes: unknown
}): Promise<FileOpResult> {
  if (typeof req.dir !== 'string' || !req.dir) return { ok: false, message: '저장 폴더가 지정되지 않았습니다.' }
  const base = safeBase(req.name)
  if (!base) return { ok: false, message: '원격이 보낸 파일 이름을 쓸 수 없습니다.' }
  const segments = safeSegments(req.sub)
  if (!segments) return { ok: false, message: '원격이 보낸 폴더 경로를 쓸 수 없습니다.' }
  const bytes = req.bytes
  if (!(bytes instanceof Uint8Array)) return { ok: false, message: '내려받은 내용이 비어 있습니다.' }
  if (bytes.byteLength > SAVE_BYTES_MAX) return { ok: false, message: '파일이 너무 큽니다(2GB 초과).' }

  const dir = segments.length > 0 ? join(req.dir, ...segments) : req.dir
  try {
    await mkdir(dir, { recursive: true })
    const target = uniqueName(base, (n) => existsSync(join(dir, n)))
    await writeFile(join(dir, target), bytes)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}
