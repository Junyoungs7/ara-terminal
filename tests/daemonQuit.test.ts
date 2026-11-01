// M4 DM-01 — 종료가 데몬을 기다리지 않는다: 붙기(hello)만 하고 그 뒤로 아무 답도 안 하는 가짜 데몬으로.
//  · 완전 종료(shutdownAll)도 상한(6초) 안에 끝난다 — 켤 때 되살리기(list 요청 15초)에 걸려 있어도.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createAgentDaemon } from '../src/main/daemon/service'
import { daemonPaths, encodeFrame, DAEMON_PROTOCOL_VERSION } from '../src/main/daemon/protocol'

const dir = mkdtempSync(join(tmpdir(), 'ara-daemon-quit-'))
const servers: Server[] = []
afterAll(() => {
  for (const s of servers) s.close()
  rmSync(dir, { recursive: true, force: true })
})

/** hello 에만 답하고 나머지(list·shutdown…)는 삼키는 데몬. */
async function muteDaemon(runtimeDir: string): Promise<void> {
  const { socketPath, tokenPath } = daemonPaths(runtimeDir)
  mkdirSync(runtimeDir, { recursive: true })
  writeFileSync(tokenPath, 'tok')
  const srv = createServer((sock) => {
    sock.once('data', () => sock.write(encodeFrame({ type: 'hello', ok: true, protocol: DAEMON_PROTOCOL_VERSION, pid: 1 })))
  })
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(socketPath, r))
}

const svc = (runtimeDir: string) =>
  createAgentDaemon({
    runtimeDir,
    logFile: () => join(runtimeDir, 'daemon.log'),
    appVersion: 'test',
    runtime: async () => {
      throw new Error('띄우지 않는다')
    },
    adopt: () => {},
    restored: () => {},
    log: () => {}
  })

describe('종료가 무응답 데몬에 막히지 않는다', () => {
  it('완전 종료는 상한 안에 끝난다(켤 때 되살리기가 걸려 있어도)', async () => {
    const rt = join(dir, 'a')
    await muteDaemon(rt)
    const d = svc(rt)
    const t0 = Date.now()
    await d.shutdownAll()
    expect(Date.now() - t0).toBeLessThan(8_000) // 고치기 전: ready 의 list 요청 15초 + 6초
  }, 30_000)
})
