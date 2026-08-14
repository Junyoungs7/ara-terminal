import { useCallback, useEffect, useRef, useState } from 'react'
import { IconClose } from './icons'
import { t } from '../i18n'

// W1 F13 원격 로그 실시간 확인 — 읽기 전용 패널. 메인 영역 하단 오버레이(터미널 검색 바와 같은 자리 규칙).
//
// 두 갈래를 합쳐 보여 준다:
//   · 과거 — SFTP 로 파일을 **뒤에서부터 창 단위**로 읽는다(logtail:history). [이전 불러오기]로 더 거슬러 간다.
//   · 실시간 — `tail -n 0 -F` 스트림. "지금부터 새로 붙는 줄"만 담당한다.
// tail 을 -n 0 으로 두는 이유는 겹침 방지다(tail 이 앞부분을 같이 뱉으면 창과 같은 줄이 두 번 보인다).
// 시작 순서가 tail → 창 읽기라, 그 찰나에 쓰인 줄은 유실이 아니라 중복으로 나타난다(둘 중 나은 쪽).
//
// 일시정지는 스트림을 멈추지 않고 화면 추적만 멈춘다(자동 스크롤 off). 멈춘 동안 온 줄도 버퍼에 쌓여 있고
// 재개하면 맨 아래로 따라붙는다 — 멈춘 사이의 로그가 사라지는 편이 더 나쁘다.
// 다만 버퍼는 MAX_LINES 줄에서 앞부터 버린다: 그보다 많이 흐르면 오래 멈춰 있던 사이의 앞부분은 잘린다
// (그때는 [이전 불러오기]로 파일에서 다시 가져오면 된다 — 파일이 진실이다).
const MAX_LINES = 5000

export function LogViewer({
  sessionId,
  path,
  onClose
}: {
  sessionId: string
  path: string
  onClose: () => void
}) {
  const [hist, setHist] = useState('') // 파일에서 거슬러 읽은 과거
  const [live, setLive] = useState('') // tail 스트림이 붙인 실시간
  const [start, setStart] = useState(-1) // 과거 창의 시작 오프셋(-1=아직 안 읽음, 0=파일 처음까지)
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  const [ended, setEnded] = useState<string | null>(null)
  const bodyRef = useRef<HTMLPreElement>(null)

  // 스트림 수명 = 이 컴포넌트 수명. 닫히면(언마운트) logtail:stop 이 원격 tail 을 함께 정리한다.
  useEffect(() => {
    setHist('')
    setLive('')
    setStart(-1)
    setEnded(null)
    let stopped = false
    let offData: (() => void) | undefined
    let offExit: (() => void) | undefined
    let tailId: string | null = null
    void window.ev?.logtail
      .start(sessionId, path)
      .then(({ id }) => {
        if (stopped) {
          void window.ev?.logtail.stop(id).catch(() => {})
          return
        }
        tailId = id
        offData = window.ev?.logtail.onData(id, (d) => {
          setLive((prev) => {
            const next = prev + d.chunk
            const lines = next.split('\n')
            return lines.length > MAX_LINES ? lines.slice(-MAX_LINES).join('\n') : next
          })
        })
        offExit = window.ev?.logtail.onExit(id, (d) => setEnded(d.error ?? t('log.ended')))
        // tail 을 먼저 걸고 나서 과거를 읽는다(반대로 하면 그 사이 줄이 유실된다).
        void window.ev?.logtail.history(sessionId, path).then((res) => {
          if (stopped || !res.ok) return
          setHist(res.text)
          setStart(res.start)
        })
      })
      .catch((e: Error) => setEnded(e.message))
    return () => {
      stopped = true
      offData?.()
      offExit?.()
      if (tailId) void window.ev?.logtail.stop(tailId).catch(() => {})
    }
  }, [sessionId, path])

  // 앞쪽 창을 이어 붙인다. 붙인 만큼 스크롤을 밀어 줘야 보던 줄이 그대로 남는다.
  const loadOlder = useCallback(async () => {
    if (start <= 0 || busy) return
    const el = bodyRef.current
    const before = el?.scrollHeight ?? 0
    setBusy(true)
    const res = await window.ev.logtail.history(sessionId, path, start)
    setBusy(false)
    if (!res.ok) return setEnded(res.message)
    setHist((cur) => res.text + cur)
    setStart(res.start)
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before
    })
  }, [sessionId, path, start, busy])

  // 자동 스크롤(일시정지 중에는 화면을 붙잡아 둔다).
  useEffect(() => {
    if (paused) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [hist, live, paused])

  return (
    <div className="logview">
      <div className="lv-head">
        <span className="lv-live">
          <span className={'lv-dot' + (paused ? ' paused' : '')} />
          {paused ? t('log.paused') : t('log.live')}
        </span>
        {/* #76: "로그"라는 이름을 쓰는 것이 둘이라 어느 쪽인지 머리에서 밝힌다 —
            여기는 **서버의 로그 파일**, 우측 레일 [세션 기록]은 내가 이 세션에서 주고받은 것. */}
        <span className="lv-kind">{t('log.file.label')}</span>
        <span className="lv-path" title={path}>
          {path}
        </span>
        {ended && <span className="lv-end">{ended}</span>}
        <div className="sb-tab-spacer" />
        {start > 0 && (
          <button type="button" className="ts-btn" disabled={busy} onClick={() => void loadOlder()}>
            {t('log.loadOlder')}
          </button>
        )}
        <button type="button" className="ts-btn" title={t('log.pause.title')} onClick={() => setPaused((p) => !p)}>
          {paused ? t('log.resume') : t('log.pause')}
        </button>
        <button type="button" className="ts-btn" title={t('log.close')} onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <pre className="lv-body" ref={bodyRef}>
        {start === 0 && <span className="lv-top">{t('log.fileStart')}{'\n'}</span>}
        {hist}
        {live}
      </pre>
    </div>
  )
}
