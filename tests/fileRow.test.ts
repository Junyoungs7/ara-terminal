// 파일 트리 행 종류 — 심볼릭 링크가 파일로만 보이던 것(준영님 제보)을 갈라낸 분기.
// 링크 폴더가 'dir' 로 안 나오면 더블클릭해도 들어갈 수 없고, 끊긴 링크가 걸러지지 않으면
// 있지도 않은 대상을 내려받으려다 실패한다 — 그 두 회귀를 잡는다.
import { describe, it, expect } from 'vitest'
import { rowKind } from '../src/renderer/components/FileTree'
import type { FileEntry } from '../src/shared/ipc'

const e = (p: Partial<FileEntry>): FileEntry => ({ name: 'x', type: 'file', size: 0, mtime: 0, ...p })

describe('파일 트리 행 종류', () => {
  it('링크가 아니면 종류 그대로', () => {
    expect(rowKind(e({ type: 'dir' }))).toBe('dir')
    expect(rowKind(e({ type: 'file' }))).toBe('file')
  })

  it('링크는 대상 종류로 갈린다 — 폴더 링크는 폴더처럼 동작해야 한다', () => {
    expect(rowKind(e({ type: 'dir', link: true }))).toBe('linkDir')
    expect(rowKind(e({ type: 'file', link: true }))).toBe('linkFile')
  })

  it('끊긴 링크가 최우선 — 들어가지도 내려받지도 않는다', () => {
    expect(rowKind(e({ type: 'dir', link: true, broken: true }))).toBe('broken')
    expect(rowKind(e({ type: 'file', link: true, broken: true }))).toBe('broken')
  })

  it('링크가 아닌데 broken 플래그만 있으면 무시한다(일반 파일·폴더로 취급)', () => {
    expect(rowKind(e({ type: 'dir', broken: true }))).toBe('dir')
  })
})
