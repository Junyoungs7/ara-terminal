// W1 트랙 C(F11 히스토리 · F14 파일 붙여넣기 · F15 미니 프리뷰) 순수 로직 검증.
// UI 배선(xterm 데코레이션·사이드바 레일)은 실기동 스크린샷 하네스가 확인하고, 여기서는
// "무엇을 기록하고 무엇을 기록하지 않는가" 처럼 눈으로 볼 수 없는 규칙을 못 박는다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  feedInput,
  ghostEligible,
  ghostFor,
  ghostList,
  shouldRecord,
  promptPrefix,
  isPasswordPrompt,
  appendHistory,
  cachedHistory,
  loadHistory,
  resetHistoryCache,
  HISTORY_MAX
} from '../src/renderer/store/history'
import { setUploader, uploadFiles } from '../src/renderer/store/uploadBus'
import { pastePaths } from '../src/renderer/components/filePath'
import { HistoryStore } from '../src/main/history/HistoryStore'
import {
  parseFileNameW,
  parseNSFilenames,
  keepUploadable,
  clipboardFilePaths,
  WIN_FORMAT,
  MAC_FORMAT,
  type ClipboardReader
} from '../src/main/util/clipboardFiles'

// ── F11: 입력 스트림 → 명령 수집 ──
describe('F11 입력 누적(feedInput)', () => {
  it('평범한 타이핑은 줄 버퍼에 쌓이고 Enter(CR)에서 한 줄로 끊긴다', () => {
    let buf = ''
    for (const ch of 'ls -al') buf = feedInput(buf, ch).buf
    expect(buf).toBe('ls -al')
    const end = feedInput(buf, '\r')
    expect(end.commands).toEqual(['ls -al'])
    expect(end.buf).toBe('')
  })

  it('여러 줄 붙여넣기는 한 청크에서 여러 명령으로 끊긴다', () => {
    const fed = feedInput('', 'cd /srv\rnpm run build\r')
    expect(fed.commands).toEqual(['cd /srv', 'npm run build'])
    expect(fed.buf).toBe('')
  })

  it('백스페이스는 마지막 글자를 지운다(한글도 한 글자 단위)', () => {
    expect(feedInput('git stat', '\x7f').buf).toBe('git sta')
    expect(feedInput('배포', '\x7f').buf).toBe('배')
  })

  it('한글·이모지는 코드포인트 단위로 쌓인다(surrogate 쪼개짐 없음)', () => {
    expect(feedInput('', 'echo 한글🚀').buf).toBe('echo 한글🚀')
  })

  it('ESC 시퀀스(방향키·히스토리 탐색)가 오면 그 줄은 버린다 — 재구성할 수 없다', () => {
    const fed = feedInput('ls -a', '\x1b[A')
    expect(fed.buf).toBe('')
    expect(fed.commands).toEqual([])
  })

  it('Tab(셸 자동완성)·Ctrl+C·Ctrl+U 뒤의 줄도 버린다', () => {
    expect(feedInput('cd /usr/lo', '\t').buf).toBe('')
    expect(feedInput('rm -rf /', '\x03').buf).toBe('')
    expect(feedInput('some long line', '\x15').buf).toBe('')
  })

  it('버린 줄은 Enter 를 눌러도 빈 명령으로 나온다(기록 대상에서 걸러진다)', () => {
    const after = feedInput(feedInput('cd /usr/lo', '\t').buf, '\r')
    expect(after.commands).toEqual([''])
    expect(shouldRecord('', '$ ')).toBe(false)
  })
})

// ── F11: 비밀번호 기록 금지 ──
describe('F11 수집 제외 규칙(shouldRecord)', () => {
  it('비밀번호 프롬프트 뒤의 입력은 기록하지 않는다(영문·한글·sudo·passphrase)', () => {
    // 비밀번호는 에코되지 않으므로 커서 줄은 프롬프트만 남는다.
    for (const prompt of [
      'Password:',
      "deploy@10.0.0.1's password:",
      '[sudo] password for deploy:',
      'Enter passphrase for key /home/deploy/.ssh/id_ed25519:',
      '비밀번호:',
      '암호를 입력하세요:'
    ]) {
      expect(shouldRecord('s3cr3t-not-stored', prompt)).toBe(false)
    }
  })

  it('명령 안에 password 라는 단어가 있어도 평범한 명령은 기록한다(오탐 금지)', () => {
    // 커서 줄 = 프롬프트 + 에코된 명령. 명령 부분을 떼고 프롬프트만 본다.
    expect(shouldRecord('echo password', '$ echo password')).toBe(true)
    expect(shouldRecord('grep -r 비밀번호 .', 'deploy@web:/srv$ grep -r 비밀번호 .')).toBe(true)
  })

  it('공백으로 시작하는 입력은 기록하지 않는다(셸 관례)', () => {
    expect(shouldRecord(' curl -H "Authorization: Bearer xxx" api', '$  curl -H ...')).toBe(false)
  })

  it('빈 줄·공백뿐인 줄은 기록하지 않는다', () => {
    expect(shouldRecord('', '$ ')).toBe(false)
    expect(shouldRecord('   ', '$ ')).toBe(false)
  })

  it('promptPrefix 는 에코된 입력을 떼고 프롬프트만 남긴다', () => {
    expect(promptPrefix('$ echo password', 'echo password')).toBe('$ ')
    // 에코가 없으면(비밀번호 입력) 줄 전체가 프롬프트다.
    expect(promptPrefix('Password:', 'hunter2')).toBe('Password:')
    expect(isPasswordPrompt('$ ')).toBe(false)
  })
})

// ── F11: 고스트 매칭 ──
describe('F11 인라인 고스트(ghostFor)', () => {
  const hist = ['npm run build', 'git status', 'npm run test', 'cd /srv/서비스']

  it('접두 일치하는 가장 최근 항목을 고른다', () => {
    expect(ghostFor(hist, 'npm')).toBe('npm run test')
    expect(ghostFor(hist, 'npm run b')).toBe('npm run build')
  })

  it('입력이 없거나 일치가 없으면 고스트도 없다', () => {
    expect(ghostFor(hist, '')).toBeNull()
    expect(ghostFor(hist, 'docker')).toBeNull()
  })

  /**
   * 🔴 **뜻이 뒤집힌 검사다.** 여기 있던 줄은 `ghostFor(hist, 'cd ')` 가 `cd /srv/서비스` 를
   * 준다고 못 박아 뒀다 — 그 동작이 바로 2026-09-08 준영님의 불편(*"작성할때 너무 불편한데"*)
   * 이었다. `cd ` 까지만 쳤을 때 사람이 원하는 것은 **지금 여기 폴더**지 어제 간 폴더가 아니다.
   * 지우지 않고 반대로 못 박는다: 그래야 되돌리는 사람이 "옛날엔 떴다"를 알고 되돌린다.
   */
  it('#194 ③ 공백으로 끝나면 안 뜬다 — `cd ` 에 어제 간 경로를 들이밀지 않는다', () => {
    expect(ghostFor(hist, 'cd ')).toBeNull()
    expect(ghostList(hist, 'cd ')).toEqual([])
  })

  it('#194 ③ 한 글자로는 안 뜬다 — `c` 는 히스토리 절반과 맞아 뜻이 없다', () => {
    expect(ghostFor(['cd /srv', 'cat log'], 'c')).toBeNull()
    // 두 글자부터 뜬다. 낱말이 아니라 **줄 전체** 길이가 기준이라 `cd w` 도 뜬다.
    expect(ghostFor(['cd /srv'], 'cd')).toBe('cd /srv')
    expect(ghostFor(['cd work/api'], 'cd w')).toBe('cd work/api')
  })

  it('이미 다 친 명령에는 고스트를 띄우지 않는다(더 보여 줄 것이 없다)', () => {
    expect(ghostFor(hist, 'git status')).toBeNull()
  })
})

// ── F11 R2: 후보 목록 (2026-08-22 준영님 제보 10번 — "IDE 처럼 목록으로") ──
describe('F11 후보 목록(ghostList)', () => {
  const hist = ['npm run build', 'git status', 'npm run test', 'npm run build', 'npm start']

  it('★ 최근 것부터 준다 — 목록의 첫 줄이 곧 고스트다', () => {
    const list = ghostList(hist, 'npm')
    expect(list[0]).toBe('npm start')
    expect(list[0]).toBe(ghostFor(hist, 'npm'))
  })

  it('★ 같은 명령은 한 번만 — 어제도 오늘도 친 명령이 목록을 채우면 고를 것이 없다', () => {
    // 'npm run build' 는 두 번 있지만 한 줄이고, 자리는 **최근에 친 쪽**(뒤쪽)이다.
    expect(ghostList(hist, 'npm')).toEqual(['npm start', 'npm run build', 'npm run test'])
  })

  it('개수를 넘기지 않는다(화면을 덮지 않게)', () => {
    const many = Array.from({ length: 30 }, (_, i) => `cmd ${i}`)
    expect(ghostList(many, 'cmd', 6)).toHaveLength(6)
    expect(ghostList(many, 'cmd', 6)[0]).toBe('cmd 29')
  })

  it('입력이 없거나 일치가 없으면 빈 목록', () => {
    expect(ghostList(hist, '')).toEqual([])
    expect(ghostList(hist, 'docker')).toEqual([])
  })

  it('#194 ③ 문턱은 ghostEligible 하나가 정한다 — 목록과 고스트가 갈리지 않게', () => {
    // TerminalPane 은 타이머를 걸기 전에 이 함수를 따로 부른다(안 뜰 입력엔 훑기도 안 한다).
    // 두 자리의 판정이 갈리면 "고스트는 없는데 목록만 뜬다" 같은 상태가 생긴다.
    expect(ghostEligible('c')).toBe(false)
    expect(ghostEligible('cd ')).toBe(false)
    expect(ghostEligible('cd')).toBe(true)
    expect(ghostEligible('cd w')).toBe(true)
  })

  it('다 친 명령은 후보가 아니다(고스트와 같은 규칙)', () => {
    expect(ghostList(hist, 'git status')).toEqual([])
  })
})

// ── F11: scope 분리 · 상한 · 중복 ──
describe('F11 렌더러 캐시(scope 분리 · 상한)', () => {
  const appended: { scope: string; command: string }[] = []

  beforeEach(() => {
    resetHistoryCache()
    appended.length = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      ev: {
        history: {
          load: (scope: string) =>
            Promise.resolve(scope === '결제서버' ? ['systemctl status pay'] : ['dir']),
          append: (scope: string, command: string) => {
            appended.push({ scope, command })
            return Promise.resolve({ ok: true })
          }
        }
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('scope 마다 따로 적재된다 — 다른 서버 명령이 섞이지 않는다', async () => {
    expect(await loadHistory('결제서버')).toEqual(['systemctl status pay'])
    expect(await loadHistory('local')).toEqual(['dir'])
    appendHistory('결제서버', 'tail -f /var/log/pay.log')
    expect(cachedHistory('local')).toEqual(['dir'])
    expect(ghostFor(cachedHistory('결제서버'), 'tail')).toBe('tail -f /var/log/pay.log')
    expect(ghostFor(cachedHistory('local'), 'tail')).toBeNull()
  })

  it('같은 명령을 연달아 치면 한 번만 남는다', async () => {
    await loadHistory('local')
    appendHistory('local', 'npm test')
    appendHistory('local', 'npm test')
    expect(cachedHistory('local')).toEqual(['dir', 'npm test'])
    expect(appended).toHaveLength(1)
  })

  it('scope 당 상한을 넘으면 오래된 것부터 버린다', async () => {
    await loadHistory('local')
    for (let i = 0; i < HISTORY_MAX + 20; i++) appendHistory('local', `cmd-${i}`)
    const list = cachedHistory('local')
    expect(list).toHaveLength(HISTORY_MAX)
    expect(list[list.length - 1]).toBe(`cmd-${HISTORY_MAX + 19}`)
    expect(list).not.toContain('dir') // 가장 오래된 항목이 밀려났다
  })
})

// ── F11: main 영속화 ──
describe('F11 HistoryStore(영속)', () => {
  let dir = ''
  let path = ''
  // append 는 디바운스 타이머를 예약한다 — 임시 디렉토리를 지우기 전에 flush 해서 타이머를 끈다.
  const opened: HistoryStore[] = []
  const store = (p = path): HistoryStore => {
    const s = new HistoryStore(p)
    opened.push(s)
    return s
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ara-hist-'))
    path = join(dir, 'history.json')
    opened.length = 0
  })
  afterEach(() => {
    for (const s of opened) s.flush()
    rmSync(dir, { recursive: true, force: true })
  })

  it('append → flush → 재기동 후에도 남는다(scope 분리)', () => {
    const s = store()
    s.append('local', 'dir')
    s.append('결제서버', 'systemctl restart pay')
    s.flush()
    const reopened = store()
    expect(reopened.load('local')).toEqual(['dir'])
    expect(reopened.load('결제서버')).toEqual(['systemctl restart pay'])
    expect(reopened.load('없는서버')).toEqual([])
  })

  it('scope 당 500 개 상한 — 넘으면 오래된 것부터 삭제', () => {
    const s = store()
    for (let i = 0; i < 620; i++) s.append('local', `cmd-${i}`)
    const list = s.load('local')
    expect(list).toHaveLength(500)
    expect(list[0]).toBe('cmd-120')
    expect(list[499]).toBe('cmd-619')
  })

  it('연속 중복은 남기지 않는다', () => {
    const s = store()
    s.append('local', 'ls')
    s.append('local', 'ls')
    s.append('local', 'pwd')
    s.append('local', 'ls')
    expect(s.load('local')).toEqual(['ls', 'pwd', 'ls'])
  })

  it('빈 값·잘못된 형은 무시한다(렌더러는 신뢰 경계 밖)', () => {
    const s = store()
    s.append('local', '')
    s.append('', 'ls')
    s.append(42 as unknown as string, 'ls')
    expect(s.load('local')).toEqual([])
  })

  it('손상된 파일로 기동해도 크래시 없이 빈 히스토리로 시작한다', () => {
    writeFileSync(path, '{ 이건 JSON 이 아니다')
    expect(store().load('local')).toEqual([])
    // 모양이 다른 정상 JSON 도 통째로 버린다(문자열 배열이 아니면 신뢰하지 않는다).
    writeFileSync(path, JSON.stringify({ local: [1, 2, 3] }))
    expect(store().load('local')).toEqual([])
  })

  it('디스크에 저장되는 모양은 { scope: string[] } 이다', () => {
    const s = store()
    s.append('local', 'echo 한글')
    s.flush()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ local: ['echo 한글'] })
  })
})

// ── F14: 클립보드 파일 판별 ──
describe('F14 클립보드 파일 경로', () => {
  let dir = ''
  let file = ''
  let sub = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ara-clip-'))
    file = join(dir, '배포_스크립트.sh')
    sub = join(dir, '하위폴더')
    writeFileSync(file, '#!/bin/sh\n')
    mkdirSync(sub)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('Windows FileNameW(UTF-16LE + NUL) 를 경로로 읽는다', () => {
    const buf = Buffer.from('C:\\작업\\배포.zip\0', 'utf16le')
    expect(parseFileNameW(buf)).toEqual(['C:\\작업\\배포.zip'])
    expect(parseFileNameW(Buffer.alloc(0))).toEqual([])
  })

  it('macOS NSFilenamesPboardType(plist) 의 여러 경로를 읽는다(XML 엔티티 복원)', () => {
    const plist = `<?xml version="1.0"?><plist><array>
      <string>/Users/dev/보고서 &amp; 정산.xlsx</string>
      <string>/Users/dev/deploy.sh</string>
    </array></plist>`
    expect(parseNSFilenames(plist)).toEqual(['/Users/dev/보고서 & 정산.xlsx', '/Users/dev/deploy.sh'])
  })

  it('실존 파일만 통과한다 — 없는 경로·디렉토리는 버린다(전송 큐에 쓰레기를 넣지 않는다)', () => {
    expect(keepUploadable([file, sub, join(dir, '없는파일.txt')])).toEqual([file])
  })

  it('클립보드에 파일 형식이 없으면 빈 배열 → 호출측이 텍스트 붙여넣기로 폴백한다', () => {
    const textOnly: ClipboardReader = {
      availableFormats: () => ['text/plain'],
      readBuffer: () => Buffer.alloc(0),
      read: () => ''
    }
    expect(clipboardFilePaths(textOnly, 'win32')).toEqual([])
    expect(clipboardFilePaths(textOnly, 'darwin')).toEqual([])
  })

  it('플랫폼별 형식을 골라 읽는다(win32=FileNameW / darwin=NSFilenames)', () => {
    const cb: ClipboardReader = {
      availableFormats: () => [WIN_FORMAT, MAC_FORMAT],
      readBuffer: (f) => (f === WIN_FORMAT ? Buffer.from(file + '\0', 'utf16le') : Buffer.alloc(0)),
      read: (f) => (f === MAC_FORMAT ? `<plist><array><string>${file}</string></array></plist>` : '')
    }
    expect(clipboardFilePaths(cb, 'win32')).toEqual([file])
    expect(clipboardFilePaths(cb, 'darwin')).toEqual([file])
  })

  it('클립보드 접근이 실패해도 예외를 던지지 않는다(붙여넣기가 죽으면 안 된다)', () => {
    const broken: ClipboardReader = {
      availableFormats: () => {
        throw new Error('clipboard busy')
      },
      readBuffer: () => Buffer.alloc(0),
      read: () => ''
    }
    expect(clipboardFilePaths(broken, 'win32')).toEqual([])
  })
})

describe('F14 로컬 세션 경로 붙여넣기(pastePaths)', () => {
  it('공백이 든 경로만 따옴표로 감싸고 공백으로 잇는다', () => {
    expect(pastePaths(['C:\\작업\\배포.zip'])).toBe('C:\\작업\\배포.zip')
    expect(pastePaths(['C:\\내 문서\\보고서.xlsx', '/srv/app.log'])).toBe('"C:\\내 문서\\보고서.xlsx" /srv/app.log')
  })

  it('줄바꿈을 붙이지 않는다 — 붙여넣기는 명령 실행이 아니다', () => {
    expect(pastePaths(['/srv/a.txt'])).not.toContain('\r')
    expect(pastePaths(['/srv/a.txt'])).not.toContain('\n')
  })
})

// ── F14: 터미널 → 전송 큐 인계 ──
describe('F14 업로드 인계(uploadBus)', () => {
  beforeEach(() => setUploader(null))

  it('등록된 세션이면 큐로 넘기고 [파일] 탭을 펼친다', () => {
    const got: string[][] = []
    let revealed = 0
    setUploader({ sessionId: 'ssh-1', upload: (p) => got.push(p), reveal: () => revealed++ })
    expect(uploadFiles('ssh-1', ['/tmp/a.txt'])).toBe(true)
    expect(got).toEqual([['/tmp/a.txt']])
    expect(revealed).toBe(1)
  })

  it('다른 세션이면 넘기지 않는다 — 엉뚱한 서버로 올리지 않는다', () => {
    let called = 0
    setUploader({ sessionId: 'ssh-1', upload: () => called++, reveal: () => {} })
    expect(uploadFiles('ssh-2', ['/tmp/a.txt'])).toBe(false)
    expect(called).toBe(0)
  })

  it('등록이 없거나 파일이 없으면 false — 호출측이 텍스트 붙여넣기로 폴백한다', () => {
    expect(uploadFiles('ssh-1', ['/tmp/a.txt'])).toBe(false)
    setUploader({ sessionId: 'ssh-1', upload: () => {}, reveal: () => {} })
    expect(uploadFiles('ssh-1', [])).toBe(false)
  })
})
