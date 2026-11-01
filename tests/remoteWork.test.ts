// M8 R5 원격 작업 단위의 파일·검색·git 백엔드(main/work/remote).
// 단위: git grep 대체 길(서버에 rg 가 없을 때)의 인자·줄 읽기.
// 통합: ssh2 하네스 + WSL(Ubuntu) 임시 폴더의 진짜 git 저장소·bare 원격 — 파일 열기·수정 저장·충돌 감지·밖에서 바뀜 감시,
// 빠른 열기(git ls-files), 검색(git grep), 변경 → stage → 커밋 → 로컬 bare 원격으로 푸시, 보호 브랜치 막힘. 실서버·사내 서버에는 붙지 않는다.
// SFTP 는 \\wsl.localhost\<배포판> 을 원격 '/' 로 노출해 exec(진짜 Linux 경로)과 같은 절대 경로를 쓴다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { Client } from 'ssh2'
import { startPasswordServer, type Harness } from './ssh-harness'
import { buildGitGrepArgs, gitGrepMatcher, ingestGitGrepLine, newSearchAcc, type SearchFile } from '../src/shared/codeSearch'
import { execOn, remoteBackend } from '../src/main/work/remote'
import { listFilesOn, searchTextOn } from '../src/main/code/search'
import { readFileDiff, readGitStatus } from '../src/main/git/inspect'
import { commit, push, stagePaths } from '../src/main/scm/git'

const opts = (query: string, more: Partial<{ regex: boolean; caseSensitive: boolean; include: string; exclude: string }> = {}) => ({
  query,
  regex: false,
  caseSensitive: false,
  include: '',
  exclude: '',
  ...more
})

describe('git grep 대체 길 — 순수', () => {
  it('인자: 고정 문자열·대소문자·글롭 → pathspec', () => {
    const a = buildGitGrepArgs(opts('a.b', { include: '*.ts, src/**', exclude: 'dist' }))
    expect(a).toContain('--fixed-strings')
    expect(a).toContain('-i')
    expect(a.slice(a.indexOf('--') + 1)).toEqual([':(glob)**/*.ts', ':(glob)src/**', ':(exclude,glob)**/dist'])
    const b = buildGitGrepArgs(opts('x', { regex: true, caseSensitive: true }))
    expect(b).toContain('--extended-regexp')
    expect(b).not.toContain('-i')
    expect(b.slice(b.indexOf('--') + 1)).toEqual(['.'])
    // 검색어는 -e 뒤 — 옵션으로 읽히지 않는다.
    expect(buildGitGrepArgs(opts('--help'))).toContain('-e')
  })

  it('줄 읽기: 경로 NUL 줄 NUL 내용, 자리는 JS 로 다시 찾는다', () => {
    const acc = newSearchAcc()
    const re = gitGrepMatcher(opts('Hello'))
    expect(ingestGitGrepLine('src/a:b.ts\x0012\x00say hello, hello', re, acc)).toBe('continue')
    const f = acc.files.get('src/a:b.ts')!
    expect(f.matches[0]).toEqual({ line: 12, text: 'say hello, hello', ranges: [[4, 9], [11, 16]] })
    expect(acc.total).toBe(2)
    // JS 가 못 읽는 식이면 줄 전체.
    const acc2 = newSearchAcc()
    ingestGitGrepLine('a\x001\x00(abc', gitGrepMatcher(opts('(', { regex: true })), acc2)
    expect(acc2.files.get('a')!.matches[0].ranges).toEqual([[0, 4]])
    // 상한 — 멈추고 truncated.
    const acc3 = newSearchAcc()
    expect(ingestGitGrepLine('a\x001\x00x x x', gitGrepMatcher(opts('x')), acc3, 2)).toBe('stop')
    expect(acc3.truncated).toBe(true)
  })
})

const DISTRO = process.env['ARA_TEST_WSL_DISTRO'] || 'Ubuntu'
const WIN = process.platform === 'win32'
const WRAP = 'cd "$1" && HOME="$1" exec sh -c "$2"'
const runner = (home: string, cmd: string): [string, string[]] => (WIN ? ['wsl.exe', ['-d', DISTRO, '-e', 'sh', '-c', WRAP, 'sh', home, cmd]] : ['sh', ['-c', WRAP, 'sh', home, cmd]])

function linuxGitReady(): boolean {
  const [f, a] = WIN ? ['wsl.exe', ['-d', DISTRO, '-e', 'git', '--version']] : ['git', ['--version']]
  try {
    return spawnSync(f, a, { timeout: 60_000, windowsHide: true }).status === 0
  } catch {
    return false
  }
}
const READY = linuxGitReady()

const SETUP = [
  'set -e',
  'git init -q --bare origin.git',
  'git -C origin.git symbolic-ref HEAD refs/heads/main',
  'git init -q repo',
  'cd repo',
  'git symbolic-ref HEAD refs/heads/main',
  'git config user.email t@example.invalid',
  'git config user.name tester',
  "printf 'hello\\n' > a.txt",
  'mkdir src',
  "printf 'const hello = 1\\n' > src/b.ts",
  "printf 'ignored.log\\n' > .gitignore",
  "printf 'hello\\n' > ignored.log",
  'git add -A',
  'git commit -qm init',
  'git remote add origin ../origin.git',
  'git push -q -u origin main'
].join('\n')

describe.skipIf(!READY)('원격 작업 단위 — WSL 의 git 저장소를 SSH(exec·SFTP)로', () => {
  let home = ''
  let harness: Harness | null = null
  let client: Client | null = null

  beforeAll(async () => {
    const mk = WIN ? spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'mktemp', '-d', '-t', 'ara-work-XXXXXX'], { windowsHide: true }) : spawnSync('mktemp', ['-d', '-t', 'ara-work-XXXXXX'])
    home = mk.stdout.toString().trim()
    expect(home).toMatch(/ara-work-/)
    const [f, a] = runner(home, SETUP)
    const setup = spawnSync(f, a, { timeout: 60_000, windowsHide: true })
    expect(setup.status, setup.stderr?.toString()).toBe(0)
    harness = await startPasswordServer({
      sftpRoot: WIN ? `//wsl.localhost/${DISTRO}/` : '/',
      execHandler: (command, stream) => {
        const [file, args] = runner(home, command)
        const child = spawn(file, args, { windowsHide: true })
        child.stdout.on('data', (d: Buffer) => stream.write(d))
        child.stderr.on('data', (d: Buffer) => stream.stderr.write(d))
        stream.on('close', () => void (child.exitCode === null && child.kill()))
        child.stdin.end()
        child.on('close', (code) => {
          try {
            stream.exit(code ?? 1)
            stream.end()
          } catch {
            /* 채널이 이미 닫힘 */
          }
        })
      }
    })
    client = await new Promise<Client>((res, rej) => {
      const c = new Client()
      c.on('ready', () => res(c)).on('error', rej)
      c.connect({ host: '127.0.0.1', port: harness!.port, username: 'tester', password: harness!.password, readyTimeout: 20_000 })
    })
  }, 120_000)

  afterAll(async () => {
    client?.end()
    await harness?.close()
    if (home) {
      if (WIN) spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'rm', '-rf', home], { windowsHide: true })
      else spawnSync('rm', ['-rf', home])
    }
  }, 60_000)

  it('열기·저장·충돌·감시 → 빠른 열기·검색 → 상태·diff → stage·커밋 → 보호 브랜치 막힘 → bare 원격으로 푸시', async () => {
    const c = client!
    const b = remoteBackend(async () => c)
    const root = `${home}/repo`
    const file = `${root}/a.txt`
    const sh = (script: string) => execOn(c, 'sh', ['-c', script], { cwd: root, timeoutMs: 30_000 })

    // 1) 열기 — SFTP 로, 서명(sha1)과 함께.
    const r1 = await b.readCode(file)
    if (!r1.ok) throw new Error(r1.message)
    expect(r1.text).toBe('hello\n')
    expect((await b.readCode(`${root}/nope.txt`)) as { missing?: boolean }).toMatchObject({ ok: false, missing: true })

    // 2) 저장 — 읽은 때의 서명 그대로면 쓴다.
    const w1 = await b.writeCode(file, 'hello\nworld\n', 'lf', r1.sig, false)
    expect(w1.ok).toBe(true)
    expect((await sh('cat a.txt')).stdout).toBe('hello\nworld\n')

    // 3) 밖에서 바뀜 — 감시가 알리고, 옛 서명으로 저장하면 쓰지 않고 충돌.
    let changed = 0
    const stop = b.watch(file, () => changed++)
    await new Promise((r) => setTimeout(r, 1500))
    expect((await sh("printf 'outside change\\n' > a.txt")).code).toBe(0)
    const w2 = await b.writeCode(file, 'mine\n', 'lf', (w1 as { sig: string }).sig, false)
    expect(w2).toEqual({ ok: false, conflict: 'changed' })
    expect((await sh('cat a.txt')).stdout).toBe('outside change\n')
    const until = Date.now() + 15_000
    while (!changed && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
    stop()
    expect(changed).toBeGreaterThan(0)

    // 4) 빠른 열기 — 서버에 rg 가 없으면 git ls-files(무시한 파일은 빠진다). 원격에 rg 를 깔지 않는다.
    const hasRg = (await b.rg()) !== null
    const gitOnly = { ...b, rg: async () => null }
    const list = await listFilesOn(gitOnly, root)
    if (!list.ok) throw new Error(list.message)
    expect([...list.files].sort()).toEqual(['.gitignore', 'a.txt', 'src/b.ts'])
    if (hasRg) expect((await listFilesOn(b, root)).ok).toBe(true)

    // 5) 전체 검색 — git grep(대소문자 무시), include 글롭, 취소.
    const got: SearchFile[] = []
    const s1 = await searchTextOn(gitOnly, root, opts('HELLO'), new AbortController().signal, (f) => got.push(...f))
    expect(s1).toEqual({ ok: true, total: 1, truncated: false, cancelled: false })
    expect(got.map((f) => f.path)).toEqual(['src/b.ts'])
    expect(got[0].matches[0]).toMatchObject({ line: 1, ranges: [[6, 11]] })
    const s2 = await searchTextOn(gitOnly, root, opts('change', { include: '*.txt' }), new AbortController().signal, () => {})
    expect(s2).toMatchObject({ ok: true, total: 1 })
    const ac = new AbortController()
    ac.abort()
    expect(await searchTextOn(gitOnly, root, opts('hello'), ac.signal, () => {})).toMatchObject({ ok: true, cancelled: true })

    // 6) 변경 목록·diff — 서버의 git.
    const st = await readGitStatus(root, b.inspect)
    if (!st.ok) throw new Error(st.message)
    expect(st.branch).toBe('main')
    expect(st.entries.map((e) => `${e.area}:${e.path}`)).toEqual(['unstaged:a.txt'])
    const d = await readFileDiff({ worktreePath: root, filePath: 'a.txt', mode: 'unstaged' }, b.inspect)
    expect(d).toEqual({ ok: true, kind: 'text', original: 'hello\n', modified: 'outside change\n' })

    // 7) stage → 커밋.
    expect((await stagePaths(root, ['a.txt'], b.exec)).ok).toBe(true)
    expect((await commit(root, '원격 커밋', b.exec)).ok).toBe(true)
    expect((await sh('git log -1 --format=%s')).stdout.trim()).toBe('원격 커밋')

    // 8) 보호 브랜치(main) — 확인 전엔 안 민다, 강제 푸시는 막는다(WS-13 그대로).
    expect(await push(root, false, [], b.exec)).toMatchObject({ ok: false, message: 'confirm', need: ['protected'], target: 'origin/main' })
    expect(await push(root, true, [], b.exec)).toEqual({ ok: false, message: 'forceProtected' })
    const before = (await execOn(c, 'git', ['--git-dir', `${home}/origin.git`, 'rev-parse', 'main'])).stdout.trim()
    expect((await sh('git rev-parse origin/main')).stdout.trim()).toBe(before)

    // 9) 작업 브랜치 → bare 원격으로 푸시(처음이면 upstream 설정).
    expect((await sh('git checkout -q -b feature')).code).toBe(0)
    expect(await push(root, false, [], b.exec)).toEqual({ ok: true, message: 'origin/feature' })
    const head = (await sh('git rev-parse HEAD')).stdout.trim()
    expect((await execOn(c, 'git', ['--git-dir', `${home}/origin.git`, 'rev-parse', 'feature'])).stdout.trim()).toBe(head)
    expect((await sh('git rev-parse --abbrev-ref @{u}')).stdout.trim()).toBe('origin/feature')
  }, 180_000)

  // M12 CV-01·02 원격 작업 단위 탐색기 — 터미널 [파일] 탭의 SFTP 조작(SftpService)을 그대로: 목록·새 폴더/파일·끌어 옮기기·이름 바꾸기·영구 삭제·뷰어 바이트.
  it('탐색기 — 목록 → 새 폴더·새 파일 → 옮기기(덮어쓰지 않음) → 이름 바꾸기 → 삭제 → 바이트 읽기(상한)', async () => {
    const c = client!
    const b = remoteBackend(async () => c)
    const root = `${home}/repo`
    const sh = (script: string) => execOn(c, 'sh', ['-c', script], { cwd: root, timeoutMs: 30_000 })
    const ok = (r: { ok: boolean; message?: string }) => expect(r, r.message).toMatchObject({ ok: true })

    const l1 = await b.fs.list(root)
    if (!l1.ok) throw new Error(l1.message)
    expect(l1.entries.find((e) => e.name === 'src')?.type).toBe('dir')
    ok(await b.fs.mkdir(root, 'm12'))
    ok(await b.fs.newFile(`${root}/m12`, 'x.txt'))
    expect(await b.fs.newFile(`${root}/m12`, 'x.txt')).toMatchObject({ ok: false }) // 있는 파일은 안 건드린다
    ok(await b.fs.move([`${root}/m12/x.txt`], `${root}/src`))
    expect((await sh('ls src')).stdout).toContain('x.txt')
    expect(await b.fs.move([`${root}/m12`], `${root}/m12`)).toMatchObject({ ok: false }) // 자기 안으로는 못 옮긴다
    ok(await b.fs.newFile(`${root}/m12`, 'x.txt'))
    expect(await b.fs.move([`${root}/m12/x.txt`], `${root}/src`)).toMatchObject({ ok: false }) // 덮어쓰지 않는다
    ok(await b.fs.rename(`${root}/m12/x.txt`, 'y.txt'))
    ok(await b.fs.remove([`${root}/m12`]))
    expect((await sh('ls')).stdout).not.toContain('m12')
    const bytes = await b.fs.readBytes(`${root}/src/b.ts`, 1024)
    expect(bytes.ok && Buffer.from(bytes.data).toString('utf8')).toBe('const hello = 1\n')
    expect(await b.fs.readBytes(`${root}/src/b.ts`, 3)).toMatchObject({ ok: false, tooBig: true })
    ok(await b.fs.remove([`${root}/src/x.txt`]))
  }, 120_000)
})
