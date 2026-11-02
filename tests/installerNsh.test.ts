// NSIS 스크립트에 보이지 않는 제어 문자가 섞이면 makensis 가 "unterminated string" 으로 설치본 빌드를 깬다.
// M4 때 `WindowsPowerShell\v1.0` 의 `\v` 가 세로 탭(0x0B) 한 바이트로 들어가 3.0.0-preview.1 빌드가 실패했다 — 소스로는 안 보인다.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = join(__dirname, '..', 'resources')

describe('resources/*.nsh', () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.nsh'))) {
    it(`${f} 에 탭·줄바꿈 말고 제어 문자가 없다`, () => {
      const bad = [...readFileSync(join(dir, f))].filter((b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)
      expect(bad).toEqual([])
    })
  }
})

// UB-2 — 2.x 설치 프로그램이 1.x(com.verygood.ara)를 먼저 조용히 지운다. 실제 설치·제거는 실기 확인(USER-CHECKLIST).
// 여기서 무는 것: 옛 GUID 가 appId 에서 나온 값과 같은지, electron-builder 의 옛 판 제거 길(KEY_2)에 걸렸는지,
// 그 길이 /S 와 ExecWait 로 기다리는지(electron-builder 템플릿이 바뀌면 이 시험이 먼저 깨진다).
describe('UB-2 1.x 먼저 제거', () => {
  const root = join(__dirname, '..')
  const nsh = readFileSync(join(dir, 'installer.nsh'), 'utf8')
  const tpl = join(root, 'node_modules', 'app-builder-lib', 'templates', 'nsis')

  it('옛 GUID = UUID v5(com.verygood.ara, electron-builder 이름공간), 2.x appId 와 다르다', async () => {
    const { UUID } = await import('builder-util-runtime')
    const ns = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')
    const v1 = UUID.v5('com.verygood.ara', ns)
    expect(v1).toBe('de1cde4d-a29e-5c46-87e0-3dc2fcc68610')
    expect(nsh).toContain(`!define ARA_V1_GUID "${v1}"`)
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const appId = /^appId:\s*(\S+)/m.exec(yml)?.[1]
    expect(appId).toBeTruthy()
    expect(UUID.v5(appId!, ns)).not.toBe(v1)
    // electron-builder 가 KEY_2 를 스스로 정의하는 경우(appId 에 '\')가 아니어야 우리 !define 과 안 겹친다
    expect(appId).not.toContain(String.fromCharCode(92))
  })

  it('1.x 제거 키를 UNINSTALL_REGISTRY_KEY_2 로 건다', () => {
    expect(nsh).toContain(
      ['!define UNINSTALL_REGISTRY_KEY_2 "Software', 'Microsoft', 'Windows', 'CurrentVersion', 'Uninstall', '${ARA_V1_GUID}"'].join(
        String.fromCharCode(92),
      ),
    )
  })

  it('electron-builder 의 옛 판 제거가 KEY_2 를 읽고 /S·ExecWait·--updated 로 기다린다', () => {
    const util = readFileSync(join(tpl, 'include', 'installUtil.nsh'), 'utf8')
    expect(util).toMatch(/!ifdef UNINSTALL_REGISTRY_KEY_2\s+!insertmacro readReg \$uninstallString "\$rootKey" "\$\{UNINSTALL_REGISTRY_KEY_2\}" UninstallString/)
    expect(util).toMatch(/ExecWait '"\$uninstallerFileNameTemp" \/S \/KEEP_APP_DATA \$0 _\?=\$installationDir' \$R0/)
    expect(util).toContain('StrCpy $0 "$0 --updated"')
    // 실행 중 처리 → 옛 판 제거 → 파일 풀기 순서
    const sec = readFileSync(join(tpl, 'installSection.nsh'), 'utf8')
    const i = (s: string) => sec.indexOf(s)
    expect(i('CHECK_APP_RUNNING')).toBeGreaterThan(-1)
    expect(i('CHECK_APP_RUNNING')).toBeLessThan(i('!insertmacro uninstallOldVersion SHELL_CONTEXT'))
    expect(i('!insertmacro uninstallOldVersion HKEY_CURRENT_USER')).toBeGreaterThan(-1)
  })

  it('customInit 은 지우지 않고 범위 기본값만 — 1.x 가 HKLM 에만 있을 때', () => {
    const m = /!macro customInit([\s\S]*?)!macroend/.exec(nsh)?.[1] ?? ''
    expect(m).toContain('ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString')
    expect(m).toContain('!insertmacro setInstallModePerAllUsers')
    expect(m).not.toMatch(/Exec|Delete|RMDir/)
    const nsi = readFileSync(join(tpl, 'installer.nsi'), 'utf8')
    expect(nsi.indexOf('!insertmacro initMultiUser')).toBeLessThan(nsi.indexOf('!insertmacro customInit'))
  })
})
