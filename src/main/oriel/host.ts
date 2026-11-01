// OR-2 — 설치본 A.R.A.exe 가 Oriel 호스트로 뜰지 판별(안 A). electron 을 import 하지 않는다 — main/boot.ts 가 아라 모듈보다 먼저 부른다.
// 설치본에는 default_app.asar 가 없어 `"A.R.A.exe" "<Oriel 폴더>"` 를 주면 아라가 하나 더 뜬다 → 명시적인 두 조건이 다 맞을 때만
// 아라 초기화를 전혀 하지 않고 `<resources>/oriel` 의 Oriel main 을 불러온다. 사용자가 우연히 들어갈 수 없게 둘 다 요구한다.
import { isAbsolute, resolve } from 'node:path'

/** 아라가 Oriel CLI 를 부를 때 넣는 env. Oriel CLI 는 ELECTRON_*·NODE_OPTIONS 만 걸러 앱에 넘기므로(src/cli/mcp.mjs launchCommand) 앱까지 닿는다. */
export const ARA_HOST_APP_ENV = 'ARA_HOST_APP'
/** 같은 뜻의 인자 표식 — 앱 폴더(argv[1]) 바로 뒤(argv[2])에 있을 때만 인정. */
export const ARA_HOST_ARG = '--ara-host=oriel'

/** dir 이 설치본 동봉 자리 `<resources>/oriel` 과 정확히 같은가(절대 경로만, Windows 는 대소문자 무시). */
export function isBundledOrielDir(dir: string, resourcesPath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!dir || !resourcesPath || !isAbsolute(dir)) return false
  const norm = (p: string): string => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  return norm(dir) === norm(resolve(resourcesPath, 'oriel'))
}

/**
 * 호스트 모드면 Oriel 폴더, 아니면 null(= 아라로 뜬다). 조건: 설치본 + env `ARA_HOST_APP=oriel` + 첫 인자(argv[1])가 정확히 `<resources>/oriel`.
 * Oriel CLI 는 `"<ORIEL_ELECTRON>" "<앱 폴더>"`(기본 브라우저 등록은 뒤에 `-- <url>`)로 띄우므로 앱 폴더는 늘 argv[1] 이다.
 */
export function orielHostDir(o: {
  argv: readonly string[]
  env: Record<string, string | undefined>
  resourcesPath: string | undefined
  packaged: boolean
  platform?: NodeJS.Platform
}): string | null {
  // 기본 브라우저 등록 명령줄은 env 를 못 실어서 Oriel 이 `"<exe>" "<resources>\oriel" --ara-host=oriel -- "%1"` 로 등록한다
  // → env 대신 앱 폴더 바로 뒤의 인자 표식도 받는다. 그 뒤(`--`·URL)는 Oriel 몫이라 보지 않는다.
  const marked = o.env[ARA_HOST_APP_ENV] === 'oriel' || o.argv[2] === ARA_HOST_ARG
  if (!o.packaged || !marked || !o.resourcesPath) return null
  const arg = o.argv[1] ?? ''
  return isBundledOrielDir(arg, o.resourcesPath, o.platform) ? resolve(o.resourcesPath, 'oriel') : null
}
