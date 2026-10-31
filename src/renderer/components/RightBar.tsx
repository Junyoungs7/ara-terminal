import type { JSX } from 'react'
import { CircleCheck, Files, GitBranch, MessageCircle } from 'lucide-react'
import type { Space } from '@shared/space'
import { t } from '../i18n'

/**
 * M1 라운드 2 — 오른쪽 끝 아이콘 바(시안 SW-final, Orca 오른쪽 사이드바 탭 줄). 실험 기능(설정 › 고급)을 켰을 때만 선다.
 *
 * 맨 위 = 아라 채팅. 열림 상태는 따로 없다 — 타이틀바 [채팅]·Alt+A 와 **같은 값**(Shell 의 rail === 'ai')을 보고 같은 토글을 부른다.
 * AI 작업 공간에서는 그 아래 탐색기·소스 제어·검사 자리(비활성 — M6·M7 에서 채운다). 터미널 공간에서는 아라만.
 * 클래스는 고유하다(.rbar-item) — 왼쪽 레일(.lrail-item)과 모양이 같아도 선택자를 돌려 쓰지 않는다.
 */
const SOON: readonly { id: string; Icon: () => JSX.Element }[] = [
  { id: 'explorer', Icon: () => <Files /> },
  { id: 'scm', Icon: () => <GitBranch /> },
  { id: 'checks', Icon: () => <CircleCheck /> }
]

export function RightBar({ space, chatOpen, onChat }: { space: Space; chatOpen: boolean; onChat: () => void }): JSX.Element {
  return (
    <div className="rbar" role="toolbar" aria-label={t('rbar.label')}>
      <button
        type="button"
        className={'rbar-item' + (chatOpen ? ' active' : '')}
        data-rbar="chat"
        aria-pressed={chatOpen}
        aria-label={t('rbar.chat')}
        title={t('titlebar.chat.tip')}
        onClick={onChat}
      >
        <MessageCircle />
      </button>
      {space === 'ai' && (
        <>
          <div className="rbar-div" role="separator" />
          {SOON.map(({ id, Icon }) => (
            <button
              key={id}
              type="button"
              className="rbar-item"
              data-rbar={id}
              disabled
              aria-label={t('rbar.' + id)}
              title={`${t('rbar.' + id)} · ${t('aiws.soon')}`}
            >
              <Icon />
            </button>
          ))}
        </>
      )}
    </div>
  )
}
