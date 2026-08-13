// 붙여넣기 출처 고르기. OS 클립보드에는 "언제 복사됐는지"가 없어서, 앱에서 복사할 때 찍어 둔
// 스냅샷과 비교하는 것이 유일한 단서다. 여기가 틀리면 [복사]→[붙여넣기]를 눌렀는데 몇 시간 전
// 윈도 탐색기에서 복사해 둔 엉뚱한 파일이 서버로 올라간다 — 조용히, 되돌릴 수도 없이.
import { describe, it, expect } from 'vitest'
import { pasteSource, sameClipList } from '../src/renderer/components/FileTree'

describe('sameClipList', () => {
  it('스냅샷이 없으면 같지 않다(비교할 것이 없다)', () => {
    expect(sameClipList(null, ['a'])).toBe(false)
  })
  it('내용과 순서가 같아야 같다', () => {
    expect(sameClipList(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameClipList(['b', 'a'], ['a', 'b'])).toBe(false)
    expect(sameClipList(['a'], ['a', 'b'])).toBe(false)
  })
  it('둘 다 비어 있으면 같다(탐색기 복사 없음 → 없음)', () => {
    expect(sameClipList([], [])).toBe(true)
  })
})

describe('붙여넣기 출처', () => {
  it('앱 복사만 있으면 앱', () => {
    expect(pasteSource([], null, true)).toBe('app')
  })

  it('OS 클립보드만 있으면 OS (기존 동작 — 탐색기에서 복사 → 앱에 붙여넣기)', () => {
    expect(pasteSource(['C:/a.txt'], null, false)).toBe('os')
  })

  it('둘 다 없으면 아무것도 안 한다', () => {
    expect(pasteSource([], null, false)).toBe('none')
  })

  it('앱에서 복사한 뒤 OS 클립보드가 그대로면 앱이 이긴다 — 방금 누른 [복사]가 최신이다', () => {
    // 앱 복사 당시 OS 클립보드엔 예전 파일이 있었고, 그 뒤로 바뀌지 않았다.
    expect(pasteSource(['C:/old.txt'], ['C:/old.txt'], true)).toBe('app')
  })

  it('앱에서 복사한 뒤 탐색기에서 다시 복사했으면 OS 가 이긴다 — 그게 더 최근이다', () => {
    expect(pasteSource(['C:/new.txt'], ['C:/old.txt'], true)).toBe('os')
  })

  it('앱 복사 당시 OS 클립보드가 비어 있었는데 그 뒤 탐색기에서 복사했으면 OS', () => {
    expect(pasteSource(['C:/new.txt'], [], true)).toBe('os')
  })

  it('앱 복사 당시에도 지금도 OS 클립보드가 비어 있으면 앱', () => {
    expect(pasteSource([], [], true)).toBe('app')
  })

  it('OS 목록의 순서만 달라져도 새 복사로 본다(다른 선택이다)', () => {
    expect(pasteSource(['b', 'a'], ['a', 'b'], true)).toBe('os')
  })
})
