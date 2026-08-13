// SFTP 서버 하네스 — ssh2 Server 의 sftp 서브시스템을 임시 디렉토리에 매핑한다(테스트 전용).
// 앱의 SftpService(list/download/upload/취소)를 실제 SFTP 프로토콜로 실증하기 위한 최소 서버.
// 지원 op: REALPATH / OPENDIR·READDIR / STAT·LSTAT·FSTAT / OPEN(r,w)·READ·WRITE·CLOSE.
import {
  openSync,
  readSync,
  writeSync,
  closeSync,
  readdirSync,
  statSync,
  lstatSync,
  fstatSync,
  unlinkSync,
  renameSync,
  mkdirSync,
  rmdirSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { utils } from 'ssh2'

const { OPEN_MODE, STATUS_CODE, flagsToString } = utils.sftp

// 문자열 핸들 ↔ 상태. dir 핸들은 항목 목록을 1회 방출 후 EOF.
type FileHandle = { type: 'file'; fd: number }
type DirHandle = { type: 'dir'; path: string; sent: boolean }

// serveSftp: accept 로 얻은 sftp 스트림에 op 핸들러를 배선. root 밖 접근은 차단(권한 거부 시뮬레이션 아님, 안전).
export function serveSftp(sftp: any, root: string): void {
  const handles = new Map<number, FileHandle | DirHandle>()
  let seq = 0
  const makeHandle = (h: FileHandle | DirHandle): Buffer => {
    const id = ++seq
    handles.set(id, h)
    const b = Buffer.alloc(4)
    b.writeUInt32BE(id, 0)
    return b
  }
  const getHandle = (h: Buffer) => handles.get(h.readUInt32BE(0))

  // 원격 경로 → 실제 파일시스템 경로. 원격 FS 루트('/')=root. 원격의 절대/상대 모두 root 기준으로 매핑한다
  // (posix '/foo' 를 OS 절대경로로 오해하지 않도록 선행 슬래시를 벗겨 root 하위로 붙인다).
  const real = (p: string): string => {
    const rel = p === '.' || p === '' ? '' : p.replace(/^\/+/, '')
    const r = resolve(join(root, rel))
    // root 밖으로 나가면(.. 등) root 로 클램프(테스트 안전).
    return r.startsWith(resolve(root)) ? r : root
  }
  // 실제 경로 → 원격 표기(root 를 '/' 로). 앱이 절대경로 브레드크럼을 받도록.
  const remote = (p: string): string => {
    const rel = resolve(p).slice(resolve(root).length).replace(/\\/g, '/')
    return rel === '' ? '/' : rel
  }

  const attrsOf = (p: string, noFollow = false) => {
    const s = noFollow ? lstatSync(p) : statSync(p)
    return { mode: s.mode, size: s.size, uid: 0, gid: 0, atime: (s.atimeMs / 1000) | 0, mtime: (s.mtimeMs / 1000) | 0 }
  }

  sftp.on('REALPATH', (reqid: number, p: string) => {
    try {
      const rp = real(p)
      statSync(rp)
      sftp.name(reqid, [{ filename: remote(rp), longname: remote(rp), attrs: attrsOf(rp) }])
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
    }
  })

  sftp.on('OPENDIR', (reqid: number, p: string) => {
    try {
      const rp = real(p)
      statSync(rp)
      sftp.handle(reqid, makeHandle({ type: 'dir', path: rp, sent: false }))
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
    }
  })

  sftp.on('READDIR', (reqid: number, h: Buffer) => {
    const handle = getHandle(h)
    if (!handle || handle.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
    if (handle.sent) return sftp.status(reqid, STATUS_CODE.EOF)
    handle.sent = true
    try {
      // 실제 sftp-server 와 같이 **lstat** 으로 답한다 — 심볼릭 링크는 대상이 아니라 링크 자체로
      // 보고돼야 한다(앱이 그걸 보고 링크를 가려낸다). stat 으로 답하면 링크가 사라져 버린다.
      const names = readdirSync(handle.path).map((name) => {
        const full = join(handle.path, name)
        return { filename: name, longname: name, attrs: attrsOf(full, true) }
      })
      sftp.name(reqid, names)
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
    }
  })

  const doStat = (reqid: number, p: string) => {
    try {
      sftp.attrs(reqid, attrsOf(real(p)))
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
    }
  }
  sftp.on('STAT', doStat)
  sftp.on('LSTAT', doStat)
  // ssh2 createReadStream 은 열린 핸들의 크기를 FSTAT 로 얻는다(EOF 판단). fd 로 attrs 반환.
  sftp.on('FSTAT', (reqid: number, h: Buffer) => {
    const handle = getHandle(h)
    if (!handle || handle.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
    try {
      const s = fstatSync(handle.fd)
      sftp.attrs(reqid, {
        mode: s.mode,
        size: s.size,
        uid: 0,
        gid: 0,
        atime: (s.atimeMs / 1000) | 0,
        mtime: (s.mtimeMs / 1000) | 0
      })
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
    }
  })

  sftp.on('OPEN', (reqid: number, filename: string, flags: number) => {
    const rp = real(filename)
    const mode = flagsToString(flags) || (flags & OPEN_MODE.WRITE ? 'w' : 'r')
    try {
      const fd = openSync(rp, mode)
      sftp.handle(reqid, makeHandle({ type: 'file', fd }))
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
    }
  })

  sftp.on('READ', (reqid: number, h: Buffer, offset: number, len: number) => {
    const handle = getHandle(h)
    if (!handle || handle.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
    const buf = Buffer.alloc(len)
    let n = 0
    try {
      n = readSync(handle.fd, buf, 0, len, offset)
    } catch {
      return sftp.status(reqid, STATUS_CODE.FAILURE)
    }
    if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF)
    sftp.data(reqid, buf.subarray(0, n))
  })

  sftp.on('WRITE', (reqid: number, h: Buffer, offset: number, data: Buffer) => {
    const handle = getHandle(h)
    if (!handle || handle.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
    try {
      writeSync(handle.fd, data, 0, data.length, offset)
      sftp.status(reqid, STATUS_CODE.OK)
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
    }
  })

  // 원격 파일 삭제(업로드 취소 시 부분 파일 정리용, C-4).
  sftp.on('REMOVE', (reqid: number, p: string) => {
    try {
      unlinkSync(real(p))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
    }
  })

  // R7 파일 조작: 이름 변경 / 새 폴더 / 폴더 삭제(재귀는 앱이 직접 내려온다 — 서버는 빈 폴더만 지운다).
  // readonly 로 표시된 경로는 권한 거부를 흉내 낸다(실패 케이스 어서션용).
  const denied = (p: string) => /(^|[\\/])readonly([\\/]|$)/.test(p)
  sftp.on('RENAME', (reqid: number, from: string, to: string) => {
    if (denied(from) || denied(to)) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED)
    try {
      renameSync(real(from), real(to))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
    }
  })
  sftp.on('MKDIR', (reqid: number, p: string) => {
    if (denied(p)) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED)
    try {
      mkdirSync(real(p))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
    }
  })
  sftp.on('RMDIR', (reqid: number, p: string) => {
    if (denied(p)) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED)
    try {
      rmdirSync(real(p))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
    }
  })

  sftp.on('CLOSE', (reqid: number, h: Buffer) => {
    const id = h.readUInt32BE(0)
    const handle = handles.get(id)
    if (handle?.type === 'file') {
      try {
        closeSync(handle.fd)
      } catch {
        /* already closed */
      }
    }
    handles.delete(id)
    sftp.status(reqid, STATUS_CODE.OK)
  })
}
