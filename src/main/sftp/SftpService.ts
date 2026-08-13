// SftpService — 활성 SSH 세션의 ssh2 커넥션에서 sftp 서브시스템을 재사용한다(새 연결 금지, §C.0).
// 계획서 §C F7: 디렉토리 리스팅(폴더 우선) / 스트림 업·다운로드(진행률·백프레셔) / 취소 + 부분 파일 정리(C-4).
// 실패는 예외 대신 구조화 결과로 반환 → 트리 영역에 표시(앱 크래시 금지).
import { createReadStream, createWriteStream } from 'node:fs'
import { unlink, stat as fsStat } from 'node:fs/promises'
import { basename, posix } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { Client, SFTPWrapper, Stats } from 'ssh2'
import type {
  EditorReadResult,
  SessionLogReadResult,
  FileEntry,
  FileListResult,
  FileOpResult,
  SftpProgress,
  SftpXferResult
} from '@shared/ipc'
import { friendly } from '../util/fsError'
import { invalidName } from '../fs/LocalFs'
import { readRemoteText, writeRemoteText } from '../editor/textIO'
import { shQuote } from '../telemetry/LogTail'

// 진행 이벤트 싱크(IPC 레이어가 주입 — 서비스는 IPC를 모른다).
export type ProgressSink = (p: SftpProgress) => void

// 한 디렉토리에서 종류를 해석할 심볼릭 링크 수 상한(넘으면 링크 표시만 하고 해석은 건너뛴다).
const LINK_RESOLVE_LIMIT = 200

// 로그 뷰어가 한 번에 거슬러 올라가는 크기(로그 패널의 LOG_CHUNK 와 같게 — 체감을 맞춘다).
const LOG_WINDOW = 256 * 1024

// 진행 중 전송 1건. cancel() 로 스트림을 파괴하고 부분 파일 정리 대상 경로를 남긴다.
type Transfer = {
  abort: () => void
  canceled: boolean
}

export class SftpService {
  // transferId → 진행 중 전송. 취소 시 조회.
  private readonly transfers = new Map<string, Transfer>()

  // getClient: 세션 id → ssh2 Client(없으면 null). MainSessionManager.sshClient 를 주입.
  constructor(
    private readonly getClient: (sessionId: string) => Client | null,
    private readonly progress: ProgressSink
  ) {}

  // 세션의 sftp 서브시스템을 연다(커넥션 재사용). 매 요청마다 새 sftp 채널을 열고 요청 후 닫는다
  // — ssh2 sftp 채널은 경량이고 동시 전송 격리에 유리. 연결 없으면 에러 문자열.
  private sftp(sessionId: string): Promise<SFTPWrapper> {
    const client = this.getClient(sessionId)
    if (!client) return Promise.reject(new Error('SFTP는 SSH 세션에서만 사용할 수 있습니다.'))
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    })
  }

  // 디렉토리 리스팅. 폴더 우선 + 이름 오름차순. 숨김파일 포함(원격 셸과 동일 관점).
  async list(sessionId: string, path: string): Promise<FileListResult> {
    let sftp: SFTPWrapper
    try {
      sftp = await this.sftp(sessionId)
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
    try {
      // 절대 경로로 정규화('.'·상대경로 → 실제 경로). 브레드크럼·cd 전송이 절대경로여야 정확.
      const abs = await new Promise<string>((resolve) => {
        sftp.realpath(path, (err, p) => resolve(err ? path : p))
      })
      const raw = await new Promise<{ filename: string; attrs: Stats }[]>((resolve, reject) => {
        sftp.readdir(abs, (err, l) => (err ? reject(err) : resolve(l)))
      })
      // readdir 이 주는 attrs 는 lstat 이다 — 링크는 대상이 폴더여도 파일로 보인다(준영님 제보).
      // 링크만 골라 stat(링크를 따라감)으로 실제 종류를 채운다.
      const entries: FileEntry[] = raw.map((r) => {
        const link = r.attrs.isSymbolicLink()
        const isDir = r.attrs.isDirectory()
        return {
          name: r.filename,
          type: (isDir ? 'dir' : 'file') as 'dir' | 'file',
          size: isDir ? 0 : r.attrs.size,
          mtime: (r.attrs.mtime ?? 0) * 1000,
          ...(link ? { link } : {})
        }
      })
      await this.resolveLinks(sftp, abs, entries)
      // 폴더 우선, 그다음 이름(로케일 정렬 — 한글 파일명 자연 정렬).
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, 'ko')
      })
      return { ok: true, path: abs, parent: posix.dirname(abs), entries }
    } catch (e) {
      // 권한 거부/경로 없음 등 → 구조화 메시지(트리 영역 표시).
      return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
    } finally {
      sftp.end()
    }
  }

  // 링크 항목의 실제 종류를 stat(링크 추종)으로 채운다. 실패 = 끊긴 링크(또는 권한 부족).
  // ponytail: 링크가 아주 많은 디렉토리(/usr/bin 류)에서 왕복이 늘어난다 — 상한을 두고, 넘으면
  // 링크 표시만 하고 종류 해석은 포기한다(목록이 느려지는 것보다 낫다).
  private async resolveLinks(sftp: SFTPWrapper, dir: string, entries: FileEntry[]): Promise<void> {
    const links = entries.filter((e) => e.link)
    if (links.length === 0 || links.length > LINK_RESOLVE_LIMIT) return
    await Promise.all(
      links.map(
        (e) =>
          new Promise<void>((resolve) => {
            sftp.stat(posix.join(dir, e.name), (err, st) => {
              if (err || !st) e.broken = true
              else if (st.isDirectory()) {
                e.type = 'dir'
                e.size = 0
              } else e.size = st.size
              resolve()
            })
          })
      )
    )
  }

  // 같은 서버 안에서의 복사. SFTP 에는 서버측 copy op 가 아예 없어서(스펙에 없다) 여기만 exec 을 쓴다.
  // 대안은 내려받았다 다시 올리기인데, 같은 디스크 안 복사에 네트워크를 두 번 태우는 건 말이 안 된다.
  //
  // 안전: 경로는 사용자가 트리에서 고른 것이지만 셸에 넘어가므로 전부 작은따옴표로 감싼다(shQuote).
  // 명령은 `cp -a -- <src…> <destDir>/` 하나로 고정 — 사용자 입력이 옵션 자리에 오지 못한다(`--`).
  copyRemote(sessionId: string, paths: string[], destDir: string): Promise<FileOpResult> {
    const client = this.getClient(sessionId)
    if (!client) return Promise.resolve({ ok: false, message: 'SFTP는 SSH 세션에서만 사용할 수 있습니다.' })
    if (paths.length === 0) return Promise.resolve({ ok: false, message: '복사할 항목이 없습니다.' })
    const cmd = `cp -a -- ${paths.map(shQuote).join(' ')} ${shQuote(destDir.endsWith('/') ? destDir : destDir + '/')}`
    return new Promise((resolve) => {
      client.exec(cmd, (err, stream) => {
        if (err || !stream) return resolve({ ok: false, message: err?.message ?? '명령을 실행하지 못했습니다.' })
        let errOut = ''
        stream.stderr.on('data', (d: Buffer) => {
          errOut += d.toString('utf8')
        })
        stream.resume() // stdout 은 안 읽으면 채널이 안 닫힌다(cp 는 조용하지만 규칙은 지킨다)
        stream.on('close', (code: number) =>
          resolve(code === 0 ? { ok: true } : { ok: false, message: errOut.trim() || `cp 가 ${code} 로 끝났습니다.` })
        )
      })
    })
  }

  // 로그 뷰어 [이전 불러오기] — 파일 **뒤에서부터** 창 단위로 읽는다(로그 패널의 readFileWindow 와
  // 같은 규칙: 줄 경계로 당겨 자르고, start=0 이면 앞이 더 없다). tail 로는 과거를 볼 수 없어서 필요하다.
  async readWindow(sessionId: string, path: string, before?: number): Promise<SessionLogReadResult> {
    let sftp: SFTPWrapper
    try {
      sftp = await this.sftp(sessionId)
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
    try {
      const size = await new Promise<number>((resolve, reject) =>
        sftp.stat(path, (err, st) => (err ? reject(err) : resolve(st.size)))
      )
      const end = Math.max(0, Math.min(before ?? size, size))
      const from = Math.max(0, end - LOG_WINDOW)
      if (end === from) return { ok: true, text: '', source: 'file', start: 0, size }
      const buf = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        const rs = sftp.createReadStream(path, { start: from, end: end - 1 })
        rs.on('data', (c: Buffer) => chunks.push(c))
        rs.on('error', reject)
        rs.on('end', () => resolve(Buffer.concat(chunks)))
      })
      let text = buf.toString('utf8')
      let start = from
      // 앞을 잘랐으면 첫 줄은 반 토막이다 — 개행까지 버린다(멀티바이트 글자 깨짐도 같이 사라진다).
      if (from > 0) {
        const nl = text.indexOf('\n')
        if (nl >= 0) {
          start = from + Buffer.byteLength(text.slice(0, nl + 1), 'utf8')
          text = text.slice(nl + 1)
        }
      }
      return { ok: true, text, source: 'file', start, size }
    } catch (e) {
      return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
    } finally {
      sftp.end()
    }
  }

  // 편집기 창(노트)용 읽기·쓰기. 규칙(크기 상한·바이너리 거부·줄바꿈 보존)은 로컬과 공유한다.
  async readText(sessionId: string, path: string): Promise<EditorReadResult> {
    let sftp: SFTPWrapper
    try {
      sftp = await this.sftp(sessionId)
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
    try {
      return await readRemoteText(sftp, path)
    } finally {
      sftp.end()
    }
  }

  writeText(sessionId: string, path: string, text: string, eol: 'lf' | 'crlf'): Promise<FileOpResult> {
    return this.withSftp(sessionId, (sftp) => writeRemoteText(sftp, path, text, eol))
  }

  // ── R7 원격 파일 조작 (로컬 fs 와 같은 계약) ──
  // 이름 변경. 새 이름 검증은 로컬과 같은 규칙(경로 구분자 금지 = 디렉토리 탈출 금지).
  async rename(sessionId: string, path: string, name: string): Promise<FileOpResult> {
    const bad = invalidName(name)
    if (bad) return { ok: false, message: bad }
    return this.withSftp(sessionId, (sftp) =>
      sftpOp((cb) => sftp.rename(path, posix.join(posix.dirname(path), name.trim()), cb))
    )
  }

  async mkdir(sessionId: string, dir: string, name: string): Promise<FileOpResult> {
    const bad = invalidName(name)
    if (bad) return { ok: false, message: bad }
    return this.withSftp(sessionId, (sftp) => sftpOp((cb) => sftp.mkdir(posix.join(dir, name.trim()), cb)))
  }

  // 삭제. SFTP 에는 재귀 삭제 op 가 없어 직접 내려가며 unlink → rmdir 한다.
  // opId 로 취소 가능(sftp:cancel 재사용) — 큰 트리를 지우다 멈출 수 있어야 한다.
  async remove(sessionId: string, opId: string, paths: string[]): Promise<FileOpResult> {
    const rec: Transfer = { canceled: false, abort: () => {} }
    this.transfers.set(opId, rec)
    try {
      return await this.withSftp(sessionId, async (sftp) => {
        for (const p of paths) {
          const r = await this.removeOne(sftp, p, rec)
          if (!r.ok) return r
        }
        return { ok: true as const }
      })
    } finally {
      this.transfers.delete(opId)
    }
  }

  // 한 항목 삭제(폴더면 자식부터). 항목 하나 처리할 때마다 취소를 확인한다.
  private async removeOne(sftp: SFTPWrapper, path: string, rec: Transfer): Promise<FileOpResult> {
    if (rec.canceled) return { ok: false, message: '삭제가 취소되었습니다.', canceled: true }
    let isDir = false
    try {
      const st = await new Promise<Stats>((resolve, reject) =>
        sftp.lstat(path, (err, s) => (err ? reject(err) : resolve(s)))
      )
      isDir = st.isDirectory()
    } catch (e) {
      return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
    }
    if (!isDir) return sftpOp((cb) => sftp.unlink(path, cb))
    let children: { filename: string }[]
    try {
      children = await new Promise<{ filename: string }[]>((resolve, reject) =>
        sftp.readdir(path, (err, l) => (err ? reject(err) : resolve(l)))
      )
    } catch (e) {
      return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
    }
    for (const c of children) {
      const r = await this.removeOne(sftp, posix.join(path, c.filename), rec)
      if (!r.ok) return r
    }
    if (rec.canceled) return { ok: false, message: '삭제가 취소되었습니다.', canceled: true }
    return sftpOp((cb) => sftp.rmdir(path, cb))
  }

  // sftp 채널을 열어 fn 을 돌리고 반드시 닫는다(조작 계열 공통 — 채널 누수 금지).
  private async withSftp(
    sessionId: string,
    fn: (sftp: SFTPWrapper) => Promise<FileOpResult>
  ): Promise<FileOpResult> {
    let sftp: SFTPWrapper
    try {
      sftp = await this.sftp(sessionId)
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
    try {
      return await fn(sftp)
    } catch (e) {
      return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
    } finally {
      sftp.end()
    }
  }

  // 다운로드: 원격 remotePath → 로컬 localPath. 스트림 청크 + 진행률. 취소/실패 시 부분 파일 삭제(C-4).
  async download(
    sessionId: string,
    transferId: string,
    remotePath: string,
    localPath: string,
    total: number
  ): Promise<SftpXferResult> {
    let sftp: SFTPWrapper
    try {
      sftp = await this.sftp(sessionId)
    } catch (e) {
      return { ok: false, canceled: false, message: (e as Error).message, cleaned: false }
    }
    const read = sftp.createReadStream(remotePath)
    const write = createWriteStream(localPath)
    return this.pump(transferId, read, write, total, () => sftp.end(), localPath, unlinkLocal)
  }

  // 업로드: 로컬 localPath → 원격 remoteDir/<파일명>. 취소/실패 시 원격 불완전 파일 삭제 시도(C-4).
  async upload(
    sessionId: string,
    transferId: string,
    localPath: string,
    remoteDir: string
  ): Promise<SftpXferResult> {
    let sftp: SFTPWrapper
    let total = 0
    try {
      sftp = await this.sftp(sessionId)
      total = (await fsStat(localPath)).size
    } catch (e) {
      return { ok: false, canceled: false, message: (e as Error).message, cleaned: false }
    }
    const remotePath = posix.join(remoteDir, basename(localPath))
    const read = createReadStream(localPath)
    const write = sftp.createWriteStream(remotePath)
    const cleanupRemote = () =>
      new Promise<boolean>((resolve) => sftp.unlink(remotePath, (err) => resolve(!err)))
    return this.pump(transferId, read, write, total, () => sftp.end(), remotePath, cleanupRemote)
  }

  // 서버 A → 서버 B. SFTP 에는 서버 간 전송 op 가 없어 데이터는 어차피 우리를 거치지만,
  // **디스크에 임시 파일을 만들 필요는 없다** — A 의 읽기 스트림을 B 의 쓰기 스트림에 그대로 잇는다
  // (두 커넥션 모두 main 이 들고 있다). 임시 파일 경유였다면 20GB 파일에 20GB 디스크가 필요했다.
  // 폴더는 대상이 아니다 — 업로드·다운로드와 같은 규칙(호출측이 파일만 넘긴다).
  async copyBetween(
    srcSessionId: string,
    destSessionId: string,
    transferId: string,
    remotePath: string,
    destDir: string,
    total: number
  ): Promise<SftpXferResult> {
    if (srcSessionId === destSessionId) {
      // 같은 서버는 exec `cp` 가 훨씬 싸다(네트워크를 안 탄다) — 호출측이 그리로 가야 한다.
      return { ok: false, canceled: false, message: '같은 서버 안의 복사는 copyRemote 를 씁니다.', cleaned: false }
    }
    let src: SFTPWrapper
    let dest: SFTPWrapper
    try {
      src = await this.sftp(srcSessionId)
    } catch (e) {
      return { ok: false, canceled: false, message: (e as Error).message, cleaned: false }
    }
    try {
      dest = await this.sftp(destSessionId)
    } catch (e) {
      src.end()
      return { ok: false, canceled: false, message: (e as Error).message, cleaned: false }
    }
    const destPath = posix.join(destDir, basename(remotePath))
    const closeBoth = (): void => {
      src.end()
      dest.end()
    }
    // 실패·취소 시 목적지의 반쪽 파일을 지운다(업로드와 같은 규칙) — 출발지는 건드리지 않는다.
    const cleanupDest = (): Promise<boolean> =>
      new Promise((resolve) => dest.unlink(destPath, (err) => resolve(!err)))
    return this.pump(
      transferId,
      src.createReadStream(remotePath),
      dest.createWriteStream(destPath),
      total,
      closeBoth,
      destPath,
      cleanupDest
    )
  }

  // 진행 중 전송 취소. abort → pump 가 partial cleanup 후 canceled 결과를 반환.
  cancel(transferId: string): void {
    const t = this.transfers.get(transferId)
    if (t) {
      t.canceled = true
      t.abort()
    }
  }

  // 스트림 펌프(다운로드/업로드 공통): 진행률 방출 + 취소·오류 시 부분 파일 정리.
  // cleanup 은 정리 대상(로컬 또는 원격)을 삭제하고 성공 여부를 반환한다.
  private pump(
    transferId: string,
    read: Readable,
    write: Writable,
    total: number,
    endSftp: () => void,
    cleanupPath: string,
    cleanup: (p: string) => Promise<boolean>
  ): Promise<SftpXferResult> {
    return new Promise<SftpXferResult>((resolve) => {
      let transferred = 0
      let settled = false
      const rec: Transfer = {
        canceled: false,
        abort: () => {
          // 스트림 파괴 후 즉시 finish() 로 정리 확정(canceled=true → 부분 파일 삭제).
          // ssh2 WriteStream 은 destroy 시 이벤트를 신뢰할 수 없어 이벤트 대기 대신 직접 확정한다.
          read.destroy()
          write.destroy()
          void finish(null)
        }
      }
      this.transfers.set(transferId, rec)

      const finish = async (err: Error | null) => {
        if (settled) return
        settled = true
        this.transfers.delete(transferId)
        if (!err && !rec.canceled) {
          endSftp()
          resolve({ ok: true })
          return
        }
        // 취소 또는 오류 → 부분 파일 정리(C-4, 축소 불가).
        // 원격 정리(업로드)는 sftp 채널이 살아 있어야 하므로 cleanup 후 채널을 닫는다.
        // 응답 없는 서버가 정리 대기로 UI를 붙잡지 않도록 5초 타임아웃(정리 실패로 처리).
        const cleaned = await Promise.race([
          cleanup(cleanupPath).catch(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(false), 5000))
        ])
        endSftp()
        resolve({
          ok: false,
          canceled: rec.canceled,
          message: rec.canceled ? '전송이 취소되었습니다.' : friendly(err as NodeJS.ErrnoException),
          cleaned
        })
      }

      // 출발지 소진 → 목적지 닫기. 여러 신호가 겹쳐 와도 한 번만 돈다.
      let drained = false
      const sourceDone = (): void => {
        if (drained || settled) return
        drained = true
        try {
          write.end(() => void finish(null))
        } catch (e) {
          void finish(e as Error)
        }
      }

      read.on('data', (chunk: Buffer) => {
        transferred += chunk.length
        this.progress({ transferId, transferred, total })
        // 마지막 바이트까지 읽었으면 출발지 종료를 예약한다. ssh2 SFTP ReadStream 이 'end'/'close'
        // 없이 조용히 멈추는 경우가 있어(서버 A→B 복사에서 실측: 파일은 다 갔는데 큐가 100% 에서
        // 굳었다) 바이트 수를 최후의 신호로 쓴다. setImmediate 인 이유: 이 핸들러가 pipe 의 write
        // 보다 먼저 돌기 때문에 지금 끝내면 마지막 청크를 잃는다 — 한 틱 뒤로 미룬다.
        if (total > 0 && transferred >= total) setImmediate(() => sourceDone())
      })
      read.on('error', (e) => void finish(e))
      write.on('error', (e) => void finish(e))
      // 완료 판정: 다운로드(로컬 fs WriteStream)는 'finish', 업로드·서버간복사(ssh2 WriteStream)는
      // 마지막 WRITE ack 후 write.end() 콜백으로 확정한다. ssh2 WriteStream 은 emitClose:false 라
      // 'finish'/'close' 가 신뢰되지 않으므로 end() 콜백으로 플러시 완료를 잡는다.
      // 출발지 소진 신호는 셋 중 먼저 오는 것: 'end' · 'close' · 바이트 수 도달(위 'data' 참고).
      write.on('finish', () => void finish(null))
      read.on('end', sourceDone)
      read.on('close', sourceDone)
      read.pipe(write, { end: false })
    })
  }
}

// 로컬 부분 파일 삭제(다운로드 취소·실패용).
async function unlinkLocal(p: string): Promise<boolean> {
  return unlink(p).then(
    () => true,
    () => false
  )
}

// ssh2 콜백 op(rename/mkdir/unlink/rmdir) → 구조화 결과. 오류는 한국어 메시지로.
function sftpOp(run: (cb: (err?: Error | null) => void) => void): Promise<FileOpResult> {
  return new Promise((resolve) =>
    run((err) => resolve(err ? { ok: false, message: friendly(err as NodeJS.ErrnoException) } : { ok: true }))
  )
}
