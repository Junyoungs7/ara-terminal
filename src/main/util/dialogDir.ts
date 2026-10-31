// ME-1 E4(Electron 43): dialog 의 defaultPath 를 비우면 43 부터 다운로드 폴더에서 열린다.
// 그 전엔 OS 가 "마지막에 고른 폴더"를 기억해 줬다 — 그 동작을 아라가 대신 한다.
// 마지막 폴더는 워크스페이스 ui.lastDialogDir 에 하나만 둔다(OS 가 하던 것과 같이 대화상자끼리 공유).
// 순수 함수만 둔다 — 시험이 electron 없이 문다(tests/dialogDir.test.ts).
import { dirname, join } from 'node:path'

export type LastDir = { get: () => string | undefined; set: (dir: string) => void }

/** 넘길 defaultPath. 파일 이름이 있으면 마지막 폴더 안의 그 이름, 없으면 폴더 자체. 기억이 없으면 이름만. */
export function dialogDefaultPath(lastDir: string | undefined, name?: string): string | undefined {
  if (!lastDir) return name || undefined
  return name ? join(lastDir, name) : lastDir
}

/** 고른 결과에서 다음에 열 폴더. 폴더를 골랐으면 그 폴더, 파일이면 그 파일이 있는 폴더. */
export function pickedDir(path: string | undefined, isDir: boolean): string | undefined {
  if (!path) return undefined
  return isDir ? path : dirname(path)
}
