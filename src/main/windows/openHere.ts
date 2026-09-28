// 탐색기 주소창에 `아라` → 그 폴더에서 로컬 셸 하나 (R14 · 준영님: "탐색기에서 cmd 치면 그 경로에서
// cmd 가 뜨잖아. 아라도 그렇게.").
//
// 탐색기는 App Paths(설치 프로그램이 건다 — resources/installer.nsh)로 우리를 찾아 **그 폴더를 작업
// 폴더로** 띄운다. 인자는 못 싣는다(App Paths 에는 인자 칸이 없다) — 그래서 "탐색기가 띄웠나"를
// 작업 폴더 하나로 가른다. 그 판정과 "렌더러가 복원을 끝낼 때까지 기다리기"를 여기 모은다.
// 검사: tests/openHere.test.ts
import { statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * 이 작업 폴더에서 셸을 열까. 열 거면 그 경로, 아니면 null(= 창만 앞으로).
 *
 * 🔴 **안 여는 자리가 핵심이다.** 바탕화면·시작 메뉴 아이콘은 작업 폴더가 설치 폴더다
 *    (electron-builder 가 `SetOutPath $INSTDIR` 뒤에 바로가기를 만든다). 이걸 안 거르면 **켜 둔 채로
 *    아이콘을 누를 때마다 셸이 하나씩** 쌓인다. 작업 폴더가 빈 바로가기는 explorer 의 것(System32)을
 *    물려받으니 Windows 폴더도, 업데이트 설치 프로그램이 띄우는 길을 위해 임시 폴더도 거른다.
 * ⚠️ Win+R `아라` 는 작업 폴더가 사용자 홈이라 **홈에서 셸이 열린다** — cmd 도 그렇게 하므로 둔다.
 */
export function folderToOpen(
  cwd: string | undefined,
  skip: { exeDir: string; winDir?: string; tmpDir?: string }
): string | null {
  if (!cwd || !isAbsolute(cwd)) return null
  const dir = resolve(cwd)
  if (samePath(dir, skip.exeDir)) return null
  if (skip.winDir && inside(dir, skip.winDir)) return null
  if (skip.tmpDir && inside(dir, skip.tmpDir)) return null
  try {
    return statSync(dir).isDirectory() ? dir : null
  } catch {
    return null // 없는 폴더·권한 없음 — 그냥 창만 앞으로
  }
}

// 윈도우 경로는 대소문자를 안 가린다. ponytail: mac 의 대소문자 구분 볼륨은 여기 올 일이 없다(탐색기 전용).
const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()
function inside(dir: string, root: string): boolean {
  const r = relative(root.toLowerCase(), dir.toLowerCase())
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/**
 * 폴더를 **언제** 여나. 렌더러가 부트 복원을 끝내기 전에 만든 세션은 `session:opened` 가 칸을 못
 * 잡는다(MainArea 의 restoreDone 주석 — 복원이 칸을 정하는 동안 리스너가 일부러 꺼져 있다). 그래서
 * 그 전에 온 폴더는 들고 있다가 렌더러가 `app:openLaunchDir` 로 "다 됐다"고 할 때 연다.
 *
 * 들고 있는 것은 **하나**다 — 부팅 중에 두 번 오면 나중 것이 이긴다. ponytail: 부팅 몇 초 사이에
 * 탐색기에서 두 번 치는 일은 드물다. 필요해지면 배열로.
 */
export function createOpenHere(open: (dir: string) => void): {
  /** 처음 뜰 때의 작업 폴더 · second-instance 의 workingDirectory — 이미 folderToOpen 을 지난 값 */
  arrive(dir: string | null): void
  /** 렌더러 복원이 끝났다. 기다리던 폴더를 열었으면 true */
  ready(): boolean
} {
  let pending: string | null = null
  let booted = false
  return {
    arrive(dir) {
      if (!dir) return
      if (booted) open(dir)
      else pending = dir
    },
    ready() {
      booted = true
      const dir = pending
      pending = null
      if (dir) open(dir)
      return Boolean(dir)
    }
  }
}
