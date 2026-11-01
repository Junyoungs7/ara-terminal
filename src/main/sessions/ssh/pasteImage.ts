// M8 herdr H10 — 클립보드 이미지를 이 연결의 SFTP 로 원격 임시 폴더에 올린다(서버에 아무것도 설치하지 않는다).
// 규칙(경로·상한·청소 기준)은 shared/pasteImage.ts. 세션 종료 시 지우기는 SshBackend.kill 이 removeRemoteFiles 로 한다.
import { randomBytes } from 'node:crypto'
import type { Client, SFTPWrapper } from 'ssh2'
import { PASTE_DIR, PASTE_IMAGE_MAX_BYTES, remotePastePath, stalePasteNames } from '@shared/pasteImage'

export type PasteResult = { ok: true; path: string } | { ok: false; message: string }

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    try {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    } catch (err) {
      reject(err as Error) // 끊긴 커넥션은 콜백 대신 동기로 던진다
    }
  })
}

const call = <T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))))

export async function uploadPasteImage(client: Client, bytes: Buffer, mime: string, now = new Date()): Promise<PasteResult> {
  if (bytes.length === 0) return { ok: false, message: '이미지가 비어 있습니다.' }
  if (bytes.length > PASTE_IMAGE_MAX_BYTES) return { ok: false, message: '이미지가 너무 큽니다(10MB 까지).' }
  let sftp: SFTPWrapper
  try {
    sftp = await openSftp(client)
  } catch (err) {
    return { ok: false, message: `SFTP 를 열 수 없습니다: ${(err as Error).message}` }
  }
  try {
    const home = await call<string>((cb) => sftp.realpath('.', cb))
    const path = remotePastePath(home, mime, now, randomBytes(2).toString('hex'))
    if (!path) return { ok: false, message: `지원하지 않는 이미지 형식입니다: ${mime}` }
    const dir = path.slice(0, path.lastIndexOf('/'))
    // 이미 있으면 실패한다 — 그건 괜찮다. 진짜 문제(권한 등)는 아래 writeFile 이 말한다.
    await call<void>((cb) => sftp.mkdir(dir, { mode: 0o700 }, (e) => cb(e, undefined))).catch(() => {})
    // ponytail: 끊겨서 못 지운 것은 여기서만 걷는다(다음 붙여넣기 때). 원격 타이머·데몬을 두지 않는다.
    const list = await call<{ filename: string; attrs: { mtime: number } }[]>((cb) => sftp.readdir(dir, cb)).catch(() => [])
    for (const name of stalePasteNames(list.map((e) => ({ filename: e.filename, mtime: e.attrs.mtime })), now.getTime())) {
      await call<void>((cb) => sftp.unlink(`${dir}/${name}`, (e) => cb(e, undefined))).catch(() => {})
    }
    await call<void>((cb) => sftp.writeFile(path, bytes, { mode: 0o600 }, (e) => cb(e, undefined)))
    return { ok: true, path }
  } catch (err) {
    return { ok: false, message: `원격에 올리지 못했습니다: ${(err as Error).message}` }
  } finally {
    sftp.end()
  }
}

/** 세션이 끝날 때 이 세션이 올린 파일을 지운다. 폴더가 비면 폴더도. 실패는 삼킨다(다음 업로드의 청소가 받는다). */
export async function removeRemoteFiles(client: Client, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  let sftp: SFTPWrapper
  try {
    sftp = await openSftp(client)
  } catch {
    return
  }
  try {
    for (const p of paths) await call<void>((cb) => sftp.unlink(p, (e) => cb(e, undefined))).catch(() => {})
    const dir = paths[0].slice(0, paths[0].lastIndexOf('/'))
    if (dir.endsWith('/' + PASTE_DIR)) await call<void>((cb) => sftp.rmdir(dir, (e) => cb(e, undefined))).catch(() => {})
  } finally {
    sftp.end()
  }
}
