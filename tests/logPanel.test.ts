// 로그 패널 — 긴 로그를 "파일로 나누지 않고" 다루는 핵심 로직.
// 창(window) 이어 붙이기가 어긋나면 사용자는 중간이 빈 로그를 보게 되는데, 화면상으론 티가 안 난다
// (그냥 줄이 없는 것처럼 보인다) — 그래서 여기서 바이트 단위로 못 박는다.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LOG_CHUNK, bufferToText, readFileWindow } from '../src/main/log/readSessionLog'
import { clampLogWidth, filterLogLines } from '../src/renderer/components/LogPanel'

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function makeLog(lines: number): { path: string; content: string } {
  dir = mkdtempSync(join(tmpdir(), 'ev-logpanel-'))
  // 한 줄 ~80바이트 × lines. 한글을 섞어 멀티바이트 경계도 지나가게 한다.
  const content = Array.from({ length: lines }, (_, i) => `${String(i).padStart(6, '0')} 배포 로그 줄 ${'x'.repeat(50)}`).join('\n') + '\n'
  const path = join(dir, 'a.log')
  writeFileSync(path, content, 'utf8')
  return { path, content }
}

describe('로그 창 읽기(뒤에서부터)', () => {
  it('작은 파일은 한 창에 다 들어오고 start=0(앞이 더 없음)', () => {
    const { path, content } = makeLog(10)
    const res = readFileWindow(path)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.start).toBe(0)
    expect(res.text).toBe(content)
    expect(res.source).toBe('file')
  })

  it('큰 파일은 마지막 창만 준다 — 앞은 잘리고 첫 줄은 반 토막이 아니다', () => {
    const { path } = makeLog(20000) // ≈1.6MB > LOG_CHUNK
    const res = readFileWindow(path)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.start).toBeGreaterThan(0)
    expect(Buffer.byteLength(res.text, 'utf8')).toBeLessThanOrEqual(LOG_CHUNK)
    // 줄 경계에서 잘렸다 = 첫 줄이 온전한 줄 번호로 시작한다(반 토막이면 숫자 6자리가 안 맞는다).
    expect(res.text.split('\n')[0]).toMatch(/^\d{6} 배포/)
    // 마지막 줄까지 들어 있다.
    expect(res.text.trimEnd().endsWith('x'.repeat(50))).toBe(true)
  })

  it('before 로 앞쪽 창을 이어 붙이면 파일 전체가 정확히 복원된다(빈 구간·중복 없음)', () => {
    const { path, content } = makeLog(20000)
    let acc = ''
    let before: number | undefined = undefined
    for (let i = 0; i < 50; i++) {
      const res = readFileWindow(path, before)
      expect(res.ok).toBe(true)
      if (!res.ok) return
      acc = res.text + acc
      if (res.start === 0) break
      before = res.start
    }
    expect(acc).toBe(content)
  })

  it('없는 파일은 구조화 오류(크래시 없음)', () => {
    const { path } = makeLog(1)
    expect(readFileWindow(path + '.nope').ok).toBe(false)
  })
})

describe('링버퍼 → 텍스트', () => {
  it('ANSI 를 벗기고 비밀번호로 보이는 값을 가린다(내려받은 파일에 남으면 안 된다)', () => {
    const raw = Buffer.from('\x1b[32m$ deploy\x1b[0m\r\nPassword: hunter2\r\n', 'utf8')
    const out = bufferToText(raw)
    expect(out).toContain('$ deploy')
    expect(out).not.toContain('\x1b[32m')
    expect(out).not.toContain('hunter2')
  })
})

describe('로그 검색', () => {
  const text = 'first line\nSECOND line\n세 번째 줄\n'
  it('빈 검색어는 전부 보여 준다', () => {
    expect(filterLogLines(text, '   ')).toEqual(['first line', 'SECOND line', '세 번째 줄', ''])
  })
  it('대소문자를 가리지 않는다', () => {
    expect(filterLogLines(text, 'second')).toEqual(['SECOND line'])
  })
  it('한글도 찾는다', () => {
    expect(filterLogLines(text, '세 번째')).toEqual(['세 번째 줄'])
  })
  it('없으면 빈 목록', () => {
    expect(filterLogLines(text, 'nope')).toEqual([])
  })
})

// 우측 패널 폭 — 너무 좁으면 로그 한 줄이 계속 접히고, 너무 넓으면 터미널을 잡아먹는다.
describe('로그 패널 폭 클램프', () => {
  it('상·하한 밖은 잘라 낸다', () => {
    expect(clampLogWidth(100)).toBe(260)
    expect(clampLogWidth(9999)).toBe(720)
    expect(clampLogWidth(400)).toBe(400)
  })
  it('소수는 정수로 — 픽셀 경계가 흐려지면 리사이저가 떨린다', () => {
    expect(clampLogWidth(400.6)).toBe(401)
  })
})
