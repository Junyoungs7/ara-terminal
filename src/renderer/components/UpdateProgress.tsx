import { t } from '../i18n'
import logo from '../../../assets/brand/ara-favicon.svg'

/**
 * #198 업데이트가 **일어나고 있다는 것을 보여 준다.**
 *
 * 준영님 제보(2026-09-15): *"사용자가 업데이트를 할 때 백그라운드로 아라를 종료하고 업데이트가
 * 되는데 이때 아무것도 안 떠서 사용자가 업데이트되는지 모르더라고. 그래서 업데이트하면 작은
 * 로고가 뜨면서 업데이트 퍼센트가 나오면서 업데이트 되게 하면 어때?"*
 *
 * 🔴 **설치 중에는 우리가 그릴 수 있는 것이 없다.** `quitAndInstall` 은 설치 프로그램을 띄우고
 * 우리를 종료시킨다 — 그 사이 이 프로세스는 존재하지 않는다. 그래서 이 카드가 덮는 구간은 둘이다:
 *   · `downloading` — 받는 동안. 진짜 진행률이 있다
 *   · `installing`  — **끄기 직전 한 박자.** 무슨 일이 일어나는지 말하고 사라진다
 * (설치 중에 뜨는 화면이 바로 1.0.6 에서 없앤 NSIS 창이다. 그것을 되돌리는 것은 답이 아니다.)
 *
 * ⚠️ **모달이 아니다.** 받는 동안에도 하던 일을 그대로 하시면 된다고 문구가 약속하고 있다
 * (`update.prompt.msg`) — 화면을 막으면 그 약속을 깬다. 그래서 우하단에 뜨고 아무것도 가리지 않는다.
 */
export function UpdateProgress({ phase, version, percent }: { phase: 'downloading' | 'installing'; version: string; percent: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)))
  const downloading = phase === 'downloading'
  return (
    <div className="upd-card" role="status" aria-live="polite">
      <img className="upd-logo" src={logo} alt="" width={28} height={28} />
      <div className="upd-body">
        <div className="upd-title">
          {downloading ? t('update.card.downloading').replace('{v}', version) : t('update.card.installing')}
        </div>
        <div className="upd-sub">{downloading ? t('update.card.keepWorking') : t('update.card.reopens')}</div>
        {/* 받는 동안만 막대. 설치 중에는 **진행률을 모른다** — 모르는 값을 0% 로 그리면 멈춘 것처럼
            보인다(그건 거짓말이다). 대신 위 문구가 "곧 다시 열립니다"로 끝을 말한다. */}
        {downloading && (
          <div className="upd-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="upd-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      {downloading && <div className="upd-pct">{pct}%</div>}
    </div>
  )
}
