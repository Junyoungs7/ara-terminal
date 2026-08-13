// RDP 클립보드 — 원격이 올려 보낸 항목 중 어느 것을 쓸지 고르는 순수 로직.
// 원격은 한 번에 여러 형식을 올린다(text/plain · text/html · 이미지…). 여기서 잘못 고르면
// 원격에서 Ctrl+C 한 뒤 로컬에 붙여넣었을 때 HTML 태그가 쏟아지거나 아무것도 안 붙는다.
import { describe, it, expect } from 'vitest'
import {
  clipboardSignature,
  pickClipboardText,
  shouldAnnounceClipboard,
  type RdpClipItem
} from '../src/renderer/components/rdpInput'

const item = (mime: string, value: unknown): RdpClipItem => ({ mimeType: () => mime, value: () => value })
// wasm 객체가 이미 해제되면 접근이 던진다 — 하나가 죽어도 나머지는 살려야 한다.
const dead = (): RdpClipItem => ({
  mimeType: () => {
    throw new Error('freed')
  },
  value: () => {
    throw new Error('freed')
  }
})

describe('클립보드 항목 고르기', () => {
  it('text/plain 을 고른다', () => {
    expect(pickClipboardText([item('text/plain', '배포 완료')])).toBe('배포 완료')
  })

  it('charset 이 붙어도 text/plain 이다', () => {
    expect(pickClipboardText([item('text/plain;charset=utf-8', 'ls -al')])).toBe('ls -al')
  })

  it('html 과 plain 이 함께 오면 plain 이 이긴다 — 태그를 붙여넣으면 안 된다', () => {
    const items = [item('text/html', '<b>hi</b>'), item('text/plain', 'hi')]
    expect(pickClipboardText(items)).toBe('hi')
  })

  it('plain 이 없으면 다른 text/* 라도 받는다(html 만 주는 원격이 있다)', () => {
    expect(pickClipboardText([item('text/html', '<b>hi</b>')])).toBe('<b>hi</b>')
  })

  it('이미지만 오면 null — 텍스트만 다룬다(이미지는 별개 작업)', () => {
    expect(pickClipboardText([item('image/png', new Uint8Array([1, 2]))])).toBeNull()
  })

  it('빈 목록은 null', () => {
    expect(pickClipboardText([])).toBeNull()
  })

  it('빈 문자열은 고르지 않는다 — 원격 클립보드를 비우면서 빈 값이 올라온다', () => {
    expect(pickClipboardText([item('text/plain', '')])).toBeNull()
  })

  it('값이 문자열이 아니면 건너뛴다(형식은 text 인데 바이너리로 오는 경우)', () => {
    const items = [item('text/plain', new Uint8Array([1])), item('text/plain', 'ok')]
    expect(pickClipboardText(items)).toBe('ok')
  })

  it('해제된 항목이 섞여 있어도 나머지에서 고른다(크래시 없음)', () => {
    expect(pickClipboardText([dead(), item('text/plain', 'ok')])).toBe('ok')
    expect(pickClipboardText([dead()])).toBeNull()
  })
})

// ── 소유권 ────────────────────────────────────────────────────────────────
// RDP 클립보드는 방향별로 하나뿐이고 마지막에 복사한 쪽이 주인이다. 우리가 포커스마다 무조건
// 로컬 클립보드를 알리면, 원격에서 방금 복사한 파일이 로컬은 그대로인데도 덮여 [원격 파일 받기] 가
// 깨진다(준영님 질문으로 드러난 실제 결함) — 그 판단을 여기서 못 박는다.
describe('클립보드 지문', () => {
  it('파일이 있으면 파일이 우선 — 탐색기 복사는 경로 텍스트도 함께 올린다', () => {
    expect(clipboardSignature({ paths: ['C:/a.txt'], text: 'C:/a.txt' })).toBe('f:C:/a.txt')
  })
  it('여러 파일은 순서까지 지문에 든다(다른 선택은 다른 지문)', () => {
    expect(clipboardSignature({ paths: ['a', 'b'] })).not.toBe(clipboardSignature({ paths: ['b', 'a'] }))
  })
  it('파일이 없으면 텍스트', () => {
    expect(clipboardSignature({ text: 'ls -al' })).toBe('t:ls -al')
  })
  it('빈 클립보드는 지문이 없다', () => {
    expect(clipboardSignature({})).toBeNull()
    expect(clipboardSignature({ paths: [], text: '' })).toBeNull()
  })
})

describe('원격에 알릴지 판단', () => {
  it('처음 보는 로컬 복사는 알린다', () => {
    expect(shouldAnnounceClipboard('t:abc', null, null)).toBe(true)
  })
  it('빈 클립보드는 알리지 않는다', () => {
    expect(shouldAnnounceClipboard(null, null, null)).toBe(false)
  })
  it('★ 이미 알린 것과 같으면 알리지 않는다 — 알리는 순간 원격의 복사를 빼앗는다', () => {
    expect(shouldAnnounceClipboard('t:abc', 't:abc', null)).toBe(false)
  })
  it('★ 원격이 준 것을 되돌려 보내지 않는다(에코)', () => {
    expect(shouldAnnounceClipboard('t:from-remote', null, 't:from-remote')).toBe(false)
  })
  it('로컬에서 새로 복사했으면 알린다 — 주인을 되찾는 게 맞다(마지막 복사가 이긴다)', () => {
    expect(shouldAnnounceClipboard('t:new', 't:old', 't:from-remote')).toBe(true)
    expect(shouldAnnounceClipboard('f:C:/x.zip', 't:old', 't:from-remote')).toBe(true)
  })
  it('원격 파일 복사 뒤 로컬이 그대로면 알리지 않는다 — [원격 파일 받기] 가 살아 있어야 한다', () => {
    // 원격이 파일을 알리면 announced 는 지워지지만(주인이 원격), 로컬 지문은 fromRemote 와 같아
    // (원격 텍스트를 로컬에 써 뒀다) 다시 알리지 않는다.
    expect(shouldAnnounceClipboard('t:remote-text', null, 't:remote-text')).toBe(false)
  })
})
