// fs/ssh2 오류 → 사용자용 한국어 메시지. 로컬 파일시스템(LocalFs)과 원격 SFTP(SftpService)가
// 같은 문구를 쓴다 — 사용자 입장에서 "권한 거부"는 로컬이든 원격이든 같은 사건이다.
export function friendly(e: NodeJS.ErrnoException): string {
  const msg = e?.message ?? '알 수 없는 오류'
  const code = e?.code
  if (/permission denied/i.test(msg) || code === 'EACCES' || code === 'EPERM') return '권한이 거부되었습니다.'
  if (/no such file/i.test(msg) || code === 'ENOENT') return '경로를 찾을 수 없습니다.'
  if (code === 'EEXIST') return '같은 이름이 이미 있습니다.'
  if (code === 'ENOTEMPTY') return '폴더가 비어 있지 않습니다.'
  if (code === 'EBUSY') return '다른 프로그램이 사용 중입니다.'
  return msg
}
