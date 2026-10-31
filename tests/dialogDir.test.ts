// ME-1 E4: Electron 43 에서 사라지는 "마지막 폴더 기억"을 아라가 대신 한다(src/main/util/dialogDir.ts).
import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { dialogDefaultPath, pickedDir } from '../src/main/util/dialogDir'

describe('dialogDir — 저장 대화상자 마지막 폴더', () => {
  it('기억이 없으면 이름만(없으면 undefined) — 43 기본(다운로드)으로 열린다', () => {
    expect(dialogDefaultPath(undefined, 'a.log')).toBe('a.log')
    expect(dialogDefaultPath(undefined)).toBeUndefined()
    expect(dialogDefaultPath('', '')).toBeUndefined()
  })

  it('기억이 있으면 그 폴더(이름이 있으면 그 안의 이름)', () => {
    const d = join('C:', 'logs')
    expect(dialogDefaultPath(d)).toBe(d)
    expect(dialogDefaultPath(d, 'a.log')).toBe(join(d, 'a.log'))
  })

  it('고른 결과 → 다음 폴더: 폴더는 그대로, 파일은 부모, 취소는 undefined', () => {
    const f = join('C:', 'logs', 'a.log')
    expect(pickedDir(f, false)).toBe(dirname(f))
    expect(pickedDir(dirname(f), true)).toBe(dirname(f))
    expect(pickedDir(undefined, true)).toBeUndefined()
  })
})
