import { useState } from 'react'
import { LogViewer } from './LogViewer'
import { parseLogTarget, traceRemoteLog } from './remoteLog'
import type { DialogResult, DialogSpec } from './Dialog'
import { t } from '../i18n'

// 하단바 [서버 로그] 탭 — 원격에서 도는 프로그램의 출력을 실시간으로 본다.
//
// **왜 탭인가**(2026-08-27 준영님 결정). 로그 뷰어는 메인 영역 바닥에 깔리는 오버레이였고,
// 열리는 순간 하단바를 통째로 덮었다 — *"실시간 로그를 보면서 하단바를 이용을 못하는데"*.
// 탭으로 내려오면 로그를 켜 둔 채로 포트·프로세스 표를 오갈 수 있고(탭을 바꿔도 스트림은
// 살아 있다), 터미널 높이도 그대로다.
//
// 들어오는 문이 둘이다:
//   · [모니터] 탭 포트 행의 [로그] 버튼 — 포트를 이미 아는 경우
//   · **이 탭의 입력칸** — 포트 번호나 로그 파일 경로를 직접 친다(준영님 추가 요청)
// 판단은 둘 다 remoteLog.ts 를 지난다. 두 문이 다른 답을 내면 안 된다.
export function AppLogPanel({
  sessionId,
  isSsh,
  path,
  onOpen,
  onClose,
  ask
}: {
  sessionId: string | null
  isSsh: boolean
  /** 지금 보고 있는 로그 파일. null 이면 입력 안내만 보인다. */
  path: string | null
  onOpen: (path: string) => void
  onClose: () => void
  ask?: (spec: DialogSpec) => Promise<DialogResult>
}) {
  const [box, setBox] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!sessionId || busy) return
    const target = parseLogTarget(box)
    if (!target) {
      await ask?.({ title: t('applog.title'), message: t('applog.bad'), cancelLabel: null })
      return
    }
    // 경로를 직접 넣었으면 찾을 것이 없다 — 그대로 연다(파일 트리의 [실시간으로 보기]와 같은 길).
    if (target.kind === 'path') {
      onOpen(target.path)
      setBox('')
      return
    }
    setBusy(true)
    const found = await traceRemoteLog({ sessionId, port: target.port, ask })
    setBusy(false)
    if (found) {
      onOpen(found)
      setBox('')
    }
  }

  if (!isSsh || !sessionId) return <div className="ap-empty">{t('applog.noSsh')}</div>

  return (
    <div className="applog">
      <div className="ap-head">
        <input
          className="ap-box"
          data-testid="applog-target"
          value={box}
          placeholder={t('applog.ph')}
          onChange={(e) => setBox(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
        <button type="button" className="ts-btn" data-action="applog.open" disabled={busy} onClick={() => void submit()}>
          {t('applog.open')}
        </button>
      </div>
      {path ? (
        // 파일이 바뀌면 스트림을 처음부터 다시 시작해야 한다 — key 에 경로를 넣어 재사용을 막는다.
        <LogViewer key={`${sessionId}:${path}`} embedded sessionId={sessionId} path={path} onClose={onClose} />
      ) : (
        <div className="ap-empty">{t('applog.hint')}</div>
      )}
    </div>
  )
}
