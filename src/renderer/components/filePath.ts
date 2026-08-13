// [파일] 탭 경로·표기 헬퍼 (R7). 순수 함수 — 단위 테스트 대상(tests/filepath.test.ts).
// 로컬(Windows 'C:\Users\me')과 원격 SFTP(posix '/srv/서비스')를 한 트리가 다루므로
// 구분자를 문자열에서 추론한다. 상위 경로는 main 이 계산해 내려주므로(FileListResult.parent) 여기 없다.

// 경로에 역슬래시가 있으면 Windows 경로. 없으면 posix.
export function sepOf(p: string): '/' | '\\' {
  return p.includes('\\') ? '\\' : '/'
}

export function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir)
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

export type Crumb = { label: string; path: string }

// 브레드크럼 세그먼트(각 조각 + 그 조각까지의 절대 경로). posix 루트는 '/', Windows 는 'C:'.
export function crumbs(p: string): Crumb[] {
  if (!p) return []
  const sep = sepOf(p)
  const out: Crumb[] = []
  let acc = ''
  p.split(/[\\/]/).forEach((part, i) => {
    if (i === 0) {
      acc = part === '' ? sep : part + sep
      out.push({ label: part === '' ? sep : part, path: acc })
      return
    }
    if (part === '') return
    acc = acc.endsWith(sep) ? acc + part : acc + sep + part
    out.push({ label: part, path: acc })
  })
  return out
}

// 트리→터미널 cd 입력(R7). 줄 실행 문자는 CR 이다 — conpty/PowerShell 은 LF 만 받으면 줄을 실행하지
// 않고 연속 입력(`>>`)에 빠져 다음 명령이 앞줄에 이어붙는다(T1 BLOCKER-2). POSIX pty 도 CR 을 Enter 로
// 받으므로 로컬·SSH 한 경로로 간다. 공백 경로는 따옴표로 감싼다(cmd·PowerShell·POSIX 셸 공통).
export function cdCommand(absPath: string): string {
  return `cd "${absPath}"\r`
}

// F14: 로컬 세션에 파일을 Ctrl+V 하면 올릴 곳이 없으므로 경로 문자열을 그대로 붙여넣는다.
// 공백이 든 경로는 따옴표로 감싼다(cdCommand 와 같은 규칙). 줄바꿈은 붙이지 않는다 —
// 붙여넣기는 명령을 실행하는 동작이 아니다.
export function pastePaths(paths: readonly string[]): string {
  return paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')
}

// 바이트 → 사람이 읽는 크기(목업 표기: 2.1K / 18M).
export function humanSize(n: number): string {
  if (n < 1024) return String(n)
  const u = ['K', 'M', 'G', 'T']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return (v >= 10 ? Math.round(v) : v.toFixed(1)) + u[i]
}

const pad2 = (n: number) => String(n).padStart(2, '0')

// mtime(epoch ms) → 상대 시간. 일주일이 넘으면 날짜(YY.MM.DD)로 — "312일 전"은 아무도 못 읽는다.
export function relTime(ms: number, now = Date.now()): string {
  if (!ms) return ''
  const min = Math.floor(Math.max(0, now - ms) / 60000)
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}시간 전`
  const day = Math.floor(hour / 24)
  if (day < 7) return `${day}일 전`
  const d = new Date(ms)
  return `${String(d.getFullYear()).slice(2)}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`
}
