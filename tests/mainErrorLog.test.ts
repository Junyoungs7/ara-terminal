import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// app.getPath('userData') 만 쓴다 — 실제 Electron 없이 임시 디렉토리로 대체한다.
let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const { logMainError, formatMainError, mainErrorLogPath, MAIN_ERROR_LOG_MAX_BYTES, TRUNCATED_NOTICE } =
  await import('../src/main/log/MainErrorLog')

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'ara-mainerr-'))
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(userData, { recursive: true, force: true })
})

describe('MainErrorLog', () => {
  it('타임스탬프 + 발생 지점 + 스택을 남긴다', () => {
    logMainError('ipc sftp:list', new Error('boom'))
    const text = readFileSync(mainErrorLogPath(), 'utf8')
    expect(text).toContain('ipc sftp:list')
    expect(text).toContain('Error: boom')
    expect(text).toMatch(/^\[\d{4}-\d{2}-\d{2}T/)
  })

  it('여러 번 부르면 append 한다(덮어쓰지 않는다)', () => {
    logMainError('first', new Error('one'))
    logMainError('second', new Error('two'))
    const text = readFileSync(mainErrorLogPath(), 'utf8')
    expect(text).toContain('one')
    expect(text).toContain('two')
  })

  it('비밀은 마스킹해서 쓴다 — 원문이 파일에 닿지 않는다', () => {
    const secret = 'hunter2SuperSecret'
    logMainError('ipc ssh:connect', new Error(`connect ssh://ops:${secret}@10.0.0.9 실패`))
    const text = readFileSync(mainErrorLogPath(), 'utf8')
    expect(text).not.toContain(secret)
    expect(text).toContain('****')
    // 포맷 단계에서 이미 마스킹된다 — 원문이 파일 쓰기 경로에 닿지 않는다.
    expect(formatMainError('x', new Error(`ssh://ops:${secret}@h`))).not.toContain(secret)
  })

  it('상한을 넘으면 잘라 내고 최신 항목만 남긴다', () => {
    const big = 'x'.repeat(200 * 1024)
    for (let i = 0; i < 6; i++) logMainError(`fill-${i}`, new Error(big))
    logMainError('after-cap', new Error('최신'))
    const path = mainErrorLogPath()
    expect(statSync(path).size).toBeLessThanOrEqual(MAIN_ERROR_LOG_MAX_BYTES)
    const text = readFileSync(path, 'utf8')
    expect(text).toContain(TRUNCATED_NOTICE)
    expect(text).toContain('after-cap')
  })

  it('기록에 실패해도 던지지 않는다', () => {
    // logs 자리에 파일이 있으면 mkdir 도 append 도 실패한다 — 그래도 던지면 안 된다.
    writeFileSync(join(userData, 'logs'), 'not a directory')
    expect(() => logMainError('broken', new Error('x'))).not.toThrow()
  })
})
