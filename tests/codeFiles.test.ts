// M6 WS-07·08 코드 에디터 — 언어 감지 · 워크트리 밖 경로 거르기 · 밖에서 바뀜 판정 · 저장 결정(순수),
// 그리고 main 의 읽기·쓰기가 그 결정대로 디스크를 다루는지(임시 폴더 — 사용자 파일에 닿지 않는다).
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODE_READONLY_BYTES, decideWrite, isInsidePath, languageOf, onDiskChange } from '../src/shared/codeFiles'
import { readCode, writeCode } from '../src/main/code/io'

// Monaco getLanguages() 모양의 일부(실제 목록과 같은 필드).
const LANGS = [
  { id: 'typescript', extensions: ['.ts', '.tsx', '.cts', '.mts'] },
  { id: 'java', extensions: ['.java', '.jav'] },
  { id: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'] },
  { id: 'html', extensions: ['.html', '.htm'] },
  { id: 'handlebars', extensions: ['.handlebars', '.hbs'] },
  { id: 'fake-spec', extensions: ['.spec.ts'] }
]

describe('languageOf — Monaco 가 등록한 목록으로', () => {
  it('확장자', () => {
    expect(languageOf('C:\\repo\\src\\OrderRetryPolicy.java', LANGS)).toBe('java')
    expect(languageOf('/repo/a/App.TSX', LANGS)).toBe('typescript')
  })
  it('파일 이름이 확장자보다 먼저, 대소문자 무시', () => {
    expect(languageOf('/repo/Dockerfile', LANGS)).toBe('dockerfile')
    expect(languageOf('/repo/dockerfile', LANGS)).toBe('dockerfile')
  })
  it('겹치면 긴 확장자', () => {
    expect(languageOf('/repo/a.spec.ts', LANGS)).toBe('fake-spec')
  })
  it('모르면 plaintext', () => {
    expect(languageOf('/repo/notes.zzz', LANGS)).toBe('plaintext')
    expect(languageOf('/repo/Makefile', LANGS)).toBe('plaintext')
  })
})

describe('isInsidePath — main 이 루트 밖 요청을 거르는 기준', () => {
  it('안·같음', () => {
    expect(isInsidePath('C:\\ws\\shop', 'C:\\ws\\shop\\src\\a.ts', 'win32')).toBe(true)
    expect(isInsidePath('C:\\ws\\shop\\', 'c:/WS/shop/a.ts', 'win32')).toBe(true)
    expect(isInsidePath('/ws/shop', '/ws/shop', 'linux')).toBe(true)
  })
  it('밖·이름만 겹침·.. ·상대 경로', () => {
    expect(isInsidePath('C:\\ws\\shop', 'C:\\ws\\shop-api\\a.ts', 'win32')).toBe(false)
    expect(isInsidePath('C:\\ws\\shop', 'C:\\ws\\shop\\..\\other\\a.ts', 'win32')).toBe(false)
    expect(isInsidePath('/ws/shop', 'src/a.ts', 'linux')).toBe(false)
    expect(isInsidePath('/ws/shop', '/WS/shop/a.ts', 'linux')).toBe(false) // 리눅스는 대소문자를 가린다
  })
})

describe('onDiskChange — 열린 파일이 밖에서 바뀌었을 때', () => {
  it('서명이 그대로면 무시(내 저장·mtime 만)', () => expect(onDiskChange({ sig: 'a', dirty: true }, 'a')).toBe('ignore'))
  it('더럽지 않으면 조용히 다시 읽기', () => expect(onDiskChange({ sig: 'a', dirty: false }, 'b')).toBe('reload'))
  it('더러우면 충돌 안내', () => expect(onDiskChange({ sig: 'a', dirty: true }, 'b')).toBe('conflict'))
  it('지워졌으면 지워짐 안내', () => expect(onDiskChange({ sig: 'a', dirty: false }, null)).toBe('missing'))
})

describe('decideWrite — 저장 직전', () => {
  it('디스크가 연 때 그대로면 쓴다', () => expect(decideWrite('base', 'base', 'new')).toBe('write'))
  it('디스크가 이미 쓰려는 내용이면 안 쓴다', () => expect(decideWrite('new', 'base', 'new')).toBe('unchanged'))
  it('밖에서 바뀌었으면 묻는다', () => expect(decideWrite('other', 'base', 'new')).toBe('changed'))
  it('지워졌으면 묻는다', () => expect(decideWrite(null, 'base', 'new')).toBe('missing'))
})

describe('main readCode·writeCode — 디스크', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ara-code-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('읽기 → 고쳐 저장 → CRLF 보존', async () => {
    const p = join(dir, 'a.java')
    writeFileSync(p, 'class A {}\r\n// x\r\n')
    const r = await readCode(p)
    if (!r.ok) throw new Error(r.message)
    expect(r).toMatchObject({ text: 'class A {}\n// x\n', eol: 'crlf', readOnly: false })
    const w = await writeCode(p, 'class B {}\n', r.eol, r.sig)
    expect(w.ok).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe('class B {}\r\n')
    // 저장 결과의 서명 = 다시 읽은 서명(감시 알림이 와도 무시된다).
    const again = await readCode(p)
    expect(again.ok && w.ok && again.sig === w.sig).toBe(true)
  })

  it('밖에서 바뀐 뒤 저장 → 덮어쓰지 않고 changed, force 면 덮어쓴다', async () => {
    const p = join(dir, 'b.ts')
    writeFileSync(p, 'one\n')
    const r = await readCode(p)
    if (!r.ok) throw new Error(r.message)
    writeFileSync(p, 'agent wrote\n')
    expect(await writeCode(p, 'mine\n', r.eol, r.sig)).toEqual({ ok: false, conflict: 'changed' })
    expect(readFileSync(p, 'utf8')).toBe('agent wrote\n')
    expect((await writeCode(p, 'mine\n', r.eol, r.sig, true)).ok).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe('mine\n')
  })

  it('지워진 뒤 저장 → missing, 디스크가 이미 같은 내용이면 unchanged 로 성공', async () => {
    const p = join(dir, 'c.txt')
    writeFileSync(p, 'x\n')
    const r = await readCode(p)
    if (!r.ok) throw new Error(r.message)
    unlinkSync(p)
    expect(await writeCode(p, 'y\n', r.eol, r.sig)).toEqual({ ok: false, conflict: 'missing' })
    expect(await readCode(p)).toMatchObject({ ok: false, missing: true })
    writeFileSync(p, 'same\n')
    expect((await writeCode(p, 'same\n', 'lf', r.sig)).ok).toBe(true)
  })

  it('바이너리는 안 연다', async () => {
    const p = join(dir, 'd.bin')
    writeFileSync(p, Buffer.from([1, 0, 2]))
    expect((await readCode(p)).ok).toBe(false)
  })

  it('상한(Orca 50MB)을 넘으면 앞부분만 읽기 전용', async () => {
    const p = join(dir, 'big.log')
    writeFileSync(p, Buffer.alloc(CODE_READONLY_BYTES + 10, 'a'))
    const r = await readCode(p)
    expect(r.ok && r.readOnly && r.text.length === CODE_READONLY_BYTES && r.bytes === CODE_READONLY_BYTES + 10).toBe(true)
  })
})
