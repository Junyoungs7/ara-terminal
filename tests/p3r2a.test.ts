// P3 R2-A 터미널 3차 — 셸 선택·인자(TM-09), 테마·대비(TM-10), Ghostty/Warp 가져오기(TM-11), OSC 52 기본 꺼짐(TM-14), 릴리스 채널(TM-15).
import { describe, expect, it } from 'vitest'
import { DARK_BG_MIN_CONTRAST, LIGHT_BG_MIN_CONTRAST, formatShellArgs, parseShellArgs, resolveMinimumContrast, termExtraOf } from '../src/shared/termExtra'
import { builtinShellPath, detectShells, resolveShellProfile } from '../src/main/sessions/shellProfiles'
import { mapGhostty, parseGhosttyConfig, parseWarpTheme } from '../src/main/termImport'
import { TERMINAL_THEME_CATALOG } from '../src/shared/terminalThemes/index'
import { createAutoUpdate, type UpdaterLike } from '../src/main/update/AutoUpdate'

describe('termExtraOf', () => {
  it('기본: OSC 52 꺼짐, 인라인 이미지 켬, 대비 자동, 셸 자동', () => {
    expect(termExtraOf(undefined)).toMatchObject({ osc52: false, inlineImages: true, minimumContrastRatio: null, shell: '', theme: '' })
  })
  it('손상 값을 거른다 — 상대 경로 셸·범위 밖 대비·HEX 아닌 색', () => {
    const x = termExtraOf({ shell: 'evil.exe', minimumContrastRatio: 99, osc52: 'yes', customThemes: { a: { background: 'red', foreground: '#ffffff' }, b: { background: '#000000', foreground: '#ffffff', red: 'x' } } })
    expect(x.shell).toBe('')
    expect(x.minimumContrastRatio).toBe(21)
    expect(x.osc52).toBe(false)
    expect(Object.keys(x.customThemes)).toEqual(['b'])
    expect(x.customThemes['b']).toEqual({ background: '#000000', foreground: '#ffffff' })
    expect(termExtraOf({ shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }).shell).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(termExtraOf({ shell: 'git-bash' }).shell).toBe('git-bash')
  })
})

describe('셸 인자', () => {
  it('따옴표 덩어리·빈 인자 왕복', () => {
    const args = parseShellArgs(`-NoProfile -Command "Write-Host 'a b'" ''`)
    expect(args).toEqual(['-NoProfile', '-Command', "Write-Host 'a b'", ''])
    expect(parseShellArgs(formatShellArgs(args))).toEqual(args)
  })
  it('프로필 → 실행 파일·인자(주면 기본 인자를 바꾼다)', () => {
    const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', PATH: '' }
    const has = new Set(['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\wsl.exe'])
    const exists = (p: string) => has.has(p)
    expect(resolveShellProfile('', undefined, env, exists)).toBeNull()
    expect(resolveShellProfile('git-bash', undefined, env, exists)).toEqual({ file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] })
    expect(resolveShellProfile('powershell.exe', ['-NoProfile'], env, exists)).toEqual({ file: 'powershell.exe', args: ['-NoProfile'] })
    expect(builtinShellPath('pwsh.exe', env, exists)).toBeNull()
    const list = detectShells('win32', env, exists)
    expect(list.map((s) => [s.id, s.path !== null])).toEqual([
      ['powershell.exe', true],
      ['pwsh.exe', false],
      ['cmd.exe', true],
      ['git-bash', true],
      ['wsl.exe', true]
    ])
    expect(detectShells('linux', {}, () => true, () => '# x\n/bin/bash\n/usr/bin/zsh\n/bin/bash\n').map((s) => s.id)).toEqual(['/bin/bash', '/usr/bin/zsh'])
  })
})

describe('테마·대비', () => {
  it('Orca 카탈로그가 실린다(이름 겹침 없음 — merge 가 던진다)', () => {
    expect(Object.keys(TERMINAL_THEME_CATALOG).length).toBeGreaterThan(25)
    expect(TERMINAL_THEME_CATALOG['Ghostty Default Style Dark']?.background).toBe('#282c34')
  })
  it('자동 대비: 밝은 배경 4.5, 어두운 3, 설정값 우선', () => {
    expect(resolveMinimumContrast('#ffffff', null)).toBe(LIGHT_BG_MIN_CONTRAST)
    expect(resolveMinimumContrast('#15171a', null)).toBe(DARK_BG_MIN_CONTRAST)
    expect(resolveMinimumContrast('#ffffff', 1)).toBe(1)
  })
})

describe('가져오기', () => {
  it('Ghostty — 색·palette·글꼴·커서, 모르는 키는 안 옮김', () => {
    const p = parseGhosttyConfig('background = 1e1e2e\nforeground=#cdd6f4 # 주석\npalette = 1=#f38ba8\npalette = 9=#ff0000\nfont-family = "JetBrains Mono"\nfont-size = 13\ncursor-style = bar\nwindow-padding-x = 4\n')
    const m = mapGhostty(p, 'Ghostty')
    expect(m.colors).toMatchObject({ background: '#1e1e2e', foreground: '#cdd6f4', red: '#f38ba8', brightRed: '#ff0000' })
    expect(m.font).toEqual({ family: 'JetBrains Mono', sizePx: 13 })
    expect(m.cursor).toEqual({ style: 'bar' })
    expect(m.unsupported).toEqual(['window-padding-x'])
  })
  it('Warp — YAML 테마, 그라디언트는 한 색 + 안 옮김 표시, 모자라면 거절', () => {
    const ok = parseWarpTheme('name: Night\nbackground: "#101010"\nforeground: "#eeeeee"\naccent: { top: "#ff8800", bottom: "#000000" }\nterminal_colors:\n  normal: { red: "#aa0000" }\n  bright: { blue: "#0000ff" }\n', 'night.yaml')
    expect(ok).toMatchObject({ name: 'Night', colors: { background: '#101010', foreground: '#eeeeee', cursor: '#ff8800', red: '#aa0000', brightBlue: '#0000ff' }, unsupported: ['gradient'] })
    expect(parseWarpTheme('background: "#000000"\n', 'x.yaml')).toHaveProperty('error')
    expect(parseWarpTheme('a: [', 'bad.yaml')).toHaveProperty('error')
  })
})

describe('릴리스 채널', () => {
  it('beta 를 고르면 확인 전에 channel=beta·allowDowngrade 끔', async () => {
    const u: UpdaterLike = {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      channel: null,
      allowDowngrade: false,
      setFeedURL: () => {},
      // 확인이 끝난 상태(error)로 돌아와야 다음 확인이 돈다.
      checkForUpdates: () => Promise.reject(new Error('offline')),
      downloadUpdate: () => Promise.resolve({}),
      quitAndInstall: () => {},
      on() {
        return this
      }
    }
    // 실제 세터처럼 channel 을 바꾸면 allowDowngrade 를 켠다.
    let ch: string | null = null
    Object.defineProperty(u, 'channel', { get: () => ch, set: (v: string) => ((ch = v), (u.allowDowngrade = true)) })
    let want: 'stable' | 'beta' = 'stable'
    const svc = createAutoUpdate({ updater: u, packaged: true, platform: 'win32', channel: () => want, emit: () => {}, onError: () => {} })
    svc.check()
    expect(ch).toBeNull() // 정식 그대로면 손대지 않는다
    await new Promise((r) => setTimeout(r, 0))
    want = 'beta'
    svc.check()
    expect(ch).toBe('beta')
    expect(u.allowDowngrade).toBe(false)
  })
})
