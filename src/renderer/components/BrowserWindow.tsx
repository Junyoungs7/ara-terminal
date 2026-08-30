import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { BrowserTabView } from '@shared/browserWin'
import { t } from '../i18n'

// 내장 브라우저의 **탭 줄**. 2026-08-21 준영님 제보로 생겼다:
//   "모니터를 열고 다른 포트에서 열면 그전에가 사라지는데 이 모니터도 탭 형식으로."
//
// 이 컴포넌트가 그리는 것은 **탭 줄뿐**이다. 페이지 본문은 main 이 WebContentsView 로 이 아래에
// 붙인다(BrowserTabs.ts). 그래서 여기엔 <iframe>·<webview> 가 없고, 원격 콘텐츠는 이 문서에
// 절대 들어오지 않는다 — 그게 preload 를 가진 이 프레임과 원격 페이지를 가르는 경계다.
//
// **라벨은 오리진만 쓴다.** 페이지 제목을 쓰면 원격 페이지가 "A.R.A 설정" 같은 이름의 탭으로
// 앉을 수 있다(옛 창 제목 규칙과 같은 이유 — BrowserService.ts 주석).
export function BrowserWindow() {
  const [tabs, setTabs] = useState<BrowserTabView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    const off = window.ev?.browserTabs.onTabs((e) => {
      setTabs(e.tabs)
      setActiveId(e.activeId)
    })
    return () => off?.()
  }, [])

  const active = tabs.find((x) => x.id === activeId) ?? null
  useEffect(() => {
    // 창 제목도 오리진이다(라벨과 같은 규칙). 탭이 없으면 앱 이름만.
    document.title = active ? `${active.origin} — ${t('browser.title')}` : t('browser.title')
  }, [active])

  return (
    <div className="app browserwin">
      <div className="bw-tabs" role="tablist">
        <button
          type="button"
          className="tw-tool bw-nav"
          title={t('browser.back')}
          onClick={() => void window.ev?.browserTabs.back().catch(() => {})}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <button
          type="button"
          className="tw-tool bw-nav"
          title={t('browser.reload')}
          onClick={() => void window.ev?.browserTabs.reload().catch(() => {})}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M20 11a8 8 0 10-2.3 5.6M20 5v6h-6" />
          </svg>
        </button>
        <div className="bw-strip">
          {tabs.map((tab) => {
            const on = tab.id === activeId
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={on}
                className={'bw-tab' + (on ? ' on' : '')}
                data-origin={tab.origin}
                title={tab.url}
                onClick={() => void window.ev?.browserTabs.select(tab.id).catch(() => {})}
              >
                <span className={'bw-dot' + (tab.loading ? ' load' : '')} />
                <span className="bw-label">{tab.origin}</span>
                <span
                  className="bw-x"
                  role="button"
                  aria-label={t('browser.closeTab')}
                  title={t('browser.closeTab')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void window.ev?.browserTabs.closeTab(tab.id).catch(() => {})
                  }}
                >
                  <X />
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
