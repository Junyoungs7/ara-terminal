// 정리 1: 아라가 띄우는 PTY 의 PATH 맨 앞에 ara 폴더(src/main/cli/childPath.ts — Orca orca-cli-child-path.ts 의 Windows 몫).
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devLauncherText, prependAraCliPath, setupAraCliChildPath, withAraCliPath } from '../src/main/cli/childPath'

const tmp: string[] = []
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ara-childpath-'))
  tmp.push(d)
  return d
}
afterEach(() => {
  setupAraCliChildPath({ platform: 'linux', isPackaged: false, resourcesPath: '', userData: '', execPath: '', cliEntryCandidates: [], log: () => {} })
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('prependAraCliPath', () => {
  it('Path 맨 앞에 넣고 같은 줄(대소문자·끝 \\)은 지우며 빈 칸을 만들지 않는다', () => {
    const env = { Path: 'C:\\a;;c:\\ARA\\bin\\;C:\\b', X: '1' }
    const out = prependAraCliPath(env, 'C:\\ara\\bin', 'C:\\ud')
    expect(out).toEqual({ Path: 'C:\\ara\\bin;C:\\a;C:\\b', X: '1', ARA_USER_DATA_PATH: 'C:\\ud' })
    expect(env.Path).toBe('C:\\a;;c:\\ARA\\bin\\;C:\\b') // 원본 그대로
  })
  it('PATH 키가 둘이면 뒤에 펼친 값으로 하나로 모은다', () => {
    const out = prependAraCliPath({ Path: 'C:\\old', PATH: 'C:\\new' }, 'C:\\bin', 'u')
    expect(Object.keys(out).filter((k) => /^path$/i.test(k))).toEqual(['Path'])
    expect(out['Path']).toBe('C:\\bin;C:\\new')
  })
  it('PATH 가 없으면 폴더 하나', () => {
    expect(prependAraCliPath({}, 'C:\\bin', 'u')['Path']).toBe('C:\\bin')
  })
})

describe('devLauncherText', () => {
  it('ELECTRON_RUN_AS_NODE + 실행 파일 + araCli.js, CRLF, % 는 %% ', () => {
    const t = devLauncherText('C:\\e\\electron.exe', 'D:\\100%\\out\\main\\araCli.js')!
    expect(t).toContain('set "ELECTRON_RUN_AS_NODE=1"\r\n"C:\\e\\electron.exe" "D:\\100%%\\out\\main\\araCli.js" %*\r\n')
  })
  it('ASCII 가 아닌 경로면 쓰지 않는다(cmd 는 콘솔 코드 페이지로 읽는다)', () => {
    expect(devLauncherText('C:\\Users\\준영\\electron.exe', 'D:\\x.js')).toBeNull()
  })
})

describe('setupAraCliChildPath', () => {
  const base = { platform: 'win32' as const, execPath: 'C:\\e\\electron.exe', log: () => {} }
  it('설치본: resources\\bin\\ara.cmd 가 있으면 그 폴더 — withAraCliPath 가 얹는다', () => {
    const res = mk()
    mkdirSync(join(res, 'bin'))
    writeFileSync(join(res, 'bin', 'ara.cmd'), '@echo off')
    const ud = mk()
    expect(setupAraCliChildPath({ ...base, isPackaged: true, resourcesPath: res, userData: ud, cliEntryCandidates: [] })).toBe(join(res, 'bin'))
    expect(withAraCliPath({ Path: 'C:\\w' })).toEqual({ Path: `${join(res, 'bin')};C:\\w`, ARA_USER_DATA_PATH: ud })
  })
  it('설치본에 ara.cmd 가 없으면 아무것도 안 얹는다(양성 대조의 반대편)', () => {
    expect(setupAraCliChildPath({ ...base, isPackaged: true, resourcesPath: mk(), userData: mk(), cliEntryCandidates: [] })).toBeNull()
    expect(withAraCliPath({ Path: 'C:\\w' })).toEqual({ Path: 'C:\\w' })
  })
  it('개발판: 있는 araCli.js 후보로 userData\\cli\\bin\\ara.cmd 를 쓰고 그 폴더', () => {
    const out = mk()
    writeFileSync(join(out, 'araCli.js'), '')
    const ud = mk()
    const dir = setupAraCliChildPath({ ...base, isPackaged: false, resourcesPath: '', userData: ud, cliEntryCandidates: [join(out, 'nope.js'), join(out, 'araCli.js')] })
    expect(dir).toBe(join(ud, 'cli', 'bin'))
    expect(readFileSync(join(dir!, 'ara.cmd'), 'ascii')).toBe(devLauncherText(base.execPath, join(out, 'araCli.js')))
  })
  it('개발판에 araCli.js 가 없으면(빌드 전) 없음', () => {
    expect(setupAraCliChildPath({ ...base, isPackaged: false, resourcesPath: '', userData: mk(), cliEntryCandidates: [join(mk(), 'araCli.js')] })).toBeNull()
  })
  it('Windows 가 아니면 없음(ara 실행 파일은 ara.cmd 뿐)', () => {
    expect(setupAraCliChildPath({ ...base, platform: 'darwin', isPackaged: true, resourcesPath: mk(), userData: mk(), cliEntryCandidates: [] })).toBeNull()
  })
})

describe('배선 — 로컬 PTY·데몬 에이전트·데몬 터미널 셋 다 지난다', () => {
  const src = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')
  it.each([
    ['src/main/sessions/PtyBackend.ts', 'const base = withAraCliPath('],
    ['src/main/agents/feature.ts', 'env: withAraCliPath({ ...appEnv, ...env })'],
    ['src/main/daemon/terminalShells.ts', 'withAraCliPath(Object.fromEntries(Object.entries(process.env)'],
    ['src/main/cli/feature.ts', 'setupAraCliChildPath({']
  ])('%s', (file, needle) => {
    expect(src(file)).toContain(needle)
  })
})
