// 로컬 파일시스템 백엔드 (R7) — [파일] 탭이 로컬 세션에서 쓰는 경로. 임시 디렉토리에 실제로
// 만들고 지우며 성공/실패를 함께 검증한다. 실패는 예외가 아니라 구조화 결과여야 한다(앱 크래시 금지).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

// #89: 삭제가 shell.trashItem 을 타므로 electron 을 대체한다. **진짜 휴지통에 갔는지는 여기서
// 확인할 수 없다**(그건 e2e·수동 몫) — 여기서 지키는 것은 그 앞의 규칙이다:
// 없는 경로는 trashItem 을 부르지 않고 오류로 끝난다 · 앞이 실패하면 뒤는 손대지 않는다.
// 대체 구현이 실제로 지우게 해서 "지워졌는지"까지 기존 테스트 그대로 볼 수 있게 한다.
const trashed: string[] = []
vi.mock('electron', () => ({
  shell: {
    trashItem: async (p: string) => {
      trashed.push(p)
      await rm(p, { recursive: true, force: true })
    }
  }
}))

const { list, renameEntry, makeDir, trash, invalidName, copyEntries, nthName, freeName } = await import(
  '../src/main/fs/LocalFs'
)

let root = ''

beforeEach(() => {
  trashed.length = 0
  root = mkdtempSync(join(tmpdir(), 'ara-fs-'))
  mkdirSync(join(root, '배포스크립트'))
  writeFileSync(join(root, '배포스크립트', 'deploy_운영.sh'), '#!/bin/sh\n')
  writeFileSync(join(root, 'README_한글.md'), '# 한글 문서\n')
  writeFileSync(join(root, 'access.log'), 'x'.repeat(2048))
})

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 정리 실패 무시 */
  }
})

describe('LocalFs — 목록', () => {
  it('폴더 우선 + 한글 이름 정렬 + 크기·mtime', async () => {
    const res = await list(root)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.path).toBe(root)
    expect(res.entries[0].type).toBe('dir')
    expect(res.entries[0].name).toBe('배포스크립트')
    const log = res.entries.find((e) => e.name === 'access.log')!
    expect(log.type).toBe('file')
    expect(log.size).toBe(2048)
    expect(log.mtime).toBeGreaterThan(0)
    // 상위 경로는 main 이 계산해 내려준다(렌더러가 플랫폼 구분자를 몰라도 되도록).
    expect(res.parent.length).toBeLessThan(res.path.length)
  })

  it("'.' 는 홈 디렉토리 — 로컬 세션 [파일] 탭의 시작 위치", async () => {
    const res = await list('.')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.path).toBe(homedir())
  })

  it('없는 경로 → 예외 대신 구조화 오류', async () => {
    const res = await list(join(root, '없는폴더'))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain('찾을 수 없습니다')
  })
})

describe('LocalFs — 이름 변경', () => {
  it('성공: 파일·폴더 이름이 실제로 바뀐다', async () => {
    expect(await renameEntry(join(root, 'README_한글.md'), '읽어보기.md')).toEqual({ ok: true })
    expect(existsSync(join(root, '읽어보기.md'))).toBe(true)
    expect(existsSync(join(root, 'README_한글.md'))).toBe(false)
  })

  it('실패: 경로 구분자가 든 이름은 거부(디렉토리 탈출 차단)', async () => {
    const res = await renameEntry(join(root, 'access.log'), '../탈출.log')
    expect(res.ok).toBe(false)
    // 상위로 나간 파일이 만들어지지 않았다.
    expect(existsSync(join(root, 'access.log'))).toBe(true)
    expect(invalidName('..')).not.toBeNull()
    expect(invalidName('a/b')).not.toBeNull()
    expect(invalidName('  ')).not.toBeNull()
    expect(invalidName('정상이름.txt')).toBeNull()
  })

  // D4(F23 보안 리뷰) 회귀 — Windows 예약 장치명(CON/NUL/COM1 등)은 디렉토리 탈출은 아니지만
  // 로컬 오작동(콘솔 디바이스로 열림 등)을 일으킨다. sftp_download 도 이 함수를 공유한다.
  it('실패: Windows 예약 장치명(확장자 붙여도) 거부', () => {
    for (const n of ['CON', 'con', 'NUL', 'AUX', 'PRN', 'COM1', 'COM9', 'LPT1', 'LPT9', 'con.txt', 'NUL.log'])
      expect(invalidName(n)).not.toBeNull()
    // 예약어를 접두사로만 포함하는 정상 이름은 여전히 통과(오탐 없음).
    expect(invalidName('console.txt')).toBeNull()
    expect(invalidName('comment.md')).toBeNull()
  })

  it('실패: 없는 파일 → 구조화 오류', async () => {
    const res = await renameEntry(join(root, '없다.txt'), '있다.txt')
    expect(res.ok).toBe(false)
  })
})

describe('LocalFs — 새 폴더', () => {
  it('성공: 현재 위치에 폴더 생성', async () => {
    expect(await makeDir(root, '새 폴더')).toEqual({ ok: true })
    expect(statSync(join(root, '새 폴더')).isDirectory()).toBe(true)
  })

  it('실패: 같은 이름이 이미 있으면 거부', async () => {
    const res = await makeDir(root, '배포스크립트')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain('이미')
  })

  it('실패: 빈 이름 거부', async () => {
    expect((await makeDir(root, '   ')).ok).toBe(false)
  })
})

// W4sat F20: 탐색기 2패널 로컬↔로컬 복사(재귀) — 이동은 이 함수 + remove 를 호출측이 순서대로 부른다.
describe('LocalFs — 패널 간 복사', () => {
  it('성공: 파일·폴더(재귀)를 목적지에 복사하고 원본은 그대로 둔다', async () => {
    const dest = join(root, '__dest')
    mkdirSync(dest)
    const res = await copyEntries([join(root, 'README_한글.md'), join(root, '배포스크립트')], dest)
    expect(res).toEqual({ ok: true })
    expect(existsSync(join(dest, 'README_한글.md'))).toBe(true)
    expect(existsSync(join(dest, '배포스크립트', 'deploy_운영.sh'))).toBe(true)
    // 원본은 지워지지 않는다(이동은 이 함수 호출자가 remove 를 따로 부른다).
    expect(existsSync(join(root, 'README_한글.md'))).toBe(true)
  })

  it('실패: 목적지에 같은 이름이 이미 있으면 거부(덮어쓰지 않는다)', async () => {
    const dest = join(root, '__dest2')
    mkdirSync(dest)
    writeFileSync(join(dest, 'access.log'), '기존')
    const res = await copyEntries([join(root, 'access.log')], dest)
    expect(res.ok).toBe(false)
  })

  it('실패: 없는 경로는 구조화 오류(예외 없음)', async () => {
    const dest = join(root, '__dest3')
    mkdirSync(dest)
    const res = await copyEntries([join(root, '없는파일.txt')], dest)
    expect(res.ok).toBe(false)
  })
})

describe('LocalFs — 삭제(휴지통)', () => {
  it('성공: 파일 여러 개를 한 번에', async () => {
    const res = await trash([join(root, 'README_한글.md'), join(root, 'access.log')])
    expect(res).toEqual({ ok: true })
    expect(existsSync(join(root, 'README_한글.md'))).toBe(false)
    expect(existsSync(join(root, 'access.log'))).toBe(false)
  })

  it('성공: 내용이 있는 폴더도 통째로', async () => {
    expect(await trash([join(root, '배포스크립트')])).toEqual({ ok: true })
    expect(existsSync(join(root, '배포스크립트'))).toBe(false)
  })

  it('★ #89 영구 삭제가 아니라 휴지통을 거친다', async () => {
    await trash([join(root, 'access.log')])
    expect(trashed).toEqual([join(root, 'access.log')])
  })

  it('실패: 없는 경로는 성공으로 위장하지 않는다', async () => {
    const res = await trash([join(root, '없는파일.txt')])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain('찾을 수 없습니다')
  })

  it('★ 없는 경로는 휴지통 호출까지 가지 않는다 — 플랫폼마다 반응이 다르다', async () => {
    await trash([join(root, '없는파일.txt')])
    expect(trashed).toEqual([])
  })

  it('실패: 앞 항목이 실패하면 그 지점에서 멈춘다(뒤 항목은 남는다)', async () => {
    const res = await trash([join(root, '없는파일.txt'), join(root, 'access.log')])
    expect(res.ok).toBe(false)
    expect(existsSync(join(root, 'access.log'))).toBe(true)
  })
})

// #92: 받는 곳을 묻지 않으므로 이름이 겹칠 때 **덮어쓰지 않는 것**이 유일한 방어선이다.
// 조용한 덮어쓰기는 조용한 삭제와 같다.
describe('LocalFs — 겹치지 않는 이름', () => {
  it('nthName: 1 은 그대로, 2부터 브라우저와 같은 규칙', () => {
    expect(nthName('보고서.xlsx', 1)).toBe('보고서.xlsx')
    expect(nthName('보고서.xlsx', 2)).toBe('보고서 (2).xlsx')
    expect(nthName('보고서.xlsx', 10)).toBe('보고서 (10).xlsx')
  })

  it('nthName: 확장자가 없으면 뒤에 붙는다', () => {
    expect(nthName('Makefile', 2)).toBe('Makefile (2)')
  })

  it('nthName: 점으로 시작하는 이름은 확장자가 아니다', () => {
    // extname('.env') === '' — basename 도 같은 해석이라 앱 안에서 규칙이 하나로 유지된다.
    expect(nthName('.env', 2)).toBe('.env (2)')
  })

  it('★ nthName: 이중 확장자는 마지막 점 기준이다(알려진 한계 — 규칙을 하나로 유지한다)', () => {
    expect(nthName('backup.tar.gz', 2)).toBe('backup.tar (2).gz')
  })

  it('freeName: 비어 있으면 그대로', async () => {
    expect(await freeName(root, '새파일.txt')).toBe('새파일.txt')
  })

  it('★ freeName: 이미 있으면 (2), 그것도 있으면 (3) — 덮어쓰지 않는다', async () => {
    expect(await freeName(root, 'access.log')).toBe('access (2).log')
    writeFileSync(join(root, 'access (2).log'), 'x')
    expect(await freeName(root, 'access.log')).toBe('access (3).log')
  })

  it('freeName: 폴더 이름과 겹쳐도 피한다', async () => {
    expect(await freeName(root, '배포스크립트')).toBe('배포스크립트 (2)')
  })
})
