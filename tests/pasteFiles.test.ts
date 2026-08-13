// 붙여넣기 라우팅 — 어느 대상이 이 붙여넣기를 받는가.
//
// 왜 순수 함수로 뺐나: 잘못 고르면 이름 변경 칸에 붙여넣으려던 텍스트가 서버로 업로드되거나,
// 반대로 터미널 붙여넣기가 통째로 죽는다. 둘 다 조용히 일어나서 화면만 봐선 모른다.
import { describe, it, expect } from 'vitest'
import { pickPasteTarget, filePaths, type PasteTarget } from '../src/renderer/store/pasteFiles'

// 가짜 DOM — contains 만 있으면 된다(jsdom 없이 돈다).
function node(name: string, children: string[] = []): HTMLElement {
  const el = {
    __name: name,
    tagName: 'DIV',
    isContentEditable: false,
    contains(x: Element | null): boolean {
      if (x === null) return false
      const n = (x as unknown as { __name?: string }).__name
      return n === name || (n !== undefined && children.includes(n))
    }
  }
  return el as unknown as HTMLElement
}
function input(name: string, tag = 'INPUT'): HTMLElement {
  return { __name: name, tagName: tag, isContentEditable: false, contains: () => false } as unknown as HTMLElement
}

const target = (el: HTMLElement, allowEditable?: boolean): PasteTarget => ({ el, onFiles: () => true, allowEditable })

describe('붙여넣기 대상 고르기', () => {
  it('포커스가 대상 안에 있으면 그 대상', () => {
    const tree = node('tree', ['row'])
    const t = target(tree)
    expect(pickPasteTarget([t], node('row'))).toBe(t)
  })

  it('포커스가 대상 자신이어도 된다', () => {
    const tree = node('tree')
    const t = target(tree)
    expect(pickPasteTarget([t], tree)).toBe(t)
  })

  it('포커스가 밖이면 아무도 안 받는다 — 엉뚱한 곳으로 업로드되면 안 된다', () => {
    expect(pickPasteTarget([target(node('tree'))], node('elsewhere'))).toBeNull()
  })

  it('포커스가 없으면(null) 아무도 안 받는다', () => {
    expect(pickPasteTarget([target(node('tree'))], null)).toBeNull()
  })

  it('★ 입력칸에 포커스가 있으면 트리는 받지 않는다 — 이름 변경 중 붙여넣기는 그 칸의 몫이다', () => {
    const tree = node('tree', ['edit'])
    expect(pickPasteTarget([target(tree)], input('edit'))).toBeNull()
  })

  it('★ 터미널은 입력칸이어도 받는다 — xterm 의 숨은 textarea 가 곧 터미널이다', () => {
    const term = node('term', ['xta'])
    const t = target(term, true)
    expect(pickPasteTarget([t], input('xta', 'TEXTAREA'))).toBe(t)
  })

  it('contenteditable 도 입력칸으로 본다', () => {
    const tree = node('tree', ['ce'])
    const ce = { __name: 'ce', tagName: 'DIV', isContentEditable: true, contains: () => false } as unknown as HTMLElement
    expect(pickPasteTarget([target(tree)], ce)).toBeNull()
  })

  it('겹치면 나중에 등록된 것이 이긴다(안쪽이 나중에 붙는다)', () => {
    const outer = node('outer', ['inner', 'x'])
    const inner = node('inner', ['x'])
    const a = target(outer)
    const b = target(inner)
    expect(pickPasteTarget([a, b], node('x'))).toBe(b)
  })
})

describe('File → 경로', () => {
  const f = (name: string, path?: string): File => ({ name, path } as unknown as File)

  it('Electron 이 실어 준 실경로를 뽑는다 — 여러 개 그대로', () => {
    expect(filePaths([f('a.txt', 'C:/a.txt'), f('b.txt', 'C:/b.txt')])).toEqual(['C:/a.txt', 'C:/b.txt'])
  })
  it('경로 없는 항목은 버린다(브라우저 File — 업로드할 실체가 없다)', () => {
    expect(filePaths([f('a.txt'), f('b.txt', 'C:/b.txt')])).toEqual(['C:/b.txt'])
  })
  it('빈 목록은 빈 목록', () => {
    expect(filePaths([])).toEqual([])
  })
})
