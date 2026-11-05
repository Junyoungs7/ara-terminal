// 끝남 띠 머리 글 — 1분 미만은 시간을 안 적고, 시간은 한국어로(fb2214 실측 "· 0m").
import { expect, it } from 'vitest'
import { koDuration } from '../src/renderer/features/aiws/ExitBand'

it('koDuration — 분·시간 한국어', () => {
  expect(koDuration(7 * 60_000 + 5_000)).toBe('7분')
  expect(koDuration(72 * 60_000)).toBe('1시간 12분')
  expect(koDuration(120 * 60_000)).toBe('2시간')
})
