import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { IconClose } from '../components/icons'
import { insertText } from '../components/aiBlocks'
import { writeClipboard } from '../store/clipboardWrite'
import { CATEGORY_LABEL, COMMAND_BOOK, searchCommandBook, type CommandEntry } from '../data/commandBook'

// F18 명령어 북 — 검색형 치트시트 오버레이. 새 패널·새 프레임워크를 만들지 않는다:
// 바깥 껍데기(오버레이/카드/헤더/본문/푸터)는 Cheatsheet(.cheatsheet/.cs-*)를, 검색창은
// SmartPalette(.sp-search)를 그대로 재사용한다. 새로 만든 CSS는 목록·펼침 상세뿐이다.
//
// 항목의 예시에 붙는 [터미널로 보내기]는 F16 과 같은 규칙 — insertText() 로 개행을 떼고
// session.input() 에 넣기만 한다(실행은 사용자가 Enter). 이 앱의 안전 설계를 그대로 따른다.

function ExampleRow({ code, note, sessionId }: { code: string; note?: string; sessionId: string | null }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="ai-code cb-ex">
      <div className="ai-code-hd">
        <span className="ai-code-lang">{note ?? t('ai.code.plain')}</span>
        <button
          type="button"
          className="ai-code-btn"
          onClick={() => {
            void writeClipboard(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? t('ai.code.copied') : t('ai.code.copy')}
        </button>
        <button
          type="button"
          className="ai-code-btn send"
          disabled={!sessionId}
          title={sessionId ? t('ai.code.insert.title') : t('ai.noSession')}
          onClick={() => sessionId && window.ev?.session.input(sessionId, insertText(code))}
        >
          {t('ai.code.insert')}
        </button>
      </div>
      <pre className="ai-code-body">{code}</pre>
    </div>
  )
}

function Item({ entry, open, onToggle, sessionId }: { entry: CommandEntry; open: boolean; onToggle: () => void; sessionId: string | null }) {
  return (
    <div className="cb-item">
      <div className="cb-row" onClick={onToggle}>
        <span className="cb-cat">{CATEGORY_LABEL[entry.category]}</span>
        <code className="cb-cmd">{entry.cmd}</code>
        <span className="cb-desc">{entry.desc}</span>
      </div>
      {open && (
        <div className="cb-detail">
          {entry.examples.map((ex, i) => (
            <ExampleRow key={i} code={ex.cmd} note={ex.note} sessionId={sessionId} />
          ))}
          {entry.caution && <div className="cb-caution">⚠ {entry.caution}</div>}
        </div>
      )}
    </div>
  )
}

type Props = {
  open: boolean
  onClose: () => void
  sessionId: string | null
  // FB-monitor: 설정 [단축키]의 "tmux 사용법 보기" 같은 진입점이 특정 카테고리로 바로 들어가게 한다.
  // open 이 true 로 바뀌는 시점에만 반영한다(열려 있는 동안 바뀌어도 사용자가 입력 중인 검색어를 덮지 않는다).
  initialQuery?: string
}

export function CommandBook({ open, onClose, sessionId, initialQuery }: Props) {
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setQ(initialQuery ?? '')
      setExpanded(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  const results = searchCommandBook(COMMAND_BOOK, q)

  return (
    <div className="cheatsheet open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cs-card">
        <div className="cs-hd">
          <div className="cs-hd-ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
            </svg>
          </div>
          <div>
            <h2>{t('cmdbook.title')}</h2>
            <p>{t('cmdbook.subtitle')}</p>
          </div>
          <span className="x" onClick={onClose}>
            <IconClose />
          </span>
        </div>
        <div className="sp-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            type="text"
            autoFocus
            placeholder={t('cmdbook.search.placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="esc-kbd">ESC</span>
        </div>
        <div className="cs-body">
          {results.length === 0 ? (
            <div className="sp-empty">{t('cmdbook.empty')}</div>
          ) : (
            <div className="cb-list">
              {results.map((entry) => (
                <Item
                  key={entry.id}
                  entry={entry}
                  open={expanded === entry.id}
                  onToggle={() => setExpanded((v) => (v === entry.id ? null : entry.id))}
                  sessionId={sessionId}
                />
              ))}
            </div>
          )}
        </div>
        <div className="cs-foot">
          <span>ESC · 바깥 클릭 · ✕ 로 닫기</span>
          <span>{results.length}개</span>
        </div>
      </div>
    </div>
  )
}
