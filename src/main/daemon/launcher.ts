// M4 DM-01 — 데몬 띄우기(앱 쪽). Electron 실행 파일을 ELECTRON_RUN_AS_NODE=1 로, 앱과 떼어(detached) 띄운다(Orca daemon-launched-child-spawn.ts).
// Windows 설치본은 실행 파일·node-pty 를 설치 폴더 밖(%LOCALAPPDATA%\ARA\daemon-host\<판>)에 복사해 거기서 띄운다(Orca daemon-host-relocation.ts):
//  · NSIS 업데이트는 설치 폴더 안에서 도는 프로세스를 죽인다(app-builder-lib allowOnlyOneInstallerInstance.nsh — 경로로 찾아 Stop-Process)
//  · 데몬이 설치 폴더의 node-pty .node·conpty.dll 을 쥐고 있으면 업데이트가 그 파일을 못 바꾼다.
// 복사에 실패하면 설치 폴더 것으로 띄운다(Orca 와 같음 — 그 판은 업데이트 때 데몬이 죽는다, 로그에 남김).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { cp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { spawnDetached } from '../util/runProcess'

const READY_TIMEOUT_MS = 15_000
const STDERR_MAX = 4096
/** Electron 이 node 모드에서도 읽는 런타임 파일(Orca daemon-host-manifest RUNTIME_DATA_FILES). */
const RUNTIME_DATA_FILES = ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']
const DONE_MARK = '.ara-daemon-host-complete'

export type DaemonRuntime = { execPath: string; entryPath: string }

/** 설치 런타임 그대로: 실행 파일 + (asar 밖으로 풀린) out/main/daemonEntry.js. */
export function installRuntime(appPath: string, execPath: string): DaemonRuntime {
  const base = appPath.includes('app.asar') ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  return { execPath, entryPath: join(base, 'out', 'main', 'daemonEntry.js') }
}

/**
 * Windows 설치본: 설치 폴더 밖으로 옮긴 런타임. 판마다 폴더 하나(같은 판이면 다시 안 복사), 다른 판 폴더는 **쓰는 프로세스가 없을 때만** 지운다 —
 * 도는 exe 가 든 폴더는 Windows 가 이름을 못 바꾸게 하므로 rename 이 성공해야만 지운다(살아 있는 옛 데몬의 파일을 반쯤 지우지 않게).
 */
// 복사는 비동기 — 실행 파일이 수백 MB 라 main 을 막지 않게(판이 바뀐 뒤 첫 에이전트 실행 때 한 번).
export async function relocatedRuntime(o: { hostRoot: string; version: string; execPath: string; resourcesPath: string; log: (m: string) => void }): Promise<DaemonRuntime | null> {
  const appDir = dirname(o.execPath)
  const unpacked = join(o.resourcesPath, 'app.asar.unpacked')
  const dest = join(o.hostRoot, o.version)
  const rel = (p: string): string => p.slice(appDir.length + 1)
  const out = (root: string): DaemonRuntime => ({ execPath: join(root, basename(o.execPath)), entryPath: join(root, rel(join(unpacked, 'out', 'main', 'daemonEntry.js'))) })
  try {
    if (!existsSync(join(dest, DONE_MARK))) {
      mkdirSync(o.hostRoot, { recursive: true })
      const tmp = `${dest}.tmp-${randomBytes(4).toString('hex')}`
      await cp(o.execPath, join(tmp, basename(o.execPath)))
      for (const f of RUNTIME_DATA_FILES) if (existsSync(join(appDir, f))) await cp(join(appDir, f), join(tmp, f))
      for (const d of [join(unpacked, 'out', 'main'), join(unpacked, 'node_modules', 'node-pty')]) {
        await cp(d, join(tmp, rel(d)), { recursive: true, filter: (p) => !p.endsWith('.pdb') })
      }
      await writeFile(join(tmp, DONE_MARK), o.version)
      try {
        await rename(tmp, dest)
      } catch {
        await rm(tmp, { recursive: true, force: true }) // 누가 먼저 만들었다 — 그것을 쓴다
      }
    }
    for (const name of await readdir(o.hostRoot)) {
      if (name === o.version) continue
      const old = join(o.hostRoot, name)
      try {
        const doomed = `${old}.del-${randomBytes(4).toString('hex')}`
        await rename(old, doomed) // 쓰는 중이면 여기서 던진다 → 그대로 둔다
        await rm(doomed, { recursive: true, force: true })
      } catch {
        /* 옛 데몬이 아직 쓴다 — 다음 번에 */
      }
    }
    return existsSync(join(dest, DONE_MARK)) ? out(dest) : null
  } catch (e) {
    o.log(`daemon host relocation failed: ${String(e)}`)
    return null
  }
}

/**
 * 데몬을 띄우고 ready 를 기다린다. 토큰은 새로 만들어 0600 파일로 — 데몬이 읽는다. 띄운 뒤엔 관(stdio)을 끊고 놓아준다(unref) —
 * 앱이 꺼져도 데몬은 산다.
 */
export function spawnDaemon(o: { runtime: DaemonRuntime; runtimeDir: string; socketPath: string; tokenPath: string; logFile: string; appVersion: string; exitWithClients?: boolean }): Promise<string> {
  mkdirSync(o.runtimeDir, { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('hex')
  writeFileSync(o.tokenPath, token, { mode: 0o600 })
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  // 데몬은 워크트리보다 오래 산다 — 지워질 수 없는 자리를 cwd 로(Orca: userData).
  const child = spawnDetached(o.runtime.execPath, [o.runtime.entryPath, '--socket', o.socketPath, '--token', o.tokenPath, '--log', o.logFile, '--app-version', o.appVersion, ...(o.exitWithClients ? ['--exit-with-clients'] : [])], { cwd: o.runtimeDir, env })
  return new Promise((resolve, reject) => {
    let err = ''
    const done = (e: Error | null): void => {
      clearTimeout(timer)
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.removeAllListeners()
      child.on('error', () => {})
      child.unref()
      if (e) reject(e)
      else resolve(token)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 무시 */
      }
      done(new Error(`데몬 시작 시간 초과 ${err.trim()}`))
    }, READY_TIMEOUT_MS)
    child.stdout?.on('data', (b: Buffer) => b.toString().includes('ready') && done(null))
    child.stderr?.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-STDERR_MAX)))
    child.once('error', (e) => done(e))
    child.once('exit', (code) => done(new Error(`데몬이 시작하다 끝남(code ${code}) ${err.trim()}`)))
  })
}
