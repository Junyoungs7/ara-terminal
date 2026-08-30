import { Fragment } from 'react'
import { KEYMAP, type KeyBinding, type KeymapCategory } from '../../shared/keymap'
import { IconClose } from '../components/icons'
import { t } from '../i18n'

// 단축키 치트시트 — KEYMAP(shared/keymap.ts) 단일 소스에서 자동 생성(하드코딩 표 금지).
// 4열 그리드(design-system §9.4). 8개 카테고리를 4개 표시 컬럼으로 묶는다.
// implemented=false(미배선) 항목은 싣지 않는다 — 눌러도 반응 없는 키를 안내하면 치트시트가 거짓말이 된다(R2.5).

// mac 여부에 따라 표기 선택. 렌더러에서 navigator.platform 으로 판정.
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

type Column = { title: string; cats: KeymapCategory[] }
const COLUMNS: readonly Column[] = [
  { title: '패널 분할', cats: ['panel'] },
  { title: '탭 · 세션', cats: ['tab'] },
  { title: '검색 · 클립보드', cats: ['search', 'clipboard', 'ai'] },
  { title: '보기 · 기타', cats: ['view', 'file', 'connection', 'help'] }
]

// 'Ctrl+Shift+B' → ['Ctrl','Shift','B'] kbd 칩. 'Ctrl+1-9' 같은 범위는 마지막 토큰 그대로.
function keyChips(combo: string) {
  return combo.split('+')
}

function Row({ b }: { b: KeyBinding }) {
  const combo = isMac ? b.mac : b.win
  const chips = keyChips(combo)
  return (
    <div className="cs-row">
      <span className="cs-desc">{b.labelKo}</span>
      <span className="cs-keys">
        {chips.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="cs-sep">+</span>}
            <span className="cs-k">{c}</span>
          </Fragment>
        ))}
      </span>
    </div>
  )
}

type Props = { open: boolean; onClose: () => void }

export function Cheatsheet({ open, onClose }: Props) {
  if (!open) return null
  return (
    <div className="cheatsheet open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cs-card">
        <div className="cs-hd">
          <div className="cs-hd-ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M7 9h2M7 13h2M13 9h4M13 13h4" />
            </svg>
          </div>
          <div>
            <h2>A.R.A 단축키 치트시트</h2>
            <p>모든 키보드 단축키 — ? 로 언제든지</p>
          </div>
          {/* SVG 는 스크린리더가 읽지 않는다 — 이름은 여기서 준다(닫기 버튼 감사, FINISH-M2).
              이 파일의 나머지 문구는 아직 하드코딩이다 — 접근 가능한 이름만 i18n 을 쓴다.
              M3: <button> 이 되면서 `role="button"` 은 뺐다(진짜 버튼에 역할을 덧칠하지 않는다). */}
          <button type="button" className="x" aria-label={t('dlg.close')} title={t('dlg.close')} onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="cs-body">
          <div className="cs-grid">
            {COLUMNS.map((col) => {
              const rows = KEYMAP.filter((b) => b.implemented && col.cats.includes(b.category))
              return (
                <div key={col.title}>
                  <div className="cs-col-title">{col.title}</div>
                  {rows.map((b) => (
                    <Row key={b.action} b={b} />
                  ))}
                </div>
              )
            })}
          </div>
        </div>
        <div className="cs-foot">
          <span>ESC · 바깥 클릭 · ✕ 로 닫기</span>
        </div>
      </div>
    </div>
  )
}
