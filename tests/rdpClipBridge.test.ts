// #205 RDP 파일 ↔ 윈도우 클립보드 다리(main/rdp/rdpClipboard.ts). 텍스트 고르기는 rdpClipboard.test.ts.
//
// 🔴 **실제 클립보드를 건드리는 시험은 없다** — 준영님 PC 의 클립보드다. PowerShell 을 부르지 않고
// 인자 조립·출력 해석·상한·임시 폴더 수명만 순수하게 본다. 실제 Set/Get-Clipboard 는 실기 확인 목록에 있다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

import {
  LOCAL_TO_REMOTE_MAX,
  getClipboardCall,
  overLimit,
  parseFileDropOutput,
  setClipboardCall,
  stageFiles
} from '../src/main/rdp/rdpClipboard'

// 원격이 정할 수 있는 이름 중 명령 문자열에 섞이면 코드가 되는 것들.
const NASTY = [
  "C:\\t\\it's.txt",
  'C:\\t\\$(Remove-Item C:\\x).txt',
  'C:\\t\\back`tick`.txt',
  'C:\\t\\공백 있는 한글 파일.txt',
  'C:\\t\\"; calc; ".txt'
]

const decode = (args: string[]): string => {
  const i = args.indexOf('-EncodedCommand')
  return Buffer.from(args[i + 1], 'base64').toString('utf16le')
}

describe('PowerShell 인자 — 경로는 명령 문자열에 들어가지 않는다', () => {
  it('★ 어떤 이름을 넘겨도 인자(스크립트 포함)는 한 글자도 안 바뀐다', () => {
    const plain = setClipboardCall(['C:\\a.txt']).args
    for (const p of NASTY) expect(setClipboardCall([p]).args).toEqual(plain)
    expect(setClipboardCall(NASTY).args).toEqual(plain)
  })

  it('★ 경로는 env 의 JSON 으로만 가고, 그대로 되돌아온다(따옴표·$·백틱·공백·한글)', () => {
    const call = setClipboardCall(NASTY)
    expect(JSON.parse(call.env.ARA_CLIP_PATHS)).toEqual(NASTY)
    const script = decode(call.args)
    for (const p of NASTY) expect(script).not.toContain(p)
    expect(script).toContain('$env:ARA_CLIP_PATHS')
    expect(script).toContain('-LiteralPath') // -Path 면 [ ] * ? 가 와일드카드가 된다
  })

  it('셸을 안 타는 인자 배열이고 프로필을 읽지 않는다', () => {
    const { args } = getClipboardCall()
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(decode(args)).toContain('Get-Clipboard -Format FileDropList')
  })
})

describe('Get-Clipboard 출력 해석', () => {
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64') + '\r\n'

  it('base64(UTF-8 JSON) → 경로 목록, 한글이 안 깨진다', () => {
    expect(parseFileDropOutput(enc(NASTY))).toEqual(NASTY)
  })

  it('빈 클립보드([])·쓰레기·문자열 아닌 항목은 빈 목록/제외', () => {
    expect(parseFileDropOutput(enc([]))).toEqual([])
    expect(parseFileDropOutput('')).toEqual([])
    expect(parseFileDropOutput('not base64 json')).toEqual([])
    expect(parseFileDropOutput(enc({ value: ['C:\\a'] }))).toEqual([])
    expect(parseFileDropOutput(enc(['C:\\a', 3, '', null]))).toEqual(['C:\\a'])
  })
})

describe('로컬→원격 상한 100MB(합계)', () => {
  it('★ 합계로 본다 — 딱 100MB 는 되고 1바이트 넘으면 안 된다', () => {
    expect(LOCAL_TO_REMOTE_MAX).toBe(100 * 1024 * 1024)
    expect(overLimit([LOCAL_TO_REMOTE_MAX])).toBe(false)
    expect(overLimit([LOCAL_TO_REMOTE_MAX + 1])).toBe(true)
    expect(overLimit([60 * 1024 * 1024, 41 * 1024 * 1024])).toBe(true) // 하나씩은 작아도 합이 넘는다
    expect(overLimit([])).toBe(false)
  })
})

describe('임시 폴더 수명 — 다음 복사 때 앞의 것을 지운다', () => {
  let root: string
  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'ara-clip-')), 'rdp-clip')
  })
  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }))

  const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s))

  it('★ 두 번째로 받으면 첫 벌이 사라지고 새 벌만 남는다', async () => {
    const a = await stageFiles(root, [{ name: 'a.txt', bytes: bytes('A') }])
    expect(a.ok).toBe(true)
    const first = a.ok ? a.paths[0] : ''
    expect(readFileSync(first, 'utf8')).toBe('A')

    const b = await stageFiles(root, [{ name: 'b.txt', bytes: bytes('B') }])
    expect(b.ok).toBe(true)
    expect(existsSync(first)).toBe(false)
    if (b.ok) expect(readFileSync(b.paths[0], 'utf8')).toBe('B')
  })

  it('원격이 준 이름으로 폴더 밖에 못 쓴다 — 거절하고 아무것도 안 쓴다', async () => {
    for (const name of ['..\\..\\evil.txt', 'C:\\Windows\\x.dll', '..', 'a:b.txt']) {
      const r = await stageFiles(root, [{ name, bytes: bytes('x') }])
      // `..\..\evil.txt` 는 basename 으로 깎여 폴더 **안**에 쓰인다 — 밖으로 나가지 않는 것이 요점이다.
      if (r.ok) for (const p of r.paths) expect(p.startsWith(root)).toBe(true)
    }
    expect((await stageFiles(root, [{ name: '..', bytes: bytes('x') }])).ok).toBe(false)
  })

  it('같은 이름 둘은 덮어쓰지 않고 비켜 간다(대소문자 무시 — Windows 파일 시스템)', async () => {
    const r = await stageFiles(root, [
      { name: 'Same.txt', bytes: bytes('1') },
      { name: 'same.txt', bytes: bytes('2') }
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.paths).toHaveLength(2)
    expect(r.paths[0]).not.toBe(r.paths[1])
    expect(r.paths.map((p) => readFileSync(p, 'utf8'))).toEqual(['1', '2'])
  })
})
