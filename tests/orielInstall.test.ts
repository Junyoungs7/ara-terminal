// Oriel 내려받아 설치 — latest.yml 파싱, sha512 불일치면 실행 안 함, 서버 404·받기 실패·종료 코드 ≠ 0, 성공 뒤 다시 감지.
// 로컬 가짜 HTTP 서버(127.0.0.1 임의 포트)와 가짜 run 만 쓴다 — 진짜 설치 프로그램·사내 서버에 닿지 않는다.
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createOrielInstaller, ORIEL_INSTALL_ARGS, parseLatestYml } from '../src/main/oriel/install'
import type { OrielInstallState, OrielStatus } from '../src/shared/oriel'
import type { RunResult } from '../src/main/util/runProcess'

const EXE = Buffer.from('fake oriel installer '.repeat(5000))
const SHA = createHash('sha512').update(EXE).digest('base64')
const yml = (sha = SHA): string => `version: 0.2.0\nfiles:\n  - url: Oriel Setup 0.2.0.exe\n    sha512: ${sha}\n    size: ${EXE.length}\npath: Oriel Setup 0.2.0.exe\nsha512: ${sha}\nreleaseDate: '2026-11-04T00:00:00.000Z'\n`

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))

async function serve(routes: Record<string, (res: import('node:http').ServerResponse) => void>): Promise<string> {
  const srv: Server = createServer((req, res) => {
    const r = routes[decodeURIComponent(req.url ?? '')]
    if (r) r(res)
    else res.writeHead(404).end()
  })
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
  cleanup.push(() => srv.close())
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}/downloads/oriel`
}

const INSTALLED: OrielStatus = { installed: true, info: { version: '0.2.0', appPath: 'x', electronPath: 'x', cliPath: 'x', running: false }, runner: { command: 'x', env: {} }, kind: 'standalone' }

function make(feed: string, opts: { code?: number; installed?: boolean } = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ara-oriel-inst-'))
  cleanup.push(() => rmSync(tmpRoot, { recursive: true, force: true }))
  const runs: { file: string; args: readonly string[]; existed: boolean }[] = []
  const states: OrielInstallState[] = []
  let redetects = 0
  const inst = createOrielInstaller({
    feedUrl: () => feed,
    tmpRoot,
    redetect: async () => (redetects++, opts.installed === false ? { installed: false, tried: [] } : INSTALLED),
    onState: (s) => states.push(s),
    run: async (file, args): Promise<RunResult> => {
      runs.push({ file, args, existed: existsSync(file) })
      const code = opts.code ?? 0
      return { code, stdout: '', stderr: '', error: code ? new Error('exit') : null }
    }
  })
  return { inst, runs, states, tmpRoot, redetects: () => redetects }
}

const okRoutes = (sha?: string) => ({
  '/downloads/oriel/latest.yml': (res: import('node:http').ServerResponse) => res.end(yml(sha)),
  '/downloads/oriel/Oriel Setup 0.2.0.exe': (res: import('node:http').ServerResponse) => res.writeHead(200, { 'content-length': EXE.length }).end(EXE)
})

describe('parseLatestYml', () => {
  it('files[0] 을 읽는다', () => {
    expect(parseLatestYml(yml())).toEqual({ version: '0.2.0', url: 'Oriel Setup 0.2.0.exe', sha512: SHA, size: EXE.length })
  })
  it('옛 모양(path·sha512 만)도', () => {
    expect(parseLatestYml(`version: 1.0.0\npath: a.exe\nsha512: abc\n`)).toEqual({ version: '1.0.0', url: 'a.exe', sha512: 'abc', size: 0 })
  })
  it('칸이 없거나 YAML 이 아니면 null', () => {
    expect(parseLatestYml('version: 1.0.0\n')).toBeNull()
    expect(parseLatestYml('{{{')).toBeNull()
    expect(parseLatestYml('')).toBeNull()
  })
})

describe('createOrielInstaller', () => {
  it('성공 — 받고(진행) sha512 같으면 /S /currentuser 로 실행, 임시 폴더 지우고 다시 감지', async () => {
    const t = make(await serve(okRoutes()))
    expect(await t.inst.install()).toEqual({ phase: 'done' })
    expect(t.runs).toHaveLength(1)
    expect(t.runs[0]!.args).toEqual(ORIEL_INSTALL_ARGS)
    expect(t.runs[0]!.existed).toBe(true)
    expect(t.runs[0]!.file.startsWith(t.tmpRoot)).toBe(true)
    expect(existsSync(join(t.tmpRoot, 'oriel-install'))).toBe(false)
    expect(t.redetects()).toBe(1)
    expect(t.states.some((s) => s.phase === 'download' && s.got === EXE.length && s.total === EXE.length)).toBe(true)
    expect(t.states.some((s) => s.phase === 'install')).toBe(true)
  })

  it('sha512 가 다르면 실행하지 않는다', async () => {
    const t = make(await serve(okRoutes(createHash('sha512').update('other').digest('base64'))))
    expect(await t.inst.install()).toEqual({ phase: 'error', reason: 'sha512' })
    expect(t.runs).toHaveLength(0)
    expect(t.redetects()).toBe(0)
    expect(existsSync(join(t.tmpRoot, 'oriel-install'))).toBe(false)
  })

  it('latest.yml 404 → feed', async () => {
    const t = make(await serve({}))
    expect(await t.inst.install()).toEqual({ phase: 'error', reason: 'feed', detail: 'HTTP 404' })
    expect(t.runs).toHaveLength(0)
  })

  it('설치 파일 404 → download', async () => {
    const t = make(await serve({ '/downloads/oriel/latest.yml': (res) => res.end(yml()) }))
    expect(await t.inst.install()).toEqual({ phase: 'error', reason: 'download', detail: 'HTTP 404' })
    expect(t.runs).toHaveLength(0)
  })

  it('받다가 끊김 → download, 실행 안 함', async () => {
    const t = make(
      await serve({
        '/downloads/oriel/latest.yml': (res) => res.end(yml()),
        '/downloads/oriel/Oriel Setup 0.2.0.exe': (res) => {
          res.writeHead(200, { 'content-length': EXE.length })
          res.write(EXE.subarray(0, 1000))
          setTimeout(() => res.destroy(), 20)
        }
      })
    )
    const r = await t.inst.install()
    expect(r.phase === 'error' && r.reason).toBe('download')
    expect(t.runs).toHaveLength(0)
  })

  it('서버에 닿지 않음 → feed', async () => {
    const t = make('http://127.0.0.1:1/downloads/oriel/')
    const r = await t.inst.install()
    expect(r.phase === 'error' && r.reason).toBe('feed')
  })

  it('latest.yml 모양이 틀림 → parse', async () => {
    const t = make(await serve({ '/downloads/oriel/latest.yml': (res) => res.end('hello: 1\n') }))
    expect(await t.inst.install()).toEqual({ phase: 'error', reason: 'parse' })
  })

  it('설치 종료 코드 ≠ 0 → exit, 다시 감지 안 함', async () => {
    const t = make(await serve(okRoutes()), { code: 2 })
    expect(await t.inst.install()).toEqual({ phase: 'error', reason: 'exit', detail: '2' })
    expect(t.redetects()).toBe(0)
    expect(existsSync(join(t.tmpRoot, 'oriel-install'))).toBe(false)
  })

  it('설치는 끝났는데 감지 안 됨 → missing', async () => {
    const t = make(await serve(okRoutes()), { installed: false })
    expect(await t.inst.install()).toEqual({ phase: 'error', reason: 'missing' })
    expect(t.redetects()).toBe(1)
  })

  it('두 번 눌러도 한 번만 받는다', async () => {
    const t = make(await serve(okRoutes()))
    const [a, b] = await Promise.all([t.inst.install(), t.inst.install()])
    expect(a).toEqual({ phase: 'done' })
    expect(b).toEqual({ phase: 'done' })
    expect(t.runs).toHaveLength(1)
    expect(t.inst.state()).toEqual({ phase: 'done' })
  })
})
