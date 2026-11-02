// 정리 1: 아라가 띄우는 PTY(에이전트 탭·터미널 공간 로컬 셸, 앱 안·데몬 경유 모두)는 [CLI 설치] 없이 `ara` 가 된다.
// Orca src/main/cli/orca-cli-child-path.ts(orcaRef ec112c6b01)의 Windows 몫 — Orca 는 host-env/assembly.ts 에서 **모든 로컬 PTY** 의
// PATH 맨 앞에 CLI 폴더를 넣는다(터미널·에이전트 구분 없음). 아라도 같은 규칙. 원격(SSH) 셸·서버에는 아무것도 안 넣는다.
//  · 전역 PATH(레지스트리)는 건드리지 않는다 — 자식 env 만.
//  · 설치본: `<resources>\bin`(ara.cmd). 개발판: `<userData>\cli\bin\ara.cmd` 를 그 dev 실행 파일·out/main/araCli.js 로 써 둔다
//    (Orca ensureDevLauncher 와 같은 자리. Orca 는 Windows dev 이름이 `orca-dev` 지만 아라는 에이전트가 같은 `ara` 를 치게 그대로 ara).
//  · ARA_USER_DATA_PATH 도 싣는다 — 그 탭의 `ara` 는 자기를 띄운 아라(개발판·e2e 의 임시 userData 포함)에 붙는다.
// 데몬 프로세스 안에서는 설정되지 않아 아무것도 안 한다 — 데몬 셸 env 는 앱이 여기서 이미 고쳐 보낸다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PATH_KEY = /^path$/i
let state: { binDir: string; userData: string } | null = null

/** PATH 키(대소문자 무관)를 하나로 모아 binDir 를 맨 앞에(중복 제거·빈 칸 없이). 원본은 안 바꾼다. */
export function prependAraCliPath(env: Record<string, string>, binDir: string, userData: string): Record<string, string> {
  const out = { ...env }
  const keys = Object.keys(out).filter((k) => PATH_KEY.test(k))
  const inherited = keys.length ? out[keys[keys.length - 1]] : '' // 뒤에 펼친 것이 이긴 값
  for (const k of keys) delete out[k]
  const same = (e: string): boolean => e.replace(/[\\/]+$/, '').toLowerCase() === binDir.replace(/[\\/]+$/, '').toLowerCase()
  const rest = (inherited ?? '').split(';').filter((e) => e.length > 0 && !same(e))
  out[keys[0] ?? 'Path'] = [binDir, ...rest].join(';')
  out['ARA_USER_DATA_PATH'] = userData
  return out
}

/** 이 아라 프로세스의 PTY env 에 ara 폴더를 얹는다. 준비 안 됐으면(데몬 프로세스·맥) 그대로. */
export const withAraCliPath = (env: Record<string, string>): Record<string, string> => (state ? prependAraCliPath(env, state.binDir, state.userData) : env)

/** 개발판 ara.cmd 본문. cmd 는 콘솔 코드 페이지로 읽으므로 ASCII 경로만(아니면 null — 그 PC 의 개발판은 [CLI 설치]처럼 ara 없음). */
export function devLauncherText(execPath: string, cliEntry: string): string | null {
  if (!/^[\x20-\x7e]+$/.test(execPath + cliEntry)) return null
  const q = (p: string): string => `"${p.replace(/%/g, '%%')}"`
  return ['@echo off', 'rem ARA dev CLI launcher - written by the dev app; only its own agent/terminal tabs put this folder first in PATH.', 'setlocal', 'set "ELECTRON_RUN_AS_NODE=1"', `${q(execPath)} ${q(cliEntry)} %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n')
}

/** 켤 때 한 번(main/cli/feature.ts). 폴더를 못 정하면 state 없음 = PATH 그대로. */
export function setupAraCliChildPath(o: { platform: NodeJS.Platform; isPackaged: boolean; resourcesPath: string; userData: string; execPath: string; cliEntryCandidates: string[]; log: (m: string) => void }): string | null {
  state = null
  if (o.platform !== 'win32') return null
  let binDir: string | null = null
  if (o.isPackaged) {
    const dir = join(o.resourcesPath, 'bin')
    if (existsSync(join(dir, 'ara.cmd'))) binDir = dir
  } else {
    const entry = o.cliEntryCandidates.find((p) => existsSync(p))
    const text = entry ? devLauncherText(o.execPath, entry) : null
    if (text) {
      const dir = join(o.userData, 'cli', 'bin')
      const file = join(dir, 'ara.cmd')
      try {
        if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
          mkdirSync(dir, { recursive: true })
          writeFileSync(file, text, 'ascii')
        }
        binDir = dir
      } catch (e) {
        o.log(`ara dev launcher: ${String(e)}`)
      }
    }
  }
  if (binDir) state = { binDir, userData: o.userData }
  return binDir
}
