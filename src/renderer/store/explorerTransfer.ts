// W4sat F20: 탐색기 2패널 간 복사/이동을 "무엇을 할지"만 조립하는 순수 함수(단위 테스트 대상).
// 실제 IPC 호출(fs.copy/remove, sftp.upload/download)은 ExplorerView가 이 결과를 보고 수행한다 —
// 여기선 경로 조립·로컬/원격 판별만 한다(새 파일시스템 계층을 만들지 않는다 — 기존 fs:*/sftp:* 그대로).
import type { FileEntry } from '@shared/ipc'
import { joinPath } from '../components/filePath'
import type { ActiveFileSession } from '../components/FileTree'

export type PanelLoc = { session: ActiveFileSession; path: string }

// 붙여넣기의 방향 규칙(2026-08-09 준영님 확정): **우리 → 원격은 붙여넣기, 원격 → 우리는 다운로드.**
// 어떤 건 되고 어떤 건 안 되는 상태가 헷갈린다는 지적에 따라 방향을 한 가지로 못 박았다.
// 원격 파일을 받는 길은 우클릭 [다운로드] 하나뿐이고, 그쪽은 저장 위치를 직접 고른다
// (붙여넣기는 "지금 트리가 보고 있는 폴더"로 조용히 떨어져 어디 갔는지 알기 어려웠다).
//
// 로컬↔로컬 / 로컬→원격 / 원격↔원격(서로 다른 서버) 세 갈래.
// 같은 서버 안의 복사는 여기 오지 않는다 — 호출측이 먼저 exec `cp` 로 보낸다(네트워크를 안 탄다).
// 서버 A→B 는 SFTP 에 서버 간 전송 op 가 없어 데이터가 우리를 거치지만, main 이 두 스트림을 바로
// 이어 붙인다(디스크 임시 파일 없음) — 2026-08-08 에 열었다. 그전엔 unsupported 였다.
export type CrossPanelPlan =
  | { kind: 'local'; mode: 'copy' | 'move'; paths: string[]; destDir: string }
  | { kind: 'localToRemote'; mode: 'copy' | 'move'; sessionId: string; files: { localPath: string; name: string }[]; remoteDir: string }
  | {
      kind: 'remoteToRemote'
      mode: 'copy' | 'move'
      srcSessionId: string
      destSessionId: string
      files: { remotePath: string; name: string; size: number }[]
      destDir: string
    }
  // useDownload = 원격 → 우리. 기술적으로는 되지만 정책상 붙여넣기로 받지 않는다(위 규칙).
  | { kind: 'unsupported'; reason: 'sameRemote' | 'noTargets' | 'useDownload' }

export function planCrossPanelTransfer(
  src: PanelLoc,
  dest: PanelLoc,
  targets: readonly FileEntry[],
  mode: 'copy' | 'move'
): CrossPanelPlan {
  if (targets.length === 0) return { kind: 'unsupported', reason: 'noTargets' }

  // FileTree 계약상 session:null 은 "백엔드 없음"(플레이스홀더) 이지 로컬을 뜻하지 않는다 — 탐색기
  // 패널은 로컬도 항상 { id, type: 'local' } 로 채워 넘긴다. 판별은 session 자체가 아니라 type 으로 한다.
  const srcRemote = src.session?.type === 'ssh'
  const destRemote = dest.session?.type === 'ssh'

  if (srcRemote && destRemote) {
    const srcId = src.session!.id
    const destId = dest.session!.id
    // 같은 서버는 이 계획의 일이 아니다 — 호출측이 exec `cp` 로 처리한다(여기까지 왔으면 배선 실수).
    if (srcId === destId) return { kind: 'unsupported', reason: 'sameRemote' }
    return {
      kind: 'remoteToRemote',
      mode,
      srcSessionId: srcId,
      destSessionId: destId,
      // 폴더는 못 옮긴다(업로드·다운로드와 같은 제약 — 스트림 하나가 파일 하나다). 걸러서 넘긴다.
      files: targets.filter((f) => f.type === 'file').map((f) => ({ remotePath: joinPath(src.path, f.name), name: f.name, size: f.size })),
      destDir: dest.path
    }
  }

  if (!srcRemote && !destRemote) {
    return { kind: 'local', mode, paths: targets.map((f) => joinPath(src.path, f.name)), destDir: dest.path }
  }

  if (!srcRemote && destRemote) {
    return {
      kind: 'localToRemote',
      mode,
      sessionId: dest.session!.id,
      // 폴더도 넘긴다 — 업로드(SftpService.upload)가 폴더면 통째로 올린다(오류 신고 #18 #19).
      files: targets.map((f) => ({ localPath: joinPath(src.path, f.name), name: f.name })),
      remoteDir: dest.path
    }
  }

  // 원격 → 우리: 붙여넣기로는 받지 않는다. 우클릭 [다운로드]가 저장 위치를 묻고 받는다.
  return { kind: 'unsupported', reason: 'useDownload' }
}
