import { useCallback, useEffect, useState } from 'react'
import { parseOverview, type Overview } from '@shared/remoteCatalog'
import { t } from '../i18n'

// F26 R3 서버 개요 — 런치패드 **머리에 얹는 한 줄**이다. 타일을 하나 더 만들지 않은 이유:
// 준영님이 이 항목을 고르시며 붙인 설명이 "접속 직후 화면"이었다. 그러면 창을 하나 더 여는 게
// 아니라 콘솔을 열자마자 보이는 게 맞다.
//
// 여기는 **서버의 정체**(배포판·커널·가동 시간)만 맡는다. 자원 사용량(CPU·메모리·디스크)은
// F29 시스템 모니터 사이드바가 유일한 집이다 — 같은 숫자를 두 화면에서 보여 주지 않는다.
//
// 폴링하지 않는다: 배포판·커널은 안 변하고 가동 시간은 초 단위 정확도가 필요 없다.

export function uptimeText(sec: number | null): string {
  if (sec === null) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return t('console.ov.uptime.d').replace('{d}', String(d)).replace('{h}', String(h))
  if (h > 0) return t('console.ov.uptime.h').replace('{h}', String(h)).replace('{m}', String(m))
  return t('console.ov.uptime.m').replace('{m}', String(m))
}

export function ServerOverview({ sessionId, active }: { sessionId: string | null; active: boolean }) {
  const [ov, setOv] = useState<Overview | null>(null)

  const load = useCallback(() => {
    if (!sessionId) return
    void window.ev?.remote
      ?.run(sessionId, 'sys.overview')
      .then((r) => {
        if (r?.ok) setOv(parseOverview(r.out))
      })
      .catch(() => {})
  }, [sessionId])

  useEffect(() => {
    setOv(null) // 세션이 바뀌면 이전 서버 정보를 즉시 버린다.
    if (active && sessionId) load()
  }, [sessionId, active, load])

  if (!ov) return null
  // 한 조각이 없어도 나머지는 보여 준다 — 빈 것만 뺀다.
  const bits = [ov.distro, ov.kernel ? t('console.ov.kernel').replace('{v}', ov.kernel) : '', uptimeText(ov.uptimeSec)]
  return (
    <div className="con-ov" title={ov.hostname}>
      {bits.filter(Boolean).join(' · ')}
    </div>
  )
}
