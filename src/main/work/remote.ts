// M8 R5 — 원격 작업 단위의 파일·git 백엔드(SSH). 연결은 관리형 서버의 호스트 연결(managed/feature clientFor — 셸 없는 자기 연결,
// 안 되면 터미널 연결을 빌림)을 **쓰기만** 한다. 명령은 SSH exec(셸 없는 채널 하나씩), 파일은 기존 SFTP.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/providers/ssh-filesystem-provider-sftp.ts(SFTP 로 읽기·쓰기),
// src/shared/text-search.ts(SSH 쪽 rg → 없으면 git grep). 뺀 것: 원격 상주 relay(Orca 는 원격 node 프로세스가 fs·git 을 맡는다 —
// 사내 서버에 node 가 없고, 우리 데몬(orcad)은 PTY 만 맡는다), 원격 폴더 감시(inotify — 열린 파일만 SFTP stat 폴링).
import { StringDecoder } from 'node:string_decoder'
import type { Client, SFTPWrapper, Stats } from 'ssh2'
import { CODE_READONLY_BYTES, type CodeReadResult } from '@shared/codeFiles'
import { DIFF_READ_MAX_BYTES } from '@shared/gitDiff'
import { remotePathArg, shArg } from '@shared/runOn'
import type { RunOptions, RunResult } from '../util/runProcess'
import { friendly } from '../util/fsError'
import { codeOf, writeCode } from '../code/io'
import { SftpService } from '../sftp/SftpService'
import type { FileOpResult } from '@shared/ipc'
import type { Exec, WorkBackend } from './backend'

/** 원격 탐색기 폴더 감시 간격. ponytail: 원격 inotify 가 없어(서버에 아무것도 안 깐다) 이 간격마다 '바뀌었을 수 있음'을 알리고
 *  렌더러가 펼친 폴더만 다시 읽는다. 폴더를 많이 펼치면 SFTP readdir 이 늘어난다 — 문제가 되면 펼친 폴더 mtime 만 stat 으로. */
export const REMOTE_TREE_POLL_MS = 5000
/** 열린 원격 파일 감시 간격. ponytail: 파일마다 SFTP stat 1회/3초 — 많이 열면 원격 inotify(Orca relay 의 watch)로. */
export const REMOTE_WATCH_MS = 3000
/** 감시가 연결 실패를 만나면 이만큼 쉰다(끊긴 서버에 3초마다 다시 접속하지 않게). */
const WATCH_BACKOFF_MS = 30_000
/** git 조회 한 번(worktrees/git 의 로컬 값과 같다). */
const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024

const isMissing = (e: unknown): boolean => (e as { code?: unknown })?.code === 2 || (e as { code?: unknown })?.code === 'ENOENT'
const fail = (e: unknown, extra: Partial<RunResult> = {}): RunResult => {
  const error = e instanceof Error ? e : new Error(String(e))
  return { code: -1, stdout: '', stderr: error.message, error, ...extra }
}

/**
 * 원격 runProcess — `sh -c 'cd -- <cwd> && [ENV=값] exec <file> <args…>'`. 인자는 전부 shArg 로 감싼다(사용자 값이 셸 글이 되지 않게).
 * runProcess 와 같은 모양(code·stdout·stderr·error, 시간·출력 상한, signal 취소, onStdout 흘려 받기)이라 로컬 규칙 함수를 그대로 탄다.
 * 상한·시간 초과·취소면 채널에 KILL 을 보내고 닫는다(code -1). ponytail: 신호를 안 받는 sshd 면 원격 명령은 다음 출력의 SIGPIPE 나 스스로 끝날 때까지 돈다.
 */
export function execOn(c: Client, file: string, args: readonly string[], o: RunOptions = {}): Promise<RunResult> {
  const env = Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${shArg(v)}`)
  const cmd = [...env, 'exec', ...[file, ...args].map(shArg)].join(' ')
  const script = o.cwd ? `cd -- ${remotePathArg(o.cwd)} && ${cmd}` : cmd
  const max = o.maxBuffer ?? 1024 * 1024
  return new Promise((resolve) => {
    c.exec(`sh -c ${shArg(script)}`, (err, ch) => {
      if (err || !ch) return resolve(fail(err ?? new Error('exec 채널을 못 열었다')))
      const outD = new StringDecoder('utf8')
      const errD = new StringDecoder('utf8')
      let out = ''
      let errOut = ''
      let code: number | null = null
      let stopped: Error | null = null
      const stop = (e: Error): void => {
        if (stopped) return
        stopped = e
        try {
          ch.signal('KILL')
        } catch {
          /* 신호를 못 보내도 닫는다 */
        }
        ch.close()
      }
      const timer = setTimeout(() => stop(Object.assign(new Error('원격 명령 시간 초과'), { killed: true })), o.timeoutMs ?? 10_000)
      const onAbort = (): void => stop(Object.assign(new Error('취소했습니다'), { name: 'AbortError' }))
      o.signal?.addEventListener('abort', onAbort, { once: true })
      if (o.signal?.aborted) onAbort()
      const take = (s: string): void => {
        if (!s || stopped) return
        if (out.length + s.length > max) return stop(new Error('stdout maxBuffer length exceeded'))
        out += s
        o.onStdout?.(s)
      }
      ch.on('data', (b: Buffer) => take(outD.write(b)))
      ch.stderr.on('data', (b: Buffer) => {
        const s = errD.write(b)
        errOut = (errOut + s).slice(-max)
        o.onStderr?.(s)
      })
      ch.on('exit', (c: number | null) => (code = typeof c === 'number' ? c : null))
      ch.on('close', () => {
        clearTimeout(timer)
        o.signal?.removeEventListener('abort', onAbort)
        take(outD.end())
        errOut += errD.end()
        if (stopped) return resolve({ code: -1, stdout: out, stderr: errOut, error: stopped })
        const exit = code ?? 1
        resolve({ code: exit, stdout: out, stderr: errOut, error: exit === 0 ? null : Object.assign(new Error(errOut.trim() || `exit ${exit}`), { code: exit }) })
      })
      if (o.input !== undefined) ch.end(o.input)
      else ch.end()
    })
  })
}

// 연결마다 SFTP 채널 하나(감시 폴링이 매번 서브시스템을 새로 열지 않게). 닫히면 다음에 새로.
const sftps = new WeakMap<Client, Promise<SFTPWrapper>>()
function sftpOf(c: Client): Promise<SFTPWrapper> {
  let p = sftps.get(c)
  if (!p) {
    p = new Promise<SFTPWrapper>((res, rej) => c.sftp((e, s) => (e ? rej(e) : res(s))))
    sftps.set(c, p)
    p.then(
      (s) => s.on('close', () => sftps.get(c) === p && sftps.delete(c)),
      () => sftps.get(c) === p && sftps.delete(c)
    )
  }
  return p
}

const statOf = (s: SFTPWrapper, path: string): Promise<Stats> => new Promise((res, rej) => s.stat(path, (e, st) => (e ? rej(e) : res(st))))
const readAll = (s: SFTPWrapper, path: string): Promise<Buffer> => new Promise((res, rej) => s.readFile(path, (e, b) => (e ? rej(e) : res(b))))
const writeAll = (s: SFTPWrapper, path: string, b: Buffer): Promise<void> => new Promise((res, rej) => s.writeFile(path, b, (e) => (e ? rej(e) : res())))
/** 앞 len 바이트만(CODE_READONLY_BYTES 를 넘는 파일은 앞부분만 읽기 전용으로 — 로컬과 같은 규칙). */
function readHead(s: SFTPWrapper, path: string, len: number): Promise<Buffer> {
  if (len === 0) return Promise.resolve(Buffer.alloc(0))
  return new Promise((res, rej) => {
    const parts: Buffer[] = []
    s.createReadStream(path, { start: 0, end: len - 1 })
      .on('data', (b: Buffer) => parts.push(b))
      .on('error', rej)
      .on('close', () => res(Buffer.concat(parts)))
  })
}

/** 원격 경로 잇기(늘 POSIX — node:path 의 join 은 Windows 에서 '\' 를 넣는다). */
const posixJoin = (root: string, rel: string): string => `${root.replace(/\/+$/, '')}/${rel}`

/** 원격 작업 단위의 백엔드. client = 그 호스트의 연결(부를 때마다 — 끊겼으면 관리형 서버 쪽이 새로 붙는다). */
export function remoteBackend(client: () => Promise<Client>): WorkBackend {
  const exec: Exec = async (file, args, o) => {
    try {
      return await execOn(await client(), file, args, o)
    } catch (e) {
      return fail(e)
    }
  }
  const sftp = async (): Promise<SFTPWrapper> => sftpOf(await client())
  // M12 CV-01 탐색기 — 터미널 [파일] 탭의 SFTP 조작(SftpService: 링크 해석·이름 검증·EXCL 새 파일·재귀 삭제)을 그대로 쓴다. 세션 id 자리는 안 쓴다.
  const svc = async (): Promise<SftpService> => {
    const c = await client()
    return new SftpService(() => c, () => {})
  }
  const op = async (fn: (s: SftpService) => Promise<FileOpResult>): Promise<FileOpResult> => {
    try {
      return await fn(await svc())
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }
  // 서버에 rg 가 있나(연결마다 한 번). 없으면 git ls-files·git grep — 원격에 rg 를 깔지 않는다.
  const rgOf = new WeakMap<Client, Promise<string | null>>()
  return {
    platform: 'linux',
    win: false,
    exec,
    async rg() {
      const c = await client()
      let p = rgOf.get(c)
      if (!p) rgOf.set(c, (p = execOn(c, 'sh', ['-c', 'command -v rg'], { timeoutMs: 10_000 }).then((r) => (r.code === 0 && r.stdout.trim() ? 'rg' : null))))
      return p
    },
    async readCode(path): Promise<CodeReadResult> {
      try {
        const s = await sftp()
        const st = await statOf(s, path)
        if (!st.isFile()) return { ok: false, message: '파일이 아닙니다.' }
        return codeOf(await readHead(s, path, Math.min(st.size, CODE_READONLY_BYTES)), st.size)
      } catch (e) {
        return { ok: false, message: friendly(e as NodeJS.ErrnoException), ...(isMissing(e) ? { missing: true } : {}) }
      }
    },
    // 변경 감지 안전 저장(WS-08) 그대로 — 쓰기 직전 원격 바이트의 sha1 을 읽은 때의 서명과 비교한다(mtime 이 아니라 내용).
    writeCode: (path, text, eol, baseSig, force) =>
      writeCode(path, text, eol, baseSig, force, {
        read: async () => readAll(await sftp(), path).catch((e) => (isMissing(e) ? null : Promise.reject(e))),
        write: async (b) => writeAll(await sftp(), path, b)
      }),
    inspect: {
      git: (args, cwd) => exec('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }),
      readText: async (root, rel) => {
        const s = await sftp()
        const p = posixJoin(root, rel)
        const st = await statOf(s, p).catch(() => null)
        if (!st?.isFile()) return ''
        return st.size > DIFF_READ_MAX_BYTES ? null : (await readAll(s, p)).toString('utf8')
      },
      // 3차 R2-B 그림 비교 — exec 는 글로 풀어 돌려주므로 서버에서 base64 로 바꿔 받는다(coreutils base64 — 서버에 깔 것 없음).
      gitBytes: async (args, cwd) => {
        const r = await exec('sh', ['-c', 'git "$@" | base64', 'sh', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })
        return r.code === 0 && r.stdout.trim() ? Buffer.from(r.stdout, 'base64') : null
      },
      readBytes: async (root, rel, max) => {
        const s = await sftp()
        const p = posixJoin(root, rel)
        const st = await statOf(s, p).catch(() => null)
        if (!st?.isFile()) return null
        return st.size > max ? 'tooLarge' : new Uint8Array(await readAll(s, p))
      }
    },
    fs: {
      list: async (path) => {
        try {
          return await (await svc()).list('', path)
        } catch (e) {
          return { ok: false, message: (e as Error).message }
        }
      },
      rename: (path, name) => op((s) => s.rename('', path, name)),
      mkdir: (dir, name) => op((s) => s.mkdir('', dir, name)),
      newFile: (dir, name) => op((s) => s.makeFile('', dir, name)),
      remove: (paths) => op((s) => s.remove('', `work-rm-${Date.now()}`, paths)),
      // SFTP rename 한 번(같은 서버 안). 덮어쓰지 않는다 — 있으면 멈춘다(로컬 moveEntries 와 같은 규칙).
      async move(paths, destDir) {
        try {
          const s = await sftp()
          for (const src of paths) {
            const name = src.replace(/\/+$/, '').split('/').pop() ?? ''
            const dest = posixJoin(destDir, name)
            if (dest === src) continue
            if (destDir === src || destDir.startsWith(src.replace(/\/+$/, '') + '/')) return { ok: false, message: `폴더를 자기 안으로 옮길 수 없습니다: ${name}` }
            if (await statOf(s, dest).then(() => true, () => false)) return { ok: false, message: `이미 있습니다: ${name}` }
            await new Promise<void>((res, rej) => s.rename(src, dest, (e) => (e ? rej(e) : res())))
          }
          return { ok: true }
        } catch (e) {
          return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
        }
      },
      async readBytes(path, max) {
        try {
          const s = await sftp()
          const st = await statOf(s, path)
          if (!st.isFile()) return { ok: false, message: '파일이 아닙니다.' }
          if (st.size > max) return { ok: false, tooBig: true, size: st.size, message: '' }
          return { ok: true, data: new Uint8Array(await readAll(s, path)) }
        } catch (e) {
          return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
        }
      }
    },
    watchTree(_root, onChange) {
      const timer = setInterval(onChange, REMOTE_TREE_POLL_MS)
      return () => clearInterval(timer)
    },
    // 밖에서 바뀜 — mtime·크기가 달라지면 알린다(렌더러가 다시 읽어 **서명**으로 판정). 연결이 안 되면 잠깐 쉰다.
    watch(path, onChange) {
      let last: string | undefined
      let busy = false
      let restUntil = 0
      const tick = async (): Promise<void> => {
        if (busy || Date.now() < restUntil) return
        busy = true
        try {
          const s = await sftp()
          const st = await statOf(s, path).catch((e) => (isMissing(e) ? null : Promise.reject(e)))
          const key = st ? `${st.mtime}:${st.size}` : 'missing'
          if (last !== undefined && key !== last) onChange()
          last = key
        } catch {
          restUntil = Date.now() + WATCH_BACKOFF_MS
        } finally {
          busy = false
        }
      }
      void tick()
      const timer = setInterval(() => void tick(), REMOTE_WATCH_MS)
      return () => clearInterval(timer)
    }
  }
}
