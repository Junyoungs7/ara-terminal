// W2 F12 세션 로그 검증 — 마스킹 4규칙 · ANSI 스트립(청크 경계 캐리) · 대체화면 제외 ·
// 20MB 상한 · 보존 스윕이 우리 파일만 지운다 · 기본 off 면 파일이 아예 생기지 않는다.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ALT_NOTICE,
  CAP_NOTICE,
  createSessionLog,
  LOG_NAME_RE,
  logFileName,
  MAX_BYTES,
  MAX_LINE,
  newStripState,
  normalizeCr,
  sanitizeKey,
  stripAnsi
} from '../src/main/log/SessionLog'
import { createMasker, maskSecrets, KEY_REDACTED, MASK } from '../src/shared/maskSecrets'
import { HistoryStore } from '../src/main/history/HistoryStore'
import type { Session } from '../src/shared/types'

const dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ev-w2-log-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const meta = (over: Partial<Session> = {}): Session => ({
  id: '11111111-2222-3333-4444-555555555555',
  type: 'ssh',
  title: '개발서버',
  serverKey: '개발서버',
  ...over
})

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))
const onlyLog = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : [])

// ── 1. 마스킹 ──

describe('maskSecrets — 규칙 1: 명령줄 인자', () => {
  it('-pSECRET(mysql 관례)를 가린다', () => {
    expect(maskSecrets('mysql -uroot -pS3cr3t! -h db')).toBe(`mysql -uroot -p${MASK} -h db`)
    expect(maskSecrets('mysql -uroot -pS3cr3t!')).not.toContain('S3cr3t')
  })

  it('--password / --token / --api-key / --secret 을 = 와 공백 모두에서 가린다', () => {
    expect(maskSecrets('curl --token=ghp_ABCDEF')).toBe(`curl --token=${MASK}`)
    expect(maskSecrets('cli --password hunter2')).toBe(`cli --password ${MASK}`)
    expect(maskSecrets('cli --api-key=AKIAX --secret=zz')).toBe(`cli --api-key=${MASK} --secret=${MASK}`)
    expect(maskSecrets('cli --apikey=AKIAX')).toBe(`cli --apikey=${MASK}`)
  })

  it('이미 마스킹된 값에 다시 걸려도 결과가 같다(멱등)', () => {
    const once = maskSecrets('mysql -pS3cr3t')
    expect(maskSecrets(once)).toBe(once)
  })

  // L1(W2 보안 리뷰): sshpass -p 는 현실에서 가장 흔한 평문 유출 경로다. `ssh -p 22`(포트 옵션)와
  // 겹치지 않아야 한다.
  it('sshpass -p 뒤의 비밀번호를 가린다(ssh -p 포트 옵션과는 겹치지 않는다)', () => {
    expect(maskSecrets('sshpass -p hunter2 ssh deploy@10.0.0.5')).toBe(`sshpass -p ${MASK} ssh deploy@10.0.0.5`)
    expect(maskSecrets('ssh -p 22 deploy@10.0.0.5')).toBe('ssh -p 22 deploy@10.0.0.5')
  })
})

describe('maskSecrets — 규칙 2: 환경변수·URL·헤더', () => {
  it('TOKEN= 류 대입을 가린다(접두사가 붙어도)', () => {
    expect(maskSecrets('export TOKEN=abc123')).toBe(`export TOKEN=${MASK}`)
    expect(maskSecrets('export MY_API_KEY=AKIA1234')).toBe(`export MY_API_KEY=${MASK}`)
    expect(maskSecrets('DB_PASSWORD=p@ss node app.js')).toBe(`DB_PASSWORD=${MASK} node app.js`)
    expect(maskSecrets('export TOKEN=abc123')).not.toContain('abc123')
  })

  it('URL 인증정보의 비밀번호만 가린다(사용자·호스트는 남긴다)', () => {
    expect(maskSecrets('git clone https://deploy:tok_9f@git.example.com/x.git')).toBe(
      `git clone https://deploy:${MASK}@git.example.com/x.git`
    )
  })

  it('Authorization 헤더 값을 가린다', () => {
    expect(maskSecrets('Authorization: Bearer eyJhbGciOi')).toBe(`Authorization: Bearer ${MASK}`)
  })

  it('비밀이 아닌 대입은 건드리지 않는다', () => {
    expect(maskSecrets('export PATH=/usr/bin:$PATH')).toBe('export PATH=/usr/bin:$PATH')
    expect(maskSecrets('echo 안녕하세요 배포 완료')).toBe('echo 안녕하세요 배포 완료')
  })
})

describe('maskSecrets — 신뢰 경계', () => {
  it('원격이 보낸 1MB 한 줄에서도 즉시 끝난다(백트래킹 폭발 회귀 방지)', () => {
    // 접두사 반복이 무제한이던 시절 이 입력에서 main 이 멈췄다. 상한은 넉넉히 2초.
    const line = 'x'.repeat(1024 * 1024)
    const t0 = Date.now()
    expect(maskSecrets(line)).toBe(line)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  // L3(W2 보안 리뷰): 'x' 반복은 규칙이 전혀 매칭을 시도하지 않는 입력이라 최악 케이스가 아니다.
  // 키워드가 조밀한(각 규칙이 매 위치에서 매칭을 시도하는) 1MB 입력으로 선형성을 고정한다
  // (실측: PROMPT_INLINE 이 이런 입력에서 0.49ms/KB — 1MB 면 ~500ms, 평범한 로그의 25배지만 폭발은 아니다).
  it('키워드가 조밀한 1MB 입력에서도 선형 시간에 끝난다(약한 ReDoS 케이스 보강)', () => {
    const line = ('password' + ' '.repeat(2000)).repeat(500) // ~1MB, 매 위치에서 PROMPT_INLINE 이 시도된다
    const t0 = Date.now()
    maskSecrets(line)
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

describe('maskSecrets — 규칙 3: 개인키 블록', () => {
  it('BEGIN~END 본문을 통째로 지운다', () => {
    const pem = [
      '$ cat id_ed25519',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU',
      'AAAAAAAAAAQAAAAtzc2gtZWQyNTUxOQ',
      '-----END OPENSSH PRIVATE KEY-----',
      '$ '
    ].join('\n')
    const out = maskSecrets(pem)
    expect(out).toContain(KEY_REDACTED)
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEA')
    expect(out).not.toContain('AAAAAAAAAAQ')
  })

  it('청크가 블록 중간에서 끊겨도 상태가 이어진다(스트리밍)', () => {
    const m = createMasker()
    const a = m.mask('-----BEGIN RSA PRIVATE KEY-----\nMIIEow비밀\n')
    const b = m.mask('MIIEow비밀2\n-----END RSA PRIVATE KEY-----\n끝\n')
    expect(a).toContain(KEY_REDACTED)
    expect(a + b).not.toContain('MIIEow비밀')
    expect(b).toContain('끝')
  })
})

describe('maskSecrets — 규칙 4: 프롬프트 인접', () => {
  it('프롬프트로 끝난 줄 다음의 비어 있지 않은 줄을 통째로 가린다', () => {
    expect(maskSecrets('Enter password:\nhunter2\nok')).toBe(`Enter password:\n${MASK}\nok`)
    expect(maskSecrets('비밀번호:\n내비밀\n다음')).toBe(`비밀번호:\n${MASK}\n다음`)
  })

  it('같은 줄에서 프롬프트 뒤에 이어진 값도 가린다(echo 가 켜진 read -p)', () => {
    expect(maskSecrets('Password: hunter2')).toBe(`Password: ${MASK}`)
    expect(maskSecrets('암호: 내비밀')).toBe(`암호: ${MASK}`)
  })

  it('프롬프트가 아닌 줄 다음은 그대로 둔다', () => {
    expect(maskSecrets('배포 완료\n정상 종료')).toBe('배포 완료\n정상 종료')
  })

  // SessionLog 는 항상 '\n' 로 끝나는 완성 줄만 넘긴다 → split 의 마지막 빈 요소가 플래그를 지워
  // "다음 줄" 규칙이 프로덕션에서 한 번도 발동하지 않았다. 한 청크로 주는 테스트는 이걸 못 잡는다.
  it('프롬프트와 값이 다른 청크로 나뉘어도 가린다(SessionLog 가 타는 스트리밍 경로)', () => {
    const m = createMasker()
    expect(m.mask('Password:\n')).toBe('Password:\n')
    expect(m.mask('hunter2SECRET\n')).toBe(`${MASK}\n`)
  })

  it('프롬프트와 값 사이에 빈 줄이 끼어도 가린다', () => {
    const m = createMasker()
    m.mask('비밀번호:\n')
    expect(m.mask('\n')).toBe('\n')
    expect(m.mask('내비밀\n')).toBe(`${MASK}\n`)
  })
})

// ── 2. ANSI 스트립 · 대체화면 ──

describe('ANSI 스트립', () => {
  it('SGR·CSI·OSC 를 지우고 본문만 남긴다(한글 보존)', () => {
    const st = newStripState()
    const out = stripAnsi('\x1b[32m✔ 배포 완료\x1b[0m\x1b]0;제목\x07\n', st)
    expect(out).toBe('✔ 배포 완료\n')
  })

  it('시퀀스가 청크 경계에서 잘려도 이어 붙인다', () => {
    const st = newStripState()
    const a = stripAnsi('앞\x1b[3', st)
    const b = stripAnsi('2m뒤', st)
    expect(a).toBe('앞')
    expect(b).toBe('뒤')
  })

  // 2026-08-22 준영님 제보 10번 — 기록에 같은 명령이 이어붙어 남았다:
  //   `jun@kvt:…$ jun@kvt:…$ cp -r ./src ./backup     cp -r ./src ./backup      su`
  // readline 이 히스토리를 부르거나 붙여넣을 때 줄을 지우고 다시 그리는데, 그 시퀀스를 버리고
  // 글자만 이어 붙이면 지워졌어야 할 옛 글자가 남는다.
  it('줄 전체 지우기(CSI 2K)는 그 줄에 쌓인 것을 버린다', () => {
    const st = newStripState()
    expect(stripAnsi('$ cp -r ./src ./backup\x1b[2K$ su\n', st)).toBe('$ su\n')
  })

  it('줄 지우기는 그 줄만 지운다 — 앞 줄은 남는다', () => {
    const st = newStripState()
    expect(stripAnsi('첫 줄\n둘째 옛것\x1b[2K둘째 새것\n', st)).toBe('첫 줄\n둘째 새것\n')
  })

  it('CSI 0K(커서~끝)는 순차 출력에서 지울 것이 없다', () => {
    expect(stripAnsi('진행 중\x1b[K\n', newStripState())).toBe('진행 중\n')
    expect(stripAnsi('진행 중\x1b[0K\n', newStripState())).toBe('진행 중\n')
  })

  it('줄 첫 칸으로 이동(CSI G)은 CR 로 남겨 normalizeCr 이 덮어쓰기로 정리한다', () => {
    const out = stripAnsi('옛 명령\x1b[1G새 명령\n', newStripState())
    expect(out).toBe('옛 명령\r새 명령\n')
    expect(normalizeCr(out)).toBe('새 명령\n')
  })

  // 2026-08-22 준영님 재제보(12·13번) — 실제로 남은 기록:
  //   `jun@kvt:~/data$ cl lsll`  ← `cl` 을 지우고 `ls`, 다시 고쳐 `ll` 을 친 흔적이 전부 남았다
  it('백스페이스는 앞 글자를 지운다 — 셸이 지운 것은 기록에도 없어야 한다', () => {
    expect(stripAnsi('cl\b\bls\n', newStripState())).toBe('ls\n')
    // readline 이 실제로 보내는 형태: 뒤로·공백·뒤로
    expect(stripAnsi('cl\b \b\b \bls\n', newStripState())).toBe('ls\n')
  })

  it('백스페이스가 줄 시작을 넘어 프롬프트를 갉아먹지 않는다', () => {
    expect(stripAnsi('$ \b\b\b\b\bls\n', newStripState())).toBe('ls\n')
    // 앞 줄은 안전하다 — 지우기는 지금 줄 안에서만 일어난다.
    expect(stripAnsi('첫 줄\nab\b\b\bcd\n', newStripState())).toBe('첫 줄\ncd\n')
  })

  it('CR 뒤의 백스페이스는 그 뒤에 쓴 것만 지운다', () => {
    // CR 로 커서가 줄 앞에 갔고, 거기서 다시 쓰다 한 글자를 지웠다.
    expect(stripAnsi('옛것\rabc\b\n', newStripState())).toBe('옛것\rab\n')
    expect(normalizeCr(stripAnsi('옛것\rabc\b\n', newStripState()))).toBe('ab\n')
  })

  it('대체화면 안에서는 줄 지우기도 기록에 영향을 주지 않는다', () => {
    const st = newStripState()
    expect(stripAnsi('전\x1b[?1049h재그리기\x1b[2K또 재그리기\x1b[?1049l후\n', st)).toBe('전후\n')
  })

  it('대체화면(1049h~l) 구간은 기록하지 않는다', () => {
    const st = newStripState()
    const out = stripAnsi('전\x1b[?1049hhtop 화면 재그리기\x1b[?1049l후\n', st)
    expect(out).toBe('전후\n')
  })

  it('대체화면이 청크를 넘어가도 상태가 유지된다', () => {
    const st = newStripState()
    expect(stripAnsi('\x1b[?1049hvim 안', st)).toBe('')
    expect(stripAnsi('여전히 vim', st)).toBe('')
    expect(stripAnsi('\x1b[?1049l복귀', st)).toBe('복귀')
  })

  it('진행률 덮어쓰기(\\r)는 마지막 상태만 남긴다', () => {
    expect(normalizeCr('10%\r50%\r100%\r\n완료\r\n')).toBe('100%\n완료\n')
  })
})

// ── 3. 파일명·경로 안전 ──

describe('파일명', () => {
  it('경로 구분자·상위 참조·드라이브 문자를 제거한다', () => {
    expect(sanitizeKey('../../etc/passwd')).not.toMatch(/[/\\]/)
    expect(sanitizeKey('C:\\Windows')).not.toMatch(/[:\\]/)
    expect(sanitizeKey('a/b\\c:d*e?f')).toBe('a_b_c_d_e_f')
  })

  it('한글 서버명은 그대로 남긴다(로그를 찾을 수 있어야 한다)', () => {
    expect(sanitizeKey('개발서버')).toBe('개발서버')
  })

  it('이름순 = 시간순이고 보존 스윕 패턴에 맞는다', () => {
    const name = logFileName(meta(), new Date(2026, 7, 4, 9, 5, 3))
    expect(name).toBe('20260804-090503_개발서버_11111111.log')
    expect(LOG_NAME_RE.test(name)).toBe(true)
  })
})

// ── 4. 기록 동작 ──

describe('세션 로그 기록', () => {
  it('기본 off 면 파일이 생기지 않는다', () => {
    const dir = tmpDir()
    const log = createSessionLog(dir, false, 30)
    log.write(meta(), bytes('무언가 출력\n'))
    log.closeAll()
    expect(onlyLog(dir)).toHaveLength(0)
  })

  it('켜면 파일이 생기고 한글이 그대로 남는다', () => {
    const dir = tmpDir()
    const log = createSessionLog(dir, true, 30)
    log.write(meta(), bytes('\x1b[32m✔ 데이터베이스 백업이 완료되었습니다\x1b[0m\n'))
    log.closeAll()
    const files = onlyLog(dir)
    expect(files).toHaveLength(1)
    expect(readFileSync(join(dir, files[0]), 'utf8')).toBe('✔ 데이터베이스 백업이 완료되었습니다\n')
  })

  it('비밀은 기록 전에 가려진다 — 파일에 원문이 없다', () => {
    const dir = tmpDir()
    const log = createSessionLog(dir, true, 30)
    log.write(meta(), bytes('$ export TOKEN=abc123\n'))
    log.write(meta(), bytes('$ mysql -pS3cr3t\n'))
    log.closeAll()
    const body = readFileSync(join(dir, onlyLog(dir)[0]), 'utf8')
    expect(body).not.toContain('abc123')
    expect(body).not.toContain('S3cr3t')
    expect(body).toContain(MASK)
  })

  it('대체화면 프로그램(htop)의 재그리기는 파일에 남지 않는다', () => {
    const dir = tmpDir()
    const log = createSessionLog(dir, true, 30)
    log.write(meta(), bytes('$ htop\n\x1b[?1049h'))
    for (let i = 0; i < 50; i++) log.write(meta(), bytes(`CPU 사용률 ${i}%\x1b[H`))
    log.write(meta(), bytes('\x1b[?1049l$ \n'))
    log.closeAll()
    const body = readFileSync(join(dir, onlyLog(dir)[0]), 'utf8')
    expect(body).toContain('$ htop')
    expect(body).not.toContain('CPU 사용률')
  })

  it('세션이 끝날 때 줄이 안 끝난 꼬리도 기록한다', () => {
    const dir = tmpDir()
    const log = createSessionLog(dir, true, 30)
    log.write(meta(), bytes('deploy@web-01:~$ '))
    log.close(meta().id)
    expect(readFileSync(join(dir, onlyLog(dir)[0]), 'utf8')).toContain('deploy@web-01:~$')
  })

  it('크기 상한에 닿으면 안내를 남기고 그 세션 기록을 멈춘다', () => {
    const dir = tmpDir()
    const log = createSessionLog(dir, true, 30)
    const chunk = 'x'.repeat(1024 * 1024) + '\n'
    for (let i = 0; i < 25; i++) log.write(meta(), bytes(chunk))
    log.closeAll()
    const body = readFileSync(join(dir, onlyLog(dir)[0]), 'utf8')
    expect(body).toContain(CAP_NOTICE.trim())
    expect(body.length).toBeLessThan(MAX_BYTES + CAP_NOTICE.length + 1024)
  })

  // 상한 검사가 put() 안에만 있었다 — put() 은 '\n' 이 있을 때만 불린다. 개행 없는 출력(미니파이 JS·
  // base64 블롭)은 상한 없는 e.buf 에 그대로 쌓여 main 힙을 먹고 파일은 0 바이트로 남았다.
  //
  // M-8 은 **힙 사용량**으로 쟀다. 그게 두 번 흔들렸다(64MB → 실측 93.5MB, 200MB → 실측 210MB —
  // 둘 다 부하 걸린 머신, 단독 실행에서는 늘 통과). 숫자를 또 올리면 결함 시점 실측(+317MB)과의
  // 간격만 좁아진다. 2026-08-23: **재는 대상을 바꿨다** — 문제였던 것은 힙이 아니라 파일로 못
  // 나간 꼬리(e.buf)가 상한 없이 쌓이는 것이었다. 그 값을 직접 본다. GC 타이밍과 무관하다.
  it('개행이 없는 대용량 출력도 상한에 걸린다 — 꼬리 버퍼가 무제한으로 늘지 않는다', () => {
    const dir = tmpDir()
    const log = createSessionLog(dir, true, 30)
    const chunk = bytes('x'.repeat(1024 * 1024)) // 개행 없음
    for (let i = 0; i < 60; i++) log.write(meta(), chunk)
    // 60MB 를 개행 없이 넣었다. 결함 시점에는 이 값이 그대로 60MB 였다(상한이 put() 안에만 있었다).
    expect(log.bufferedBytes()).toBeLessThan(2 * MAX_LINE)
    log.closeAll()
    const body = readFileSync(join(dir, onlyLog(dir)[0]), 'utf8')
    expect(body.length).toBeGreaterThan(0) // 결함 시점: 0 바이트
    expect(body).toContain(CAP_NOTICE.trim()) // 60MB 투입 → 20MB 상한 도달
  })

  it('원격이 대체화면을 닫지 않아도 누락 사실이 파일에 남는다', () => {
    const dir = tmpDir()
    const log = createSessionLog(dir, true, 30)
    log.write(meta(), bytes('$ 정상 출력\n\x1b[?1049h')) // 종료 시퀀스(…l)를 보내지 않는다
    log.write(meta(), bytes('민감한 배포 로그\n'))
    log.closeAll()
    const body = readFileSync(join(dir, onlyLog(dir)[0]), 'utf8')
    expect(body).toContain('$ 정상 출력')
    expect(body).not.toContain('민감한 배포 로그')
    expect(body).toContain(ALT_NOTICE.trim())
  })

  it('진입·종료를 한 청크에 몰아 써도 표식을 피할 수 없다', () => {
    const dir = tmpDir()
    const log = createSessionLog(dir, true, 30)
    log.write(meta(), bytes('\x1b[?1049h숨긴 활동\x1b[?1049l$ \n'))
    log.closeAll()
    const body = readFileSync(join(dir, onlyLog(dir)[0]), 'utf8')
    expect(body).not.toContain('숨긴 활동')
    expect(body).toContain(ALT_NOTICE.trim())
  })

  it('프롬프트 다음 줄에 에코된 비밀번호가 평문으로 남지 않는다(PTY 는 한 글자씩 흘린다)', () => {
    const dir = tmpDir()
    const log = createSessionLog(dir, true, 30)
    log.write(meta(), bytes('Password:\n'))
    for (const ch of 'hunter2SECRET') log.write(meta(), bytes(ch))
    log.write(meta(), bytes('\r\n'))
    log.closeAll()
    const body = readFileSync(join(dir, onlyLog(dir)[0]), 'utf8')
    expect(body).not.toContain('hunter2SECRET')
    expect(body).toContain(MASK)
  })

  it('설정을 끄면 열려 있던 파일을 닫고 더 쓰지 않는다', () => {
    const dir = tmpDir()
    const log = createSessionLog(dir, true, 30)
    log.write(meta(), bytes('첫 줄\n'))
    log.setPrefs(false, 30)
    log.write(meta(), bytes('꺼진 뒤 줄\n'))
    log.closeAll()
    const body = readFileSync(join(dir, onlyLog(dir)[0]), 'utf8')
    expect(body).toContain('첫 줄')
    expect(body).not.toContain('꺼진 뒤 줄')
  })
})

// ── 5. 보존 스윕 ──

describe('보존 스윕', () => {
  function aged(dir: string, name: string, days: number): string {
    const p = join(dir, name)
    writeFileSync(p, 'x')
    const t = (Date.now() - days * 86400_000) / 1000
    utimesSync(p, t, t)
    return p
  }

  it('기간이 지난 우리 로그만 지운다', () => {
    const dir = tmpDir()
    aged(dir, '20260601-101010_개발서버_aaaaaaaa.log', 60)
    aged(dir, '20260803-101010_개발서버_bbbbbbbb.log', 1)
    const removed = createSessionLog(dir, true, 30).sweep()
    expect(removed).toBe(1)
    expect(onlyLog(dir)).toEqual(['20260803-101010_개발서버_bbbbbbbb.log'])
  })

  it('패턴 밖 파일·디렉토리는 건드리지 않는다', () => {
    const dir = tmpDir()
    aged(dir, '20260601-101010_개발서버_aaaaaaaa.log', 60)
    aged(dir, '내가둔메모.log', 60)
    aged(dir, 'notes.txt', 60)
    mkdirSync(join(dir, '20260601-101010_x_ffffffff.log.d'))
    createSessionLog(dir, true, 30).sweep()
    expect(new Set(onlyLog(dir))).toEqual(
      new Set(['20260601-101010_x_ffffffff.log.d', '내가둔메모.log', 'notes.txt'])
    )
  })

  it('보존 기간 0(무제한)이면 아무것도 지우지 않는다', () => {
    const dir = tmpDir()
    aged(dir, '20200101-101010_옛날_aaaaaaaa.log', 3000)
    expect(createSessionLog(dir, true, 0).sweep()).toBe(0)
    expect(onlyLog(dir)).toHaveLength(1)
  })

  // L2(W2 보안 리뷰): renderer 가 보내는 retentionDays 는 신뢰 경계 밖이다 — 작은 양수(예: 1e-9)로
  // "거의 전부 삭제"를 유도할 수 있었다. NaN·음수·아주 작은 양수는 전부 "무제한(삭제 안 함)"으로
  // 떨어지는 게 삭제보다 안전하다.
  it('retentionDays 이상값(NaN·음수·아주 작은 양수)은 무제한으로 클램프된다', () => {
    const dir = tmpDir()
    aged(dir, '20200101-101010_옛날_aaaaaaaa.log', 3000)
    expect(createSessionLog(dir, true, Number.NaN).sweep()).toBe(0)
    expect(createSessionLog(dir, true, -1e15).sweep()).toBe(0)
    expect(createSessionLog(dir, true, 1e-9).sweep()).toBe(0) // 클램프 전엔 이 값이 거의 전부를 지웠다
    expect(onlyLog(dir)).toHaveLength(1)
  })

  it('retentionDays 거대값은 상한(3650일)으로 클램프된다(무제한이 되지는 않는다)', () => {
    const dir = tmpDir()
    aged(dir, '20000101-101010_옛날_aaaaaaaa.log', 10000) // 3650일 상한보다 오래됐다 — 클램프된 상한으로도 삭제 대상.
    expect(createSessionLog(dir, true, 1e15).sweep()).toBe(1)
  })
})

// ── 6. F11 히스토리 평문 결함(같은 마스커) ──

describe('history.json 평문 비밀 차단', () => {
  it('명령줄에 박힌 비밀이 디스크에 평문으로 남지 않는다', () => {
    const dir = tmpDir()
    const path = join(dir, 'history.json')
    const h = new HistoryStore(path)
    h.append('개발서버', 'mysql -uroot -pS3cr3t! app_db')
    h.append('개발서버', 'export GITHUB_TOKEN=ghp_ABCDEF')
    h.append('개발서버', 'ls -al')
    h.flush()
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('S3cr3t')
    expect(raw).not.toContain('ghp_ABCDEF')
    expect(raw).toContain(MASK)
    // 평범한 명령은 그대로 남아야 고스트 자동완성이 계속 쓸모 있다.
    expect(h.load('개발서버')).toContain('ls -al')
  })
})
