// 로컬 파일시스템 — [파일] 탭이 로컬 세션에서 쓰는 백엔드(R7). SFTP(SftpService)와 같은 계약이라
// 렌더러 FileTree 는 백엔드 함수 테이블만 갈아끼운다.
// 실패는 예외 대신 구조화 결과로 반환(트리 영역에 표시, 크래시 금지) — SftpService 와 같은 규칙.
import { readdir, stat, rename, mkdir, cp, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, basename, extname } from 'node:path'
import { shell } from 'electron'
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

// #89(2026-08-16): 로컬 삭제는 **휴지통**으로 간다. 예전에는 `rm(recursive, force:false)` 로
// 영구 삭제였고, 이 주석 자리에 "이미 지운 것을 되돌릴 수는 없으므로"라고 적혀 있었다 —
// 탐색기처럼 생긴 화면에서 Delete 를 누른 사용자는 휴지통을 기대한다(준영님 2026-08-16 확정).
// **원격(SFTP)은 그대로 영구 삭제다** — 서버에 휴지통이 없다. 확인 문구가 그 차이를 말한다.
//
// 실패하면 **영구 삭제로 넘어가지 않는다.** 네트워크 드라이브·휴지통 비활성 환경에서 조용히
// 지워 버리면 사용자가 기대한 것과 정반대가 된다 — 실패를 그대로 보이고 사람이 고르게 한다.
// 하나라도 실패하면 그 지점에서 멈춘다(어디까지 갔는지는 다음 목록 갱신이 드러낸다).
export async function trash(paths: string[]): Promise<FileOpResult> {
  for (const p of paths) {
    try {
      // 없는 경로를 trashItem 에 넘기면 플랫폼마다 반응이 달라 먼저 확인한다
      // (rm 의 force:false 가 하던 "없으면 오류"를 여기서 유지한다).
      await stat(p)
      await shell.trashItem(p)
    } catch (e) {
      return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
    }
  }
  return { ok: true }
}

/**
 * #90: 없으면 중간 단계까지 만든다(`mkdir -p` 상당). AI CLI 시작 창의 [없으면 만들기]가 쓴다 —
 * 원격은 `sftp:mkdir` 이 한 단계씩이라 렌더러가 훑지만(aiCliLaunch.ensureRemoteDir), 로컬은
 * node 가 recursive 를 그냥 해 준다. **makeDir 과 달리 경로 구분자를 허용한다** — 여기 오는 값은
 * 사용자가 폼에 적은 전체 경로이지 "이 폴더 안의 새 이름"이 아니다(그래서 invalidName 을 안 탄다).
 */
export async function makeDirP(path: string): Promise<FileOpResult> {
  try {
    await mkdir(resolve(path), { recursive: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
  }
}

/**
 * 이름 충돌 회피용 후보 이름(순수 — 단위 테스트 대상). 브라우저와 같은 규칙: `보고서 (2).xlsx`.
 * 확장자는 **마지막 점 기준**이라 `a.tar.gz` → `a.tar (2).gz` 가 된다. 아쉽지만 basename/extname
 * 과 같은 해석이라 앱 안에서 규칙이 하나로 유지된다(여기서만 다르게 쪼개면 그게 더 헷갈린다).
 */
export function nthName(name: string, n: number): string {
  if (n <= 1) return name
  const ext = extname(name)
  return `${basename(name, ext)} (${n})${ext}`
}

/**
 * `dir` 안에서 비어 있는 이름을 찾는다. 덮어쓰기는 **하지 않는다** — 조용한 덮어쓰기는 조용한
 * 삭제와 같다. 1000 까지 찾아보고 못 찾으면 그대로 돌려준다(그 지경이면 쓰기에서 실패하는 편이 낫다).
 */
export async function freeName(dir: string, name: string): Promise<string> {
  for (let n = 1; n <= 1000; n++) {
    const candidate = nthName(name, n)
    try {
      await access(join(dir, candidate))
    } catch {
      return candidate // 접근 실패 = 없다
    }
  }
  return name
}
