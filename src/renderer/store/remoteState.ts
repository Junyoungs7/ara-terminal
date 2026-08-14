import { t } from '../i18n'
import type { RemoteData } from '@shared/ipc'

// #68(2026-08-14) — 원격 표 다섯(프로세스·서비스·디스크·패키지·컨테이너)이 한 바퀴 결과를
// 똑같이 판정하게 하는 순수 함수. 표마다 따로 쓰면 또 갈린다(전에는 셋이 서로 다른 방식이었다).
//
// 고치는 문제: 예전엔 실패한 바퀴를 main 이 조용히 버려서 행이 0 인 채로 남았고, 화면은
// "불러오는 중"을 영원히 보여 줬다 — 권한 부족·명령 없음·연결 끊김이 전부 로딩으로 보였다.
// 같은 종류의 사고가 #57(런치패드 [패키지]가 빈 표)에서 이미 한 번 났다.
//
// 판정 규칙 — **행이 하나라도 나왔으면 오류가 아니다.**
//  · err 가 있으면(한 바퀴가 아예 실패) → 그 사유.
//  · 행이 0 이고 종료코드가 0 이 아니며 출력이 있으면 → 그 출력이 곧 오류 메시지다(stderr 가 섞여 온다).
//    종료코드만으로 판정하면 안 된다 — 카탈로그의 일부 스크립트는 정상 출력을 내면서도 0 이 아니다
//    (`command -v` 로 없는 프로그램을 건너뛰는 pkg.probe 가 그렇다).
//  · 그 밖 → 오류 아님(null). 로딩·빈 결과는 표가 알아서 구분한다.
export function remoteError(d: Pick<RemoteData, 'out' | 'code' | 'err'>, rowCount: number): string | null {
  if (d.err) return t('console.err.' + d.err)
  if (rowCount > 0) return null
  if (typeof d.code === 'number' && d.code !== 0 && d.out.trim()) return d.out.trim()
  return null
}
