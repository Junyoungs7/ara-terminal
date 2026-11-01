// M8 R5 — 작업 단위의 파일·git 백엔드를 고르는 **한 자리**. 패널(에디터·빠른 열기·검색·변경 비교·소스 제어)은 IPC 에 host 만 실어 보내고,
// 로컬/원격 갈래는 여기서 한 번 고른다. 규칙(서명 비교 저장·검색 상한·푸시 안전장치)은 code/·git/·scm/ 의 같은 함수를 탄다 — 바뀌는 것은 exec·디스크뿐.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/providers/execution-host-provider-dispatch.ts — 호스트 축(기능 단위), 모르는 호스트는
// 이 PC 로 물러서지 않는다(원격 연결이 안 되면 실패로 끝난다).
import { app } from 'electron'
import { unwatchFile, watchFile, watch as fsWatch, type Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { Client } from 'ssh2'
import type { CodeReadResult, CodeWriteResult } from '@shared/codeFiles'
import type { FileListResult, FileOpResult } from '@shared/ipc'
import type { BytesResult } from '@shared/media'
import * as LocalFs from '../fs/LocalFs'
import { friendly } from '../util/fsError'
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
  /** M12 CV-01 파일 탐색기 — 터미널 [파일] 탭(LocalFs·SftpService)과 같은 계약. remove 는 로컬 = 휴지통, 원격 = 영구(서버에 휴지통이 없다). */
  fs: {
    list(path: string): Promise<FileListResult>
    rename(path: string, name: string): Promise<FileOpResult>
    mkdir(dir: string, name: string): Promise<FileOpResult>
    newFile(dir: string, name: string): Promise<FileOpResult>
    remove(paths: string[]): Promise<FileOpResult>
    move(paths: string[], destDir: string): Promise<FileOpResult>
    /** M12 CV-02 뷰어 — 파일 통째(상한 max 바이트). */
    readBytes(path: string, max: number): Promise<BytesResult>
  }
  /** 작업 단위 폴더 감시(탐색기) — 무언가 바뀌면 onChange(묶어서). */
  watchTree(root: string, onChange: () => void): () => void
}

/** 폴더 감시 묶음 — 에이전트가 파일을 수십 개 쓰는 동안 목록을 수십 번 다시 읽지 않게. */
export const TREE_WATCH_DEBOUNCE_MS = 300
/** .git 안에서는 스테이징(index)·브랜치(HEAD)만 본다 — 나머지(objects·logs)는 git 명령마다 흔들린다. */
export function treeEventCounts(rel: string | null): boolean {
  if (!rel) return true
  const p = rel.split('\\').join('/')
  if (p !== '.git' && !p.startsWith('.git/')) return true
  return p === '.git/index' || p === '.git/HEAD'
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
  },
  fs: {
    list: LocalFs.list,
    rename: LocalFs.renameEntry,
    mkdir: LocalFs.makeDir,
    newFile: LocalFs.makeFile,
    remove: LocalFs.trash,
    move: LocalFs.moveEntries,
    async readBytes(path, max) {
      try {
        const st = await stat(path)
        if (!st.isFile()) return { ok: false, message: '파일이 아닙니다.' }
        if (st.size > max) return { ok: false, tooBig: true, size: st.size, message: '' }
        return { ok: true, data: new Uint8Array(await readFile(path)) }
      } catch (e) {
        return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
      }
    }
  },
  // Orca 는 @parcel/watcher — 새 의존성 없이 node 재귀 감시(Windows·macOS 는 OS 가, Linux 는 node 20+ 가 재귀).
  watchTree(root, onChange) {
    let timer: ReturnType<typeof setTimeout> | null = null
    let w: ReturnType<typeof fsWatch> | null = null
    try {
      w = fsWatch(root, { recursive: true, persistent: false }, (_ev, name) => {
        if (!treeEventCounts(typeof name === 'string' ? name : null) || timer) return
        timer = setTimeout(() => {
          timer = null
          onChange()
        }, TREE_WATCH_DEBOUNCE_MS)
      })
      w.on('error', () => w?.close())
    } catch {
      /* 폴더가 없음·권한 — 감시 없이(직접 [새로 고침]) */
    }
    return () => {
      if (timer) clearTimeout(timer)
      w?.close()
    }
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
