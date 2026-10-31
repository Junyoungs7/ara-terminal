import { beforeEach, describe, expect, it } from 'vitest'
import {
  attention,
  dismissToast,
  hasUnread,
  installTestNotify,
  NOTE_CAP,
  notesNow,
  pushNote,
  readAllNotes,
  readNote,
  resetNotes,
  setNoteSpace,
  setToastsEnabled,
  TOAST_MAX,
  toastView
} from '../src/renderer/store/notify'
import { SETTINGS_INDEX } from '../src/shared/settingsIndex'
import { prefsFrom } from '../src/renderer/terminal/termPrefs'
import type { UiState } from '../src/shared/types'

// M1 라운드 3 알림 저장소 — 토스트 최대 3 + n · 읽음 · 맥박 판정(결정: 기다림만, 그 공간으로 가면 꺼짐).
const wait = (space: 'term' | 'ai' = 'ai') => pushNote({ kind: 'wait', space, title: 'w' })
const notes = () => notesNow().notes

describe('알림 저장소', () => {
  beforeEach(() => resetNotes())

  it('토스트는 셋까지, 넘치면 +n — 최신이 아래(마지막)', () => {
    const ids = [1, 2, 3, 4, 5].map(() => pushNote({ kind: 'done', space: 'term', title: 'x' }).id)
    const v = toastView(notes())
    expect(v.shown.map((n) => n.id)).toEqual(ids.slice(-TOAST_MAX))
    expect(v.more).toBe(2)
    // 하나 닫으면 숨어 있던 것이 올라온다.
    dismissToast(ids[4])
    const v2 = toastView(notes())
    expect(v2.shown.map((n) => n.id)).toEqual([ids[1], ids[2], ids[3]])
    expect(v2.more).toBe(1)
    // 닫아도 목록(벨)에는 남는다.
    expect(notes()).toHaveLength(5)
  })

  it('읽음 — 하나 · 모두. 하나를 열면 그 토스트도 걷힌다', () => {
    const a = wait()
    const b = wait()
    expect(hasUnread(notes())).toBe(true)
    readNote(a.id)
    expect(notes().find((n) => n.id === a.id)).toMatchObject({ read: true, toast: false })
    expect(hasUnread(notes())).toBe(true)
    readAllNotes()
    expect(hasUnread(notes())).toBe(false)
    expect(notes().find((n) => n.id === b.id)?.toast).toBe(true)
  })

  it('맥박 — 다른 공간의 안 읽은 wait 만. 끝남·오류는 켜지 않는다', () => {
    setNoteSpace('term')
    pushNote({ kind: 'done', space: 'ai', title: 'd' })
    pushNote({ kind: 'error', space: 'ai', title: 'e' })
    expect(attention(notes(), 'term')).toEqual({})
    wait('ai')
    expect(attention(notes(), 'term')).toEqual({ ai: true })
    // 지금 보는 공간에서 난 wait 는 이미 본 것.
    wait('term')
    expect(attention(notes(), 'term')).toEqual({ ai: true })
  })

  it('맥박 — 그 공간으로 가면 꺼지고, 돌아와도 다시 켜지지 않는다', () => {
    setNoteSpace('term')
    wait('ai')
    setNoteSpace('ai')
    expect(attention(notes(), 'ai')).toEqual({})
    setNoteSpace('term')
    expect(attention(notes(), 'term')).toEqual({})
    // 새 wait 는 다시 켠다.
    wait('ai')
    expect(attention(notes(), 'term')).toEqual({ ai: true })
  })

  it('맥박 — 읽으면 꺼진다', () => {
    setNoteSpace('ai')
    const n = wait('term')
    expect(attention(notes(), 'ai')).toEqual({ term: true })
    readNote(n.id)
    expect(attention(notes(), 'ai')).toEqual({})
  })

  it('토스트를 끄면 떠 있던 것도 걷히고 새 것은 토스트 없이 목록에만', () => {
    wait()
    setToastsEnabled(false)
    expect(toastView(notes()).shown).toHaveLength(0)
    wait()
    expect(toastView(notes()).shown).toHaveLength(0)
    expect(notes()).toHaveLength(2)
    setToastsEnabled(true)
    wait()
    expect(toastView(notes()).shown).toHaveLength(1)
  })

  it('목록 상한 — 오래된 것부터 버린다', () => {
    for (let i = 0; i < NOTE_CAP + 5; i++) pushNote({ kind: 'info', space: 'term', title: String(i) })
    expect(notes()).toHaveLength(NOTE_CAP)
    expect(notes()[0].title).toBe(String(NOTE_CAP + 4))
  })

  it('시험 훅은 켤 때만 설치된다', () => {
    const off: { __araTestNotify?: unknown } = {}
    installTestNotify(false, off)
    expect(off.__araTestNotify).toBeUndefined()
    const on: { __araTestNotify?: (n: { kind: 'wait'; space: 'ai'; title: string }) => number } = {}
    installTestNotify(true, on)
    expect(typeof on.__araTestNotify?.({ kind: 'wait', space: 'ai', title: 't' })).toBe('number')
    expect(notes()).toHaveLength(1)
  })
})

describe('설정 › 알림', () => {
  it('자리만이던 섹션이 토스트 토글을 갖는다', () => {
    const sec = SETTINGS_INDEX.find((s) => s.id === 'notify')
    expect(sec?.soon).toBeUndefined()
    expect(sec?.items.map((i) => i.id)).toEqual(['notify.toast', 'notify.sound'])
  })
  it('notifyToast — 미지정이면 켬, false 만 끔', () => {
    expect(prefsFrom({} as UiState).notifyToast).toBe(true)
    expect(prefsFrom({ notifyToast: false } as UiState).notifyToast).toBe(false)
  })
})
