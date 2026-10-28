import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { IconClose } from '../components/icons'
import { insertText } from '../components/aiBlocks'
import { writeClipboard } from '../store/clipboardWrite'
import {
  CATEGORY_LABEL,
  COMMAND_BOOK,
  DISTRO_LABEL,
  searchCommandBook,
  type CommandEntry
} from '../data/commandBook'

// F18 명령어 북 — 검색형 치트시트 오버레이. 새 패널·새 프레임워크를 만들지 않는다:
// 바깥 껍데기(오버레이/카드/헤더/본문/푸터)는 Cheatsheet(.cheatsheet/.cs-*)를, 검색창은
// .sp-search 규칙을 그대로 재사용한다. 새로 만든 CSS는 목록·펼침 상세뿐이다.
// (.sp- 는 #67 에서 지운 스마트 팔레트의 접두사다 — 규칙은 여기가 쓰고 있어 이름째 남겼다.)
//
// 항목의 예시에 붙는 [터미널로 보내기]는 F16 과 같은 규칙 — insertText() 로 개행을 떼고
// session.input() 에 넣기만 한다(실행은 사용자가 Enter). 이 앱의 안전 설계를 그대로 따른다.

function ExampleRow({
  code,
  note,
  sessionId,
  onSent
}: {
  code: string
  note?: string
  sessionId: string | null
  /** 보내고 나면 북을 닫는다 — 넣은 명령이 보여야 하기 때문이다(아래 onClick 주석). */
  onSent: () => void
}) {
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
          // 2026-08-22 준영님 제보 9번: "터미널로 보내기 버튼 클릭하면 명령어 북 꺼지면서 해당
          // 창이 보여야 함." 넣기만 하고 북이 덮고 있으면 **무엇이 들어갔는지 보이지 않는다** —
          // 실행(Enter)은 사용자가 하는데 그 대상을 못 보는 상태가 된다.
          onClick={() => {
            if (!sessionId) return
            window.ev?.session.input(sessionId, insertText(code))
            onSent()
          }}
        >
          {t('ai.code.insert')}
        </button>
      </div>
      <pre className="ai-code-body">{code}</pre>
    </div>
  )
}

function Item({
  entry,
  open,
  onToggle,
  sessionId,
  onSent
}: {
  entry: CommandEntry
  open: boolean
  onToggle: () => void
  sessionId: string | null
  onSent: () => void
}) {
  return (
    <div className="cb-item">
      <div className="cb-row" onClick={onToggle}>
        <span className="cb-cat">{CATEGORY_LABEL[entry.category]}</span>
        <code className="cb-cmd">{entry.cmd}</code>
        {/* 계열 전용 명령은 접힌 줄에서 바로 보여야 한다 — 펼쳐야 안다면 잘못된 계열의 명령을
            그대로 복사해 가게 된다(2026-08-14 준영님 지적). */}
        {entry.distro && <span className={'cb-distro ' + entry.distro}>{DISTRO_LABEL[entry.distro]}</span>}
        <span className="cb-desc">{entry.desc}</span>
      </div>
      {open && (
        <div className="cb-detail">
          {entry.examples.map((ex, i) => (
            <ExampleRow key={i} code={ex.cmd} note={ex.note} sessionId={sessionId} onSent={onSent} />
          ))}
          {/* hint 는 사실 전달(배포판 차이·기본 미설치), caution 은 경고 — 톤을 섞지 않는다. */}
          {entry.hint && <div className="cb-hint">{entry.hint}</div>}
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
          {/* SVG 는 스크린리더가 읽지 않는다 — 이름은 여기서 준다(닫기 버튼 감사, FINISH-M2). */}
          <button type="button" className="x" aria-label={t('dlg.close')} title={t('dlg.close')} onClick={onClose}>
            <IconClose />
          </button>
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
          <kbd className="esc-kbd kbd">Esc</kbd>
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
                  onSent={onClose}
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
