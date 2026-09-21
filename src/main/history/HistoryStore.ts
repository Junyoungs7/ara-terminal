// F11 명령어 히스토리 영속화 — userData/history.json.
// 모양: { [scope]: string[] } (오래된→최신). scope = SSH 는 serverKey, 로컬은 'local' —
// 서버마다 쓰는 명령이 다르므로 한 통에 섞으면 고스트 자동완성이 남의 서버 명령을 물어 온다.
//
// 저장은 WorkspaceStore 와 같은 디바운스 + before-quit flush 이중화. 명령 한 줄마다 디스크를
// 때리면 빠른 타이핑에 쓰기가 몰린다.
import { writeJsonAtomic, readJsonWithBackup, cleanupTemp } from '../util/atomicJson'
import { maskSecrets } from '@shared/maskSecrets'

export const HISTORY_MAX = 500
const FLUSH_DEBOUNCE_MS = 5_000

type HistoryFile = Record<string, string[]>

export class HistoryStore {
  private data: HistoryFile
  private timer: NodeJS.Timeout | null = null

  // path 가 공개인 이유: 설정 화면이 "여기에 쌓입니다"를 한 줄로 적는다. 그 자리가 어디인지
  // 아는 것은 main 뿐이고, 같은 경로를 IPC 쪽에서 다시 조립하면 둘이 갈라진다.
  constructor(readonly path: string) {
    cleanupTemp(path)
    const raw = readJsonWithBackup<unknown>(path, null)
    this.data = isHistoryFile(raw) ? raw : {}
  }

  load(scope: string): string[] {
    return this.data[scope] ?? []
  }

  // 상한 초과 시 오래된 것부터 버린다. 연속 중복은 남기지 않는다(렌더러 캐시와 같은 규칙).
  //
  // ⚠️ 저장 전에 마스킹한다(F12 와 같은 함수). 이 파일은 `mysql -pSECRET` 같은 명령을 평문으로
  // 담고 있었다 — 디스크에 남는 것은 마스킹된 형태뿐이어야 한다. 마스킹 후 빈 줄이 되면 버린다.
  append(scope: string, raw: string): void {
    if (typeof scope !== 'string' || !scope || typeof raw !== 'string' || !raw) return
    const command = maskSecrets(raw)
    if (!command.trim()) return
    const list = this.data[scope] ?? (this.data[scope] = [])
    if (list[list.length - 1] === command) return
    list.push(command)
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX)
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS)
  }

  /**
   * 통 목록과 줄 수. 설정 화면이 "무엇이 얼마나 쌓였나"를 보여 준다 — **내용은 주지 않는다.**
   * 지우려면 무엇이 있는지는 봐야 하지만, 그걸 보여 주자고 비밀을 한 화면 더 그릴 이유는 없다.
   */
  scopes(): { scope: string; count: number }[] {
    return Object.entries(this.data).map(([scope, list]) => ({ scope, count: list.length }))
  }

  /**
   * 통 하나(또는 scope 를 안 주면 전부)를 버린다.
   *
   * 🔴 **즉시 flush 한다.** 5초 디바운스에 맡기면 사용자가 [지우기]를 누르고 바로 앱을 꺼도
   * 파일에 그대로 남는다 — 지웠다고 믿는데 안 지워진 것이 이 기능의 최악이다.
   */
  clear(scope?: string): void {
    if (scope === undefined) this.data = {}
    else delete this.data[scope]
    this.flush()
  }

  // 디바운스 타이머에서도 불리므로 던지지 않는다: 여기서 예외가 나면 붙잡을 호출자가 없어
  // 프로세스 레벨 uncaughtException 이 된다. 히스토리는 편의 캐시라 한 번의 쓰기 실패로
  // 앱을 흔들 값이 아니다(workspace.json 과 달리 사용자가 맡긴 데이터가 아니다).
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      writeJsonAtomic(this.path, this.data)
    } catch (err) {
      process.stderr.write(`[history] 저장 실패: ${String(err)}\n`)
    }
  }
}

// 디스크 파일은 신뢰 경계 밖이다(손상·수동 편집). 모양이 아니면 통째로 버리고 빈 히스토리로 시작한다.
function isHistoryFile(raw: unknown): raw is HistoryFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  return Object.values(raw as Record<string, unknown>).every(
    (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')
  )
}
