// M3 라운드 2 S2(제거 A2) — 원격 상태 훅 **정리만** 하는 판. 2.6 까지는 SSH 가 붙을 때마다 원격 `~/.claude/settings.json` 에
// 아라 훅(`# ara-agent-hook`)을 병합하고 `~/.claude/ara-tty-*` 파일을 남겼다(동의 없이 고친 서버 파일). 이 판은 접속할 때
// 그 둘을 지우기만 하고 아무것도 심지 않는다. 다음 판(M4)에서 이 파일째 지운다 — 원격 에이전트 상태는 DM-02 orcad 가 맡는다.
//
// 규율: 접속을 기다리게 하지 않는다(셸이 뜬 뒤 뒤에서 돈다) · 아무것도 던지지 않는다 · `~/.claude` 가 없으면 아무것도 안 한다 ·
// 표식이 없으면 쓰지 않는다 · 깨진 JSON 은 손대지 않는다 · 고치기 전 `settings.json.bak` 을 남긴다.
import { posix } from 'node:path'
import type { Client, SFTPWrapper } from 'ssh2'
import { LEGACY_HOOK_MARK, removeLegacyHooks } from '@shared/agentHooks'

const SETTINGS_MAX_BYTES = 1024 * 1024
const TTY_PREFIX = 'ara-tty-'

export async function cleanupRemoteLegacyHooks(client: Client): Promise<{ settings: boolean; ttyFiles: number }> {
  const out = { settings: false, ttyFiles: 0 }
  let sftp: SFTPWrapper | null = null
  try {
    sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((err, s) => (err ? reject(err) : resolve(s))))
    const s = sftp
    const home = await new Promise<string>((r) => s.realpath('.', (err, p) => r(err ? '' : p)))
    if (!home) return out
    const dir = posix.join(home, '.claude')
    const names = await new Promise<string[] | null>((r) => s.readdir(dir, (err, list) => r(err ? null : list.map((x) => x.filename))))
    if (!names) return out // ~/.claude 가 없다 = 우리가 심은 적 없는 서버
    for (const name of names.filter((n) => n.startsWith(TTY_PREFIX) && !n.includes('/'))) {
      if (await new Promise<boolean>((r) => s.unlink(posix.join(dir, name), (err) => r(!err)))) out.ttyFiles++
    }
    const path = posix.join(dir, 'settings.json')
    const size = await new Promise<number>((r) => s.stat(path, (err, st) => r(err ? -1 : st.size)))
    if (size < 0 || size > SETTINGS_MAX_BYTES) return out
    const text = await new Promise<string | null>((r) => s.readFile(path, (err, buf) => r(err ? null : buf.toString('utf8'))))
    if (text === null || !text.includes(LEGACY_HOOK_MARK)) return out
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return out
    }
    const next = removeLegacyHooks(parsed)
    if (!next) return out
    const write = (p: string, body: string): Promise<boolean> => new Promise((r) => s.writeFile(p, Buffer.from(body, 'utf8'), (err) => r(!err)))
    if (!(await write(`${path}.bak`, text))) return out
    out.settings = await write(path, JSON.stringify(next, null, 2))
    return out
  } catch {
    return out
  } finally {
    sftp?.end()
  }
}
