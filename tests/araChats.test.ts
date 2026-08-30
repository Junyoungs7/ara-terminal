/**
 * 지난 아라 대화 목록(2026-08-26 준영님 요청 — *"claude code의 --resume 처럼 대화 목록"*).
 *
 * **Claude Code 의 기록을 읽기만 한다.** 우리 형식으로 다시 저장하지 않는 것이 이 파일의 전제라,
 * 검사도 그쪽 파일 모양(`~/.claude/projects/<폴더>/<uuid>.jsonl`)을 그대로 만들어 놓고 읽는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listAraChats, projectKey, projectDir, titleOf } from '../src/main/ai/araChats'
// registerAraIpc 는 ipc/handle.ts 를 거쳐 electron 을 잡는다. 여기서 보는 것은 id 모양 검증뿐이라
// 껍데기로 세운다(tests/secrets.test.ts 와 같은 방식).
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))
import { validResumeId } from '../src/main/ipc/registerAraIpc'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ara-chats-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const CWD = 'C:\\Users\\P24086\\AppData\\Roaming\\A.R.A\\ara-home'

/** 그 폴더에 대화 파일 하나를 놓는다. lines 는 jsonl 줄들. */
function put(cwd: string, id: string, lines: unknown[], at?: number): void {
  const dir = projectDir(cwd, home)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  if (at) utimesSync(path, new Date(at), new Date(at))
}

const userLine = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const hookLine = { type: 'system', subtype: 'hook', content: 'PONYTAIL MODE ACTIVE' }

describe('프로젝트 폴더 이름', () => {
  it('★ 영숫자가 아닌 글자를 전부 - 로 바꾼다(실측으로 확인한 Claude Code 규칙)', () => {
    expect(projectKey('D:\\AI\\OFA')).toBe('D--AI-OFA')
    expect(projectKey(CWD)).toBe('C--Users-P24086-AppData-Roaming-A-R-A-ara-home')
  })
})

describe('제목 다듬기', () => {
  it('여러 줄·연속 공백을 한 줄로 접는다', () => {
    expect(titleOf('  kvt \n\n 서버   열어줘 ')).toBe('kvt 서버 열어줘')
  })

  it('길면 자른다 — 목록 한 줄에 들어가야 한다', () => {
    const t = titleOf('가'.repeat(200))
    expect(t.length).toBeLessThanOrEqual(61)
    expect(t.endsWith('…')).toBe(true)
  })
})

describe('대화 목록', () => {
  it('★ 첫 질문이 제목이 된다(훅·시스템 줄은 건너뛴다)', () => {
    put(CWD, '11111111-1111-1111-1111-111111111111', [hookLine, userLine('kvt 서버 열어줘')])
    const rows = listAraChats(CWD, {}, home)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('kvt 서버 열어줘')
    expect(rows[0].name).toBe('')
  })

  it('★ 사람이 붙인 이름이 있으면 함께 온다(이름은 우리 것, 기록은 그쪽 것)', () => {
    const id = '22222222-2222-2222-2222-222222222222'
    put(CWD, id, [userLine('배포 점검')])
    const rows = listAraChats(CWD, { [id]: '금요일 배포' }, home)
    expect(rows[0].name).toBe('금요일 배포')
    // 이름을 붙여도 제목은 그대로 남는다 — 이름을 지우면 다시 이게 보인다.
    expect(rows[0].title).toBe('배포 점검')
  })

  it('최근 순으로 온다', () => {
    put(CWD, '33333333-3333-3333-3333-333333333333', [userLine('오래된 것')], 1_700_000_000_000)
    put(CWD, '44444444-4444-4444-4444-444444444444', [userLine('새 것')], 1_800_000_000_000)
    expect(listAraChats(CWD, {}, home).map((r) => r.title)).toEqual(['새 것', '오래된 것'])
  })

  it('폴더가 없으면 빈 목록 — 아직 대화를 안 한 것이지 오류가 아니다', () => {
    expect(listAraChats('D:\\nowhere', {}, home)).toEqual([])
  })

  it('uuid 가 아닌 파일·빈 파일은 목록에 없다', () => {
    const dir = projectDir(CWD, home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'x', 'utf8')
    writeFileSync(join(dir, '55555555-5555-5555-5555-555555555555.jsonl'), '', 'utf8')
    expect(listAraChats(CWD, {}, home)).toEqual([])
  })

  it('제목을 못 뽑아도 목록에는 남는다 — 빼면 이어서 열 길이 사라진다', () => {
    put(CWD, '66666666-6666-6666-6666-666666666666', [hookLine])
    const rows = listAraChats(CWD, {}, home)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('')
    expect(rows[0].id).toBe('66666666-6666-6666-6666-666666666666')
  })
})

/**
 * 2026-08-28 배포 전 감사 — **그 id 가 셸 명령줄에 들어간다.**
 *
 * `ara:open({resumeId})` 는 `--resume <id>` 로 나가고, 그 값은 엔진의 argv 로 들어간다. 그 파일이
 * 스스로 적어 둔 불변식은 "그 줄에 들어가는 것은 우리가 만든 값뿐"인데, IPC 는 참·거짓만 보고
 * 렌더러가 준 문자열을 그대로 실었다. 인용은 #152 에서 고쳤지만(`shell: true` 를 버리고 cmd 를
 * 직접 부른다) 인코더 하나에 기대는 것보다 모양으로 막는 편이 싸다 — 정상 UI 로는 못 만드는 값이다.
 */
describe('이어서 열 대화 id 검증', () => {
  it('★ uuid 모양만 통과한다 — 그 값이 셸 명령줄에 들어간다', () => {
    const ok = '77777777-7777-7777-7777-777777777777'
    expect(validResumeId(ok)).toBe(ok)
    for (const bad of [
      'x" & calc.exe & "',
      '77777777-7777-7777-7777-777777777777 && whoami',
      '$(id)',
      '`id`',
      '77777777-7777-7777-7777-77777777777', // 한 글자 짧다
      '77777777-7777-7777-7777-7777777777777', // 한 글자 길다
      '../../etc/passwd',
      '',
      null,
      undefined,
      42,
      { toString: () => ok }
    ]) {
      expect(validResumeId(bad), String(bad)).toBeNull()
    }
  })
})
