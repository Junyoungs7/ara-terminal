// M3 AI-01 설치 감지 — run 을 바꿔 끼운다. 진짜 claude/codex/gemini 를 띄우지 않는다(사용량·사내 정책).
import { describe, expect, it } from 'vitest'
import { createAgentDetector } from '../src/main/agents/detect'
import { SHELL_PATH_MARK } from '../src/shared/agents'
import type { RunResult } from '../src/main/util/runProcess'

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', error: null })
const fail = (): RunResult => ({ code: 1, stdout: '', stderr: '', error: new Error('not found') })

describe('createAgentDetector', () => {
  it('Windows — 셸 PATH 합치기 → where → cmd 로 --version, 없는 것은 판을 묻지 않는다', async () => {
    const calls: string[][] = []
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows', ComSpec: 'C:\\Windows\\cmd.exe' }
    const run = async (file: string, args: readonly string[]): Promise<RunResult> => {
      calls.push([file, ...args])
      if (file === 'powershell.exe') return ok(`${SHELL_PATH_MARK}C:\\Windows;C:\\npm;%X%\\bin${SHELL_PATH_MARK}`)
      if (file === 'where') {
        if (args[0] === 'claude') return ok('C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n')
        if (args[0] === 'codex') return ok('C:\\npm\\codex.cmd\r\n')
        return fail()
      }
      if (args.includes('claude')) return ok('2.1.300 (Claude Code)\n')
      if (args.includes('codex')) return { code: 1, stdout: '', stderr: 'boom', error: new Error('x') }
      throw new Error('예상 못 한 실행: ' + [file, ...args].join(' '))
    }
    const d = createAgentDetector({ run, platform: 'win32', env })
    expect(await d.detect()).toEqual([
      { id: 'claude', installed: true, path: 'C:\\npm\\claude.cmd', version: '2.1.300' },
      { id: 'codex', installed: true, path: 'C:\\npm\\codex.cmd', version: null }, // 판 못 읽어도 설치됨
      { id: 'gemini', installed: false, path: null, version: null }
    ])
    expect(env.PATH).toBe('C:\\Windows;C:\\npm') // %X% 조각은 버림
    expect(calls).toContainEqual(['C:\\Windows\\cmd.exe', '/d', '/c', 'claude', '--version'])
    expect(calls.some((c) => c.includes('gemini') && c.includes('--version'))).toBe(false)
    // 두 번째 감지는 셸 PATH 를 다시 안 읽는다. force 면 읽는다.
    await d.detect()
    expect(calls.filter((c) => c[0] === 'powershell.exe')).toHaveLength(1)
    await d.detect(true)
    expect(calls.filter((c) => c[0] === 'powershell.exe')).toHaveLength(2)
  })

  it('POSIX — 로그인 셸(-ilc) PATH, which 경로로 직접 --version', async () => {
    const calls: string[][] = []
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', SHELL: '/bin/zsh' }
    const run = async (file: string, args: readonly string[]): Promise<RunResult> => {
      calls.push([file, ...args])
      if (file === '/bin/zsh') return ok(`banner\n${SHELL_PATH_MARK}/usr/bin:/home/u/.local/bin${SHELL_PATH_MARK}`)
      if (file === 'which') return args[0] === 'gemini' ? ok('/home/u/.local/bin/gemini\n') : fail()
      if (file === '/home/u/.local/bin/gemini') return ok('0.9.0\n')
      throw new Error('예상 못 한 실행: ' + file)
    }
    const r = await createAgentDetector({ run, platform: 'linux', env }).detect()
    expect(r.find((x) => x.id === 'gemini')).toEqual({ id: 'gemini', installed: true, path: '/home/u/.local/bin/gemini', version: '0.9.0' })
    expect(env.PATH).toBe('/usr/bin:/home/u/.local/bin')
    expect(calls[0][1]).toBe('-ilc')
  })

  it('셸 PATH 읽기가 실패해도 감지는 한다', async () => {
    const run = async (file: string): Promise<RunResult> => (file === 'which' ? fail() : fail())
    const r = await createAgentDetector({ run, platform: 'linux', env: { PATH: '/x' } }).detect()
    expect(r.every((x) => !x.installed)).toBe(true)
  })
})
