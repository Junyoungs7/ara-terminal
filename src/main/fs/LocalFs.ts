// 로컬 파일시스템 — [파일] 탭이 로컬 세션에서 쓰는 백엔드(R7). SFTP(SftpService)와 같은 계약이라
// 렌더러 FileTree 는 백엔드 함수 테이블만 갈아끼운다.
// 실패는 예외 대신 구조화 결과로 반환(트리 영역에 표시, 크래시 금지) — SftpService 와 같은 규칙.
import { readdir, stat, rename, mkdir, rm, cp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, basename } from 'node:path'
import type { FileEntry, FileListResult, FileOpResult } from '@shared/ipc'
import { friendly } from '../util/fsError'

// Windows 예약 장치명(D4) — 확장자를 붙여도 여전히 그 디바이스를 가리킨다(예: con.txt).
const RESERVED_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

// 이름 입력 검증(신뢰 경계): 렌더러가 보낸 새 이름으로 디렉토리를 벗어날 수 없게 한다.
// 경로 구분자·상위 참조를 막으면 join(dir, name) 이 항상 dir 하위에 머무른다.
export function invalidName(name: string): string | null {
  const n = (name ?? '').trim()
  if (!n) return '이름을 입력하세요.'
  if (n === '.' || n === '..') return '사용할 수 없는 이름입니다.'
  if (/[\\/]/.test(n)) return '이름에 경로 구분자를 쓸 수 없습니다.'
  if (RESERVED_DEVICE_NAME.test(n)) return 'Windows 예약 장치명은 사용할 수 없습니다.'
  return null
}

// 디렉토리 리스팅. '.' 는 홈 디렉토리. 폴더 우선 + 이름 오름차순(한글 로케일) — SFTP 와 동일 규칙.
export async function list(path: string): Promise<FileListResult> {
  const abs = resolve(!path || path === '.' ? homedir() : path)
  try {
    // withFileTypes 로 링크 여부를 공짜로 얻는다(dirent 는 lstat 결과다). 종류·크기는 아래 stat 이
    // 링크를 따라가 대상 기준으로 채운다 — 링크 폴더가 파일로 보이던 문제(준영님 제보)의 반대편.
    const dirents = await readdir(abs, { withFileTypes: true })
    const entries: FileEntry[] = []
    for (const d of dirents) {
      const name = d.name
      const link = d.isSymbolicLink()
      // 심볼릭 링크 깨짐·권한 없는 항목 하나가 목록 전체를 실패시키지 않게 항목 단위로 건너뛴다.
      try {
        const s = await stat(join(abs, name))
        const isDir = s.isDirectory()
        entries.push({ name, type: isDir ? 'dir' : 'file', size: isDir ? 0 : s.size, mtime: s.mtimeMs, link })
      } catch {
        entries.push({ name, type: 'file', size: 0, mtime: 0, link, broken: link })
      }
    }
    entries.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'ko')))
    // 드라이브/파일시스템 루트는 dirname 이 자기 자신을 돌려준다 — 그 위로는 못 올라간다.
    return { ok: true, path: abs, parent: dirname(abs), entries }
  } catch (e) {
    return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
  }
}

export async function renameEntry(path: string, name: string): Promise<FileOpResult> {
  const bad = invalidName(name)
  if (bad) return { ok: false, message: bad }
  try {
    await rename(path, join(dirname(path), name.trim()))
    return { ok: true }
  } catch (e) {
    return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
  }
}

export async function makeDir(dir: string, name: string): Promise<FileOpResult> {
  const bad = invalidName(name)
  if (bad) return { ok: false, message: bad }
  try {
    await mkdir(join(dir, name.trim()))
    return { ok: true }
  } catch (e) {
    return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
  }
}

// W4sat F20: 탐색기 패널 간 복사(폴더는 재귀, cp 가 기본 지원). destDir 자체는 이미 존재해야 한다
// (없는 폴더로 통째로 옮기는 것은 "새 폴더 만들기"라 다른 조작 — 여기선 시도하지 않는다).
// 이동은 이 함수 + remove 를 호출측(렌더러)이 순서대로 부른다 — rename 은 같은 폴더 안 이름 변경 계약이라
// 다른 디렉토리로의 이동에는 못 쓰고, 신규 IPC 를 이동 전용으로 하나 더 만들 이유가 없다.
export async function copyEntries(paths: string[], destDir: string): Promise<FileOpResult> {
  for (const p of paths) {
    try {
      await cp(p, join(destDir, basename(p)), { recursive: true, errorOnExist: true, force: false })
    } catch (e) {
      return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
    }
  }
  return { ok: true }
}

// 삭제(폴더는 재귀). 하나라도 실패하면 그 지점에서 멈추고 사유를 돌려준다 —
// 이미 지운 것을 되돌릴 수는 없으므로 "어디까지 갔는지"를 감추지 않고 다음 목록 갱신으로 드러낸다.
// force:false 라 없는 경로는 오류다(이미 지운 것을 성공으로 위장하지 않는다).
export async function remove(paths: string[]): Promise<FileOpResult> {
  for (const p of paths) {
    try {
      await rm(p, { recursive: true, force: false })
    } catch (e) {
      return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
    }
  }
  return { ok: true }
}
