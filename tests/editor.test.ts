// 편집기 창(노트) — "열어도 되는 파일인가" 규칙과 창 제목·해시 파싱. 여기가 틀리면 바이너리를
// 텍스트로 저장해 원본을 깨뜨리거나(되돌릴 수 없다), 큰 로그로 창이 멈춘다.
import { describe, it, expect } from 'vitest'
import { EDIT_MAX_BYTES, looksBinary } from '../src/shared/textFile'
import { fromEditorText, toEditorText } from '../src/main/editor/textIO'
import { editorTitle, parseEditorHash } from '../src/renderer/components/EditorWindow'

describe('편집기 열기 규칙', () => {
  it('NUL 이 있으면 바이너리로 본다(앞부분만 본다)', () => {
    expect(looksBinary(Buffer.from('#!/bin/sh\necho 배포\n'))).toBe(false)
    expect(looksBinary(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))).toBe(true)
    // 8KB 뒤의 NUL 은 못 본다 — 앞부분만 훑는 설계(비용). 그 경우도 저장은 UTF-8 로 나간다.
    const late = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])])
    expect(looksBinary(late)).toBe(false)
  })

  it('상한을 넘으면 열지 않는다 — 잘라서 열면 저장할 때 뒷부분이 날아간다', () => {
    const big = toEditorText(Buffer.alloc(EDIT_MAX_BYTES + 1, 0x41))
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.message).toContain('상한')
  })

  it('CRLF 파일은 편집 중 LF 로 보여 주고 저장할 때 되돌린다(줄바꿈만 바뀐 diff 방지)', () => {
    const res = toEditorText(Buffer.from('a\r\nb\r\n'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.eol).toBe('crlf')
    expect(res.text).toBe('a\nb\n')
    expect(fromEditorText(res.text, res.eol).toString('utf8')).toBe('a\r\nb\r\n')
  })

  it('LF 파일은 그대로 둔다', () => {
    const res = toEditorText(Buffer.from('가\n나\n'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.eol).toBe('lf')
    expect(fromEditorText(res.text, res.eol).toString('utf8')).toBe('가\n나\n')
  })

  it('바이너리는 거부한다', () => {
    expect(toEditorText(Buffer.from([0x00, 0x01, 0x02])).ok).toBe(false)
  })
})

describe('편집기 창 제목·해시', () => {
  it('제목은 "서버 - 파일명", 수정 중이면 ● 가 앞에 붙는다', () => {
    const t = { sessionId: 's1', path: '/etc/nginx/nginx.conf', server: 'dev-server' }
    expect(editorTitle(t, false)).toBe('dev-server - nginx.conf')
    expect(editorTitle(t, true)).toBe('● dev-server - nginx.conf')
  })

  it('Windows 경로도 파일명만 뽑는다', () => {
    expect(editorTitle({ sessionId: null, path: 'D:\\AI\\OFA\\README.md', server: '로컬' }, false)).toBe(
      '로컬 - README.md'
    )
  })

  it('해시에서 대상을 복원한다(공백·한글 경로 포함)', () => {
    const hash = '#editor?path=' + encodeURIComponent('/srv/한글 폴더/설정.yml') + '&server=kvt&session=abc'
    expect(parseEditorHash(hash)).toEqual({ path: '/srv/한글 폴더/설정.yml', server: 'kvt', sessionId: 'abc' })
  })

  it('편집기 해시가 아니면 null — 메인 창은 평소대로 Shell 을 띄운다', () => {
    expect(parseEditorHash('')).toBeNull()
    expect(parseEditorHash('#editor')).toBeNull() // path 없음
    expect(parseEditorHash('#something?path=/x')).toBeNull()
  })

  it('로컬 파일은 session 없이 온다', () => {
    const hash = '#editor?path=%2Ftmp%2Fa.txt&server=' + encodeURIComponent('로컬')
    expect(parseEditorHash(hash)).toEqual({ path: '/tmp/a.txt', server: '로컬', sessionId: null })
  })
})
