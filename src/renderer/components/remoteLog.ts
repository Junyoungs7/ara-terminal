import { parseAppTrace } from '@shared/remoteCatalog'
import type { DialogResult, DialogSpec } from './Dialog'
import { t } from '../i18n'

// 포트 하나 → **그 프로그램의 로그 파일 경로**(2026-08-27 준영님 요청).
//
// 원격에서 AI 가 `npm run dev`·`uvicorn` 을 백그라운드로 띄우면 그 출력은 대개 아무 데도 안 남는다.
// `/proc/<pid>/fd/1` 을 읽으면 **어디로 갔는지**는 알 수 있다(WSL 실측으로 갈래 확인):
//  · 파일  → 그대로 tail
//  · tmux → `pipe-pane` 을 걸어 파일을 만든 뒤 tail (남의 팬을 건드리므로 **확인을 받는다**)
//  · 그 밖 → **원리상 볼 수 없다.** 지어내지 않고 왜인지와 다음 수를 말한다.
//
// 이 파일이 따로 있는 이유: 들어오는 문이 둘이다(포트 표의 [로그] 버튼 · [서버 로그] 탭의 포트 입력).
// 두 문이 같은 갈래·같은 문구를 써야 해서 판단을 한 곳에 둔다 — 화면 쪽에는 결과 경로만 준다.
export async function traceRemoteLog(opts: {
  sessionId: string
  port: number
  /** 포트 표가 이미 아는 pid. 있으면 원격에서 다시 찾지 않는다(찾기가 제일 잘 깨진다). */
  pid?: number
  ask?: (spec: DialogSpec) => Promise<DialogResult>
}): Promise<string | null> {
  const { sessionId, port, pid, ask } = opts
  const res = await window.ev?.remote.run(sessionId, 'app.trace', { port, pid }).catch(() => null)
  if (!res?.ok) {
    // 실패 사유를 뭉개지 않는다: 세션이 끊긴 것과 서버가 느린 것은 사람이 할 일이 다르다.
    await ask?.({
      title: t('port.log'),
      message: res?.reason === 'noSession' ? t('console.err.noSession') : t('port.log.fail'),
      cancelLabel: null
    })
    return null
  }
  const tr = parseAppTrace(res.out, port)
  if (tr.kind === 'file' && tr.path) return tr.path
  if (tr.kind === 'tmux' && tr.pane && tr.path) {
    // 남의 tmux 팬에 리다이렉트를 건다 — 되돌릴 수 있지만 남의 것을 건드리는 일이라 묻는다.
    const r = await ask?.({
      title: t('port.log.pipe.title'),
      message: `${t('port.log.pipe.msg')}\n\n${tr.cmd ?? ''}`,
      confirmLabel: t('port.log.pipe.btn'),
      cancelLabel: t('dlg.cancel')
    })
    if (r !== 'confirm') return null
    const piped = await window.ev?.remote.run(sessionId, 'app.pipe', { pane: tr.pane, port }).catch(() => null)
    if (piped?.ok) return tr.path
    await ask?.({ title: t('port.log'), message: t('port.log.fail'), cancelLabel: null })
    return null
  }
  // 못 보는 경우 — **왜인지와 다음 수**를 말한다(빈손으로 돌려보내지 않는다).
  const why =
    tr.kind === 'none'
      ? t('port.log.none')
      : tr.kind === 'denied'
        ? t('port.log.denied')
        : tr.kind === 'null'
          ? t('port.log.null')
          : tr.kind === 'tty'
            ? t('port.log.tty')
            : t('port.log.pipe.no')
  await ask?.({ title: t('port.log'), message: `${why}\n\n${t('port.log.howto')}`, cancelLabel: null })
  return null
}

/**
 * [서버 로그] 탭 입력칸 한 줄을 읽는다. 포트 번호와 경로를 **한 칸에서** 받는다 —
 * 둘을 가르는 기준이 눈에 뻔해서(숫자냐 아니냐) 칸을 두 개로 나눌 이유가 없다.
 */
export type LogTarget = { kind: 'port'; port: number } | { kind: 'path'; path: string } | null
export function parseLogTarget(raw: string): LogTarget {
  const s = raw.trim()
  if (s === '') return null
  if (/^\d{1,5}$/.test(s)) {
    const port = Number(s)
    return port >= 1 && port <= 65535 ? { kind: 'port', port } : null
  }
  // 경로는 절대경로나 ~ 로 시작하는 것만 받는다. 상대경로는 "어디 기준인가"가 사람마다 달라
  // (원격 셸의 cwd? 홈?) 조용히 엉뚱한 파일을 열 위험이 있다.
  return s.startsWith('/') || s.startsWith('~/') ? { kind: 'path', path: s } : null
}
