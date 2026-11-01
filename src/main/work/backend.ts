// M8 R5 — 작업 단위의 파일·git 백엔드를 고르는 **한 자리**. 패널(에디터·빠른 열기·검색·변경 비교·소스 제어)은 IPC 에 host 만 실어 보내고,
// 로컬/원격 갈래는 여기서 한 번 고른다. 규칙(서명 비교 저장·검색 상한·푸시 안전장치)은 code/·git/·scm/ 의 같은 함수를 탄다 — 바뀌는 것은 exec·디스크뿐.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/providers/execution-host-provider-dispatch.ts — 호스트 축(기능 단위), 모르는 호스트는
// 이 PC 로 물러서지 않는다(원격 연결이 안 되면 실패로 끝난다).
import { app } from 'electron'
import { unwatchFile, watchFile, type Stats } from 'node:fs'
import type { Client } from 'ssh2'
import type { CodeReadResult, CodeWriteResult } from '@shared/codeFiles'
import { runProcess } from '../util/runProcess'
import { readCode, writeCode } from '../code/io'
import { rgBinPath } from '../code/search'
import { LOCAL_INSPECT, type InspectIO } from '../git/inspect'
import { remoteBackend } from './remote'

/** runProcess 모양 — 로컬은 runProcess, 원격은 SSH exec(work/remote execOn). */
export type Exec = typeof runProcess

export type WorkBackend = {
  /** 경로 판정(isInsidePath)의 플랫폼 — 원격은 늘 POSIX('linux'). */
  platform: string
  /** rg 인자에 '/' 구분자를 강제할지(로컬 Windows 만). */
  win: boolean
  exec: Exec
  /** 검색 도구 — 로컬은 앱에 실린 rg, 원격은 서버에 rg 가 있으면 'rg', 없으면 null(git ls-files·git grep). */
  rg(): Promise<string | null>
  readCode(path: string): Promise<CodeReadResult>
  writeCode(path: string, text: string, eol: 'lf' | 'crlf', baseSig: string, force: boolean): Promise<CodeWriteResult>
  /** git 조회(변경 목록·diff)가 쓰는 git·작업 폴더 글. */
  inspect: InspectIO
  /** 열린 파일 감시 — 바뀌면 onChange. 돌려준 함수로 멈춘다. */
  watch(path: string, onChange: () => void): () => void
}

/** 열린 로컬 파일 감시 간격. ponytail: stat 폴링(열린 파일만 — 몇 개). 많이 열게 되면 폴더 감시(@parcel/watcher, Orca)로. */
const WATCH_MS = 1000
let rgPath: string | null = null

const LOCAL: WorkBackend = {
  platform: process.platform,
  win: process.platform === 'win32',
  exec: runProcess,
  // M6 R2 WS-06·09 — 앱에 실린 rg(설치본은 app.asar.unpacked).
  rg: async () => (rgPath ??= rgBinPath(app.getAppPath(), process.platform, process.arch)),
  readCode,
  writeCode: (path, text, eol, baseSig, force) => writeCode(path, text, eol, baseSig, force),
  inspect: LOCAL_INSPECT,
  watch(path, onChange) {
    const listener = (cur: Stats, prev: Stats): void => {
      if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) onChange()
    }
    watchFile(path, { interval: WATCH_MS, persistent: false }, listener)
    return () => unwatchFile(path, listener)
  }
}

let clients: ((hostKey: string) => Promise<Client>) | null = null
/** 관리형 서버 기능이 그 호스트의 연결을 내주는 길을 건다(main/managed/feature.ts). */
export function setRemoteClients(fn: (hostKey: string) => Promise<Client>): void {
  clients = fn
}

const remotes = new Map<string, WorkBackend>()
/** host 없음 = 이 PC. host = 원격 작업 단위의 서버(hostKey `user@host:port`). */
export function workBackend(host?: unknown): WorkBackend {
  if (typeof host !== 'string' || !host) return LOCAL
  let b = remotes.get(host)
  if (!b) {
    b = remoteBackend(() => (clients ? clients(host) : Promise.reject(new Error('관리형 서버 기능이 아직 준비되지 않았습니다.'))))
    remotes.set(host, b)
  }
  return b
}
