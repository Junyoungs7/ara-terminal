// 파일 트리 행 종류 — 심볼릭 링크가 파일로만 보이던 것(준영님 제보)을 갈라낸 분기.
// 링크 폴더가 'dir' 로 안 나오면 더블클릭해도 들어갈 수 없고, 끊긴 링크가 걸러지지 않으면
// 있지도 않은 대상을 내려받으려다 실패한다 — 그 두 회귀를 잡는다.
import { describe, it, expect } from 'vitest'
import { fileIconKind, rowKind } from '../src/renderer/components/FileTree'
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

// 2026-08-22 준영님 제보 25번 — "파일 아이콘을 실제 엑셀·mp4·ppt 등 다양한 확장자에 맞게".
describe('fileIconKind', () => {
  it('대표 확장자를 갈래로 묶는다', () => {
    expect(fileIconKind('매출.xlsx')).toBe('sheet')
    expect(fileIconKind('보고서.docx')).toBe('doc')
    expect(fileIconKind('제안.pptx')).toBe('slide')
    expect(fileIconKind('계약.pdf')).toBe('pdf')
    expect(fileIconKind('회의록.hwp')).toBe('doc')
    expect(fileIconKind('clip.mp4')).toBe('video')
    expect(fileIconKind('bgm.mp3')).toBe('audio')
    expect(fileIconKind('shot.PNG')).toBe('image') // 대소문자 무시
    expect(fileIconKind('backup.tar.gz')).toBe('zip') // 마지막 확장자를 본다
    expect(fileIconKind('main.ts')).toBe('code')
  })

  it('확장자가 없거나 모르면 기본 종이다', () => {
    expect(fileIconKind('Makefile')).toBe('plain')
    expect(fileIconKind('data.unknownext')).toBe('plain')
    expect(fileIconKind('')).toBe('plain')
  })

  it('숨김 파일의 앞점은 확장자 구분자가 아니다', () => {
    // '.gitignore' 를 확장자 'gitignore' 로 읽으면 안 된다 — 이름 전체가 파일명이다.
    expect(fileIconKind('.gitignore')).toBe('plain')
    expect(fileIconKind('.env')).toBe('plain')
    // 숨김이면서 확장자가 있는 경우는 확장자를 본다.
    expect(fileIconKind('.eslintrc.json')).toBe('code')
  })
})
