import { Fragment, useEffect, useState } from 'react'
import { t } from '../i18n'
import { IconClose } from './icons'
import { ACTIVITY_TITLE_KEY } from './ActivityBar'
import { moveActivity, toggleActivityHidden } from '../store/activityBar'
import {
  AI_MODELS_BY_PROVIDER,
  AI_PROVIDER_HOSTS,
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  UI_SCALES,
  CURSOR_STYLES,
  BELL_STYLES,
  LOG_RETENTION_OPTIONS,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  SCROLLBACK_STEP,
  type AiKeyResult,
  type AiProvider,
  type FontConfig,
  type McpState,
  type UiPrefs
} from '@shared/types'
import { validateBaseUrl } from '../../shared/aiBaseUrl'
import { FONT_OPTIONS, stackFor } from '../terminal/fontStacks'
import { LICENSES } from '../fonts/licenses'
import { KEYMAP, type KeymapCategory } from '../../shared/keymap'
import type { DialogResult, DialogSpec } from './Dialog'

// 설정 창 (F5 드로어 → R5 확장 → W2 [로그] → W3 [AI] → F23 [MCP] 추가).
// 좌측 nav 8섹션: 일반 / 터미널 / 폰트 / 로그 / AI / MCP / 단축키 / 정보.
// 표면은 목업 variant-final-2 의 .drawer 를 그대로 쓰고, .set-nav 만 가로 탭에서 세로 열로 바꿨다
// (섹션이 1개에서 5개로 늘어 가로로는 라벨이 눌린다). 새 모달 프레임워크는 쓰지 않는다.
//
// 슬라이더 범위(계획서 C-5 확정): 크기 10–20px, 행간 1.3–2.0.
// R3.7 Ctrl+휠 확대/축소도 같은 범위를 쓴다(슬라이더와 값이 어긋나면 안 된다).
export const SIZE_MIN = 10
export const SIZE_MAX = 20
const LH_MIN = 1.3
const LH_MAX = 2.0
const LH_STEP = 0.02

export const SETTINGS_SECTIONS = ['general', 'terminal', 'font', 'log', 'ai', 'mcp', 'keys', 'about'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

// 미리보기·비교 스트립에 쓰는 실사용 한글 터미널 출력(알파벳 예시 금지 — 스펙 #3).
const PREVIEW_LINES: { cls: string; text: string }[] = [
  { cls: 'pv-prompt', text: '$ ./배포스크립트/backup.sh --db main' },
  { cls: 'pv-ok', text: '✔ 데이터베이스 백업이 완료되었습니다. 파일: 백업_20260731.sql (성공)' },
  { cls: 'pv-warn', text: '⚠ 로그 디렉터리 용량 78% — 오래된 로그를 정리하세요.' },
  { cls: 'pv-info', text: 'ℹ 다음 정기 백업: 2026-08-01 03:00 KST · 예상 소요 4분' },
  { cls: 'pv-dim', text: '# 혼용: 로그15건 errors=0 처리량 1,204 req·s⁻¹ ① ★ ℃' },
  { cls: 'pv-err', text: '✗ 커넥션 풀 고갈: POST /api/결제/승인 재시도 3/3 실패' }
]

// 비교 스트립: 후보 폰트별 동일 한글 문장. 마지막(UI)은 고정폭 아님을 보여줌.
const COMPARE_ROWS: { label: string; source: string; stack: string; note?: string; best?: boolean }[] = [
  { label: '나눔고딕코딩', source: '번들 · OFL', stack: "'Nanum Gothic Coding', monospace", best: true },
  { label: 'D2Coding', source: '번들 · OFL', stack: "'D2Coding', monospace" },
  { label: 'JetBrains Mono', source: '번들 · OFL', stack: "'JetBrains Mono', monospace", note: '한글은 폴백 렌더' },
  { label: 'Pretendard', source: '번들 · UI', stack: "'Pretendard', sans-serif", note: '비고정폭 — UI 전용' }
]

const COMPARE_TEXT = '✔ 배포 완료: 백업_20260731.sql (성공) · ⚠ 결제/승인 retry 3/3'

// 단축키 섹션 열 구성 — 치트시트(interactions/Cheatsheet)와 같은 KEYMAP 파생이다.
// 드로어는 폭이 좁아 4열 대신 카테고리 한 덩어리씩 세로로 쌓는다.
// export: tests/settings-keygroups.test.ts 가 KEYMAP 의 모든 implemented 카테고리가 여기 빠짐없이
// 들어 있는지 검사한다(M-5 — 새 카테고리 추가 시 이 배열에 추가하지 않으면 그 테스트가 즉시 깨진다).
export const KEY_GROUPS: { title: string; cats: KeymapCategory[] }[] = [
  { title: '패널 분할', cats: ['panel'] },
  { title: '탭 · 세션', cats: ['tab'] },
  { title: '검색 · 클립보드', cats: ['search', 'clipboard'] },
  { title: 'AI', cats: ['ai'] },
  { title: '보기 · 연결 · 기타', cats: ['view', 'file', 'connection', 'help'] }
]

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

// 보존 기간 세그먼트. Seg 는 문자열 전용이라(라벨 키를 만들어야 한다) 문자열로 넘기고 되돌린다.
const RETENTION_VALUES = LOG_RETENTION_OPTIONS.map(String)

// 세그먼트 컨트롤(연결 관리자 인증 방식과 같은 .seg-ctl) — 값이 2~3개인 선택지에 쓴다.
function Seg<T extends string>({
  value,
  options,
  onChange,
  labelKey
}: {
  value: T
  options: readonly T[]
  onChange: (v: T) => void
  labelKey: (v: T) => string
}) {
  return (
    <div className="seg-ctl">
      {options.map((o) => (
        <button type="button" key={o} className={value === o ? 'on' : ''} onClick={() => onChange(o)} data-value={o}>
          {t(labelKey(o))}
        </button>
      ))}
    </div>
  )
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={'set-toggle' + (on ? ' on' : '')}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className="st-knob" />
    </button>
  )
}

// 항목 하나 = 제목 → 설명 → 컨트롤(위에서 아래로). 준영님 피드백(2026-08-13)으로 배치를 통일했다 —
// 그전엔 컨트롤이 오른쪽 끝에 붙어 있어, 설명이 길면 제목과 짝이 안 읽혔다.
// 예전 `stack` 예외(넓은 컨트롤만 아래로)는 이제 전부가 그 배치라 사라졌다.
function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="sr-main">
        <div className="sr-label">{label}</div>
        {desc && <div className="sr-desc">{desc}</div>}
      </div>
      <div className="sr-ctl">{children}</div>
    </div>
  )
}

// 모델 추천 칩(자유 입력 인풋 위) — provider 가 바뀌면 목록도 바뀐다. compatible 은 추천이 없다
// (게이트웨이마다 모델명이 다르다) — 인풋만 보인다.
function ModelPicker({ provider, value, onChange }: { provider: AiProvider; value: string; onChange: (v: string) => void }) {
  const options = AI_MODELS_BY_PROVIDER[provider]
  return (
    <div className="ai-model-ctl">
      {options.length > 0 && (
        <div className="seg-ctl">
          {options.map((o) => (
            <button type="button" key={o} className={value === o ? 'on' : ''} data-value={o} onClick={() => onChange(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <input
        type="text"
        className="ai-key-input"
        data-field="ai.model"
        spellCheck={false}
        placeholder={t('settings.ai.model.placeholder')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

// [AI] 섹션 (W3 F16 → W5 멀티 프로바이더). 키 입력 상태를 이 컴포넌트 안에만 두는 것이 의도다 —
// 드로어 props 나 상위 스토어로 올리면 저장된 키가 렌더러 상태 트리에 남는다.
//
// ⚠️ 저장된 키를 되읽어 표시하지 않는다. 마스킹된 형태(sk-ant-…)조차 그리지 않는다 —
// 접두사 몇 글자도 로그·스크린샷으로 새어 나가면 의미가 있는 정보다(설계 §2). 프로바이더별로
// vault 에 분리 저장되므로 hasKey 도 "현재 선택된 프로바이더"의 것만 보여준다.
function AiSection({
  prefs,
  onPrefsChange,
  ask
}: {
  prefs: UiPrefs
  onPrefsChange: (patch: Partial<UiPrefs>) => void
  ask?: (spec: DialogSpec) => Promise<DialogResult>
}) {
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [usage, setUsage] = useState({ input: 0, output: 0 })
  const [turnCount, setTurnCount] = useState(0)
  const [result, setResult] = useState<AiKeyResult | null>(null)
  const [busy, setBusy] = useState(false)

  const provider = prefs.aiProvider
  const model = prefs.aiModels[provider]

  const refresh = () =>
    window.ev?.ai
      .getState()
      .then((s) => {
        setHasKey(s.hasKey)
        setUsage(s.usage)
        setTurnCount(s.turns.length)
      })
      .catch(() => {})
  // provider 가 바뀌면 그 프로바이더의 키 보유 여부를 다시 읽는다(hasKey 는 provider 별로 분리 저장).
  useEffect(() => void refresh(), [provider])

  const save = async (value: string) => {
    setBusy(true)
    const res = (await window.ev?.ai.setKey(value).catch(() => null)) ?? null
    setBusy(false)
    setResult(res)
    // 성공하면 입력 필드를 즉시 비운다 — 드로어를 다시 열었을 때 키가 남아 있지 않게.
    if (res?.ok) setKey('')
    await refresh()
  }

  // 프로바이더 전환 시 대화가 초기화된다는 것을 확인 다이얼로그로 명시한다(설계 W5 §보안 — 모델 간
  // 컨텍스트 이월은 혼란·비용만 만든다). 대화가 비어 있으면(잃을 게 없으면) 묻지 않는다.
  const switchProvider = async (next: AiProvider) => {
    if (next === provider) return
    if (turnCount > 0) {
      const r = ask
        ? await ask({
            title: t('ai.provider.switch.title'),
            message: `${AI_PROVIDER_LABELS[provider]} → ${AI_PROVIDER_LABELS[next]}. ${t('ai.provider.switch.msg')}`,
            confirmLabel: t('ai.provider.switch.btn'),
            cancelLabel: t('dlg.cancel')
          })
        : 'confirm'
      if (r !== 'confirm') return
      await window.ev?.ai.clear()
      setTurnCount(0)
      setResult(null)
    }
    setKey('')
    onPrefsChange({ aiProvider: next })
  }

  const baseUrl = prefs.aiCompatibleBaseUrl
  const baseUrlCheck = provider === 'compatible' ? validateBaseUrl(baseUrl) : null
  // 설정 UI에 현재 어디로 전송되는지 호스트를 상시 표시한다(설계 W5 §보안 — 사용자가 자기도 모르게
  // 낯선 곳으로 보내지 않게). compatible 은 사용자 입력에서 파싱, 나머지는 고정 호스트.
  const host =
    provider === 'compatible'
      ? baseUrlCheck?.ok
        ? baseUrlCheck.url.host
        : baseUrl
          ? t('settings.ai.baseUrl.invalid')
          : t('settings.ai.baseUrl.unset')
      : AI_PROVIDER_HOSTS[provider]

  return (
    <>
      <Row label={t('settings.ai.provider')} desc={t('settings.ai.provider.desc')}>
        <Seg value={provider} options={AI_PROVIDERS} onChange={(v) => void switchProvider(v)} labelKey={(v) => 'settings.ai.provider.' + v} />
      </Row>

      {provider === 'compatible' && (
        <Row label={t('settings.ai.baseUrl')} desc={t('settings.ai.baseUrl.desc')}>
          <input
            type="text"
            className="ai-key-input"
            data-field="ai.baseUrl"
            spellCheck={false}
            placeholder="https://openrouter.ai/api/v1"
            value={baseUrl}
            onChange={(e) => onPrefsChange({ aiCompatibleBaseUrl: e.target.value })}
          />
          {baseUrl && !baseUrlCheck?.ok && <div className="ai-baseurl-err">{baseUrlCheck?.message}</div>}
        </Row>
      )}

      <Row label={t('settings.ai.key')} desc={t('settings.ai.key.desc')}>
        <div className="ai-key-ctl">
          <input
            type="password"
            className="ai-key-input"
            data-field="ai.key"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('settings.ai.key.placeholder')}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button type="button" className="btn" data-action="ai.key.save" disabled={busy || !key.trim()} onClick={() => void save(key)}>
            {t('settings.ai.key.save')}
          </button>
          <button
            type="button"
            className="btn sec"
            data-action="ai.key.delete"
            disabled={busy || !hasKey}
            // 빈 문자열 저장이 곧 삭제다(전용 채널 없음 — 계약을 하나로 유지한다).
            onClick={() => void save('')}
          >
            {t('settings.ai.key.delete')}
          </button>
        </div>
      </Row>
      <div className="ai-key-state" data-state={hasKey ? 'has' : 'none'}>
        <span>{hasKey ? t('settings.ai.key.saved') : t('settings.ai.key.none')}</span>
        {result && (
          <span className={'ai-key-badge' + (result.ok ? ' ok' : ' err')}>
            {result.ok ? t('settings.ai.key.ok') : t('settings.ai.key.fail.' + result.reason)}
          </span>
        )}
      </div>

      <Row label={t('settings.ai.model')} desc={t('settings.ai.model.desc')}>
        <ModelPicker provider={provider} value={model} onChange={(v) => onPrefsChange({ aiModels: { ...prefs.aiModels, [provider]: v } })} />
      </Row>
      <Row label={t('settings.ai.usage')} desc={t('settings.ai.usage.desc')}>
        <span className="v">
          {t('ai.usage.in')} {usage.input.toLocaleString('ko-KR')} / {t('ai.usage.out')}{' '}
          {usage.output.toLocaleString('ko-KR')}
        </span>
      </Row>
      {/* 이 문장은 장식이 아니다 — 사내 배포에서 데이터 반출 고지가 화면에 없으면 안 된다(설계 §4.7).
          W5: 선택된 프로바이더 이름·호스트가 들어가게 갱신 — "Anthropic API로 전송됩니다" 고정 문구는
          이제 거짓이 될 수 있다(설계 W5 §보안). */}
      <div className="set-note" data-note="ai.export">
        {t('settings.ai.note.prefix')}
        {AI_PROVIDER_LABELS[provider]} API({host}){t('settings.ai.note.suffix')}
      </div>
    </>
  )
}

// [MCP] 섹션 (W4 F23). AI 키 섹션과 같은 절제 원칙: 발급된 토큰 원문을 이 컴포넌트 밖(상위 상태·
// workspace.json)으로 올리지 않는다 — 발급 응답에서 받은 그 순간에만 화면에 잠깐 보여주고, 다시
// 드로어를 열면 사라져 있다(재조회 채널이 계약에 없다 — mcp:getToken 부재).
function McpSection() {
  const [state, setState] = useState<McpState | null>(null)
  const [busy, setBusy] = useState(false)
  const [freshToken, setFreshToken] = useState<string | null>(null)

  const refresh = () => window.ev?.mcp.getState().then(setState).catch(() => {})
  useEffect(() => {
    void refresh()
    const off = window.ev?.mcp.onStateChanged(setState)
    return () => off?.()
  }, [])

  const toggle = async (on: boolean) => {
    setBusy(true)
    await window.ev?.mcp.setEnabled(on).catch(() => {})
    setBusy(false)
    await refresh()
  }

  const issueToken = async () => {
    setBusy(true)
    const res = await window.ev?.mcp.issueToken().catch(() => null)
    setBusy(false)
    if (res) setFreshToken(res.token) // 이 응답에만 존재한다 — 여기서만 화면에 보여준다.
    await refresh()
  }

  if (!state) return null

  return (
    <>
      <Row label={t('settings.mcp.enable')} desc={t('settings.mcp.enable.desc')}>
        <Toggle on={state.enabled} label={t('settings.mcp.enable')} onChange={(v) => void toggle(v)} />
      </Row>
      {state.enabled && (
        <>
          <Row label={t('settings.mcp.port')} desc={t('settings.mcp.port.desc')}>
            <span className="v" data-field="mcp.port">
              127.0.0.1:{state.port}
            </span>
          </Row>
          <Row label={t('settings.mcp.token')} desc={t('settings.mcp.token.desc')}>
            <div className="ai-key-ctl">
              <input
                type="text"
                className="ai-key-input"
                data-field="mcp.token"
                readOnly
                autoComplete="off"
                spellCheck={false}
                value={freshToken ?? ''}
                placeholder={state.hasToken ? t('settings.mcp.token.saved') : t('settings.mcp.token.none')}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" className="btn" data-action="mcp.token.issue" disabled={busy} onClick={() => void issueToken()}>
                {t('settings.mcp.token.issue')}
              </button>
            </div>
          </Row>
          {freshToken && <div className="set-note">{t('settings.mcp.token.warn')}</div>}
          <Row label={t('settings.mcp.connected')} desc={t('settings.mcp.connected.desc')}>
            <div className="ai-key-ctl">
              <span className="v" data-field="mcp.connected">
                {state.connected}
              </span>
              <button
                type="button"
                className="btn sec"
                data-action="mcp.disconnect"
                disabled={busy || state.connected === 0}
                onClick={() => void window.ev?.mcp.disconnectClient().then(refresh)}
              >
                {t('settings.mcp.disconnect')}
              </button>
            </div>
          </Row>
        </>
      )}
      <div className="set-note" data-note="mcp.scope">
        {t('settings.mcp.note')}
      </div>
    </>
  )
}

type Props = {
  open: boolean
  font: FontConfig
  prefs: UiPrefs
  version: string
  onClose: () => void
  onChange: (patch: Partial<FontConfig>) => void
  onPrefsChange: (patch: Partial<UiPrefs>) => void
  // W5: 프로바이더 전환 확인 다이얼로그(대화 초기화 경고). MainArea 가 이미 들고 있는 Shell 의
  // 단일 다이얼로그 인스턴스를 그대로 받는다(호스트키 확인 등과 같은 재사용 — 새 다이얼로그를 만들지 않는다).
  ask?: (spec: DialogSpec) => Promise<DialogResult>
  // FB-monitor(FB-0004): [단축키] 섹션의 "tmux 사용법 보기" → 명령어 북(F18)을 그 카테고리로 바로 연다.
  onOpenCommandBook?: (query?: string) => void
}

export function SettingsDrawer({
  open,
  font,
  prefs,
  version,
  onClose,
  onChange,
  onPrefsChange,
  ask,
  onOpenCommandBook
}: Props) {
  const [section, setSection] = useState<SettingsSection>('general')

  return (
    <div className={'drawer' + (open ? ' open' : '')} role="dialog" aria-label={t('settings.title')}>
      <div className="drawer-hd">
        <div className="dh-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3.5" />
            <path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3L4.9 4.9M19.1 19.1l-1.4-1.4M17.7 6.3l1.4-1.4M4.9 19.1l1.4-1.4" />
          </svg>
        </div>
        <div>
          <h2>{t('settings.title')}</h2>
          <p>{t('settings.subtitle')}</p>
        </div>
        <span className="x" title={t('settings.close')} onClick={onClose}>
          <IconClose />
        </span>
      </div>

      <div className="drawer-body">
        <div className="set-nav" role="tablist">
          {SETTINGS_SECTIONS.map((s) => (
            <span
              key={s}
              role="tab"
              aria-selected={section === s}
              data-section={s}
              className={section === s ? 'on' : undefined}
              onClick={() => setSection(s)}
            >
              {t('settings.nav.' + s)}
            </span>
          ))}
        </div>

        <div className="set-pane" role="tabpanel">
          {/* 섹션 제목은 좌측 nav 가 이미 달고 있다 — 안에서 한 번 더 쓰지 않는다(하위 구분만 .set-sec-t). */}
          {section === 'general' && (
            <>
              {/* UI-font5: 글자 크기를 우리가 한 번 더 추측하지 않고 쓰는 사람이 고른다.
                  터미널 글자는 이 배율을 타지 않는다 — [터미널] 섹션에 자체 크기 슬라이더가 있다. */}
              <Row label={t('settings.uiScale')} desc={t('settings.uiScale.desc')}>
                <Seg
                  value={prefs.uiScale}
                  options={UI_SCALES}
                  onChange={(uiScale) => onPrefsChange({ uiScale })}
                  labelKey={(v) => 'ui.scale.' + v}
                />
              </Row>
              {/* 2026-08-13 준영님 요청: 우측 바에 기능이 박혀 있는 것을 껐다 켜고 순서도 바꾼다. */}
              <Row label={t('settings.activity')} desc={t('settings.activity.desc')}>
                <div className="act-cfg">
                  {prefs.activityOrder.map((id, i) => {
                    const shown = !prefs.activityHidden.includes(id)
                    const move = (delta: -1 | 1): void =>
                      onPrefsChange({ activityOrder: moveActivity(prefs.activityOrder, id, delta) })
                    return (
                      <div className={'act-cfg-row' + (shown ? '' : ' off')} key={id} data-activity={id}>
                        <span className="acr-name">{t(ACTIVITY_TITLE_KEY[id])}</span>
                        <button
                          type="button"
                          className="acr-move"
                          data-action="up"
                          aria-label={t('settings.activity.up')}
                          title={t('settings.activity.up')}
                          disabled={i === 0}
                          onClick={() => move(-1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="acr-move"
                          data-action="down"
                          aria-label={t('settings.activity.down')}
                          title={t('settings.activity.down')}
                          disabled={i === prefs.activityOrder.length - 1}
                          onClick={() => move(1)}
                        >
                          ↓
                        </button>
                        <Toggle
                          on={shown}
                          label={t(ACTIVITY_TITLE_KEY[id])}
                          onChange={() =>
                            onPrefsChange({ activityHidden: toggleActivityHidden(prefs.activityHidden, id) })
                          }
                        />
                      </div>
                    )
                  })}
                </div>
              </Row>
              <Row label={t('settings.copyOnSelect')} desc={t('settings.copyOnSelect.desc')}>
                <Toggle
                  on={prefs.copyOnSelect}
                  label={t('settings.copyOnSelect')}
                  onChange={(copyOnSelect) => onPrefsChange({ copyOnSelect })}
                />
              </Row>
              <Row label={t('settings.scrollback')} desc={t('settings.scrollback.desc')}>
                <div className="row">
                  <input
                    type="range"
                    min={SCROLLBACK_MIN}
                    max={SCROLLBACK_MAX}
                    step={SCROLLBACK_STEP}
                    value={prefs.scrollback}
                    aria-label={t('settings.scrollback')}
                    onChange={(e) => onPrefsChange({ scrollback: Number(e.target.value) })}
                  />
                  <span className="v">{prefs.scrollback.toLocaleString('ko-KR')}</span>
                </div>
              </Row>
            </>
          )}

          {section === 'terminal' && (
            <>
              <Row label={t('settings.cursorStyle')} desc={t('settings.cursorStyle.desc')}>
                <Seg
                  value={prefs.cursorStyle}
                  options={CURSOR_STYLES}
                  onChange={(cursorStyle) => onPrefsChange({ cursorStyle })}
                  labelKey={(v) => 'settings.cursor.' + v}
                />
              </Row>
              <Row label={t('settings.cursorBlink')} desc={t('settings.cursorBlink.desc')}>
                <Toggle
                  on={prefs.cursorBlink}
                  label={t('settings.cursorBlink')}
                  onChange={(cursorBlink) => onPrefsChange({ cursorBlink })}
                />
              </Row>
              <Row label={t('settings.bell')} desc={t('settings.bell.desc')}>
                <Seg
                  value={prefs.bell}
                  options={BELL_STYLES}
                  onChange={(bell) => onPrefsChange({ bell })}
                  labelKey={(v) => 'settings.bell.' + v}
                />
              </Row>
            </>
          )}

          {section === 'font' && (
            <>
              {/* 폰트 비교 스트립 — 동일 한글 문장을 후보별로 나란히 */}
              <div className="font-compare">
                <div className="fc-title">{t('settings.compare.title')}</div>
                <div className="fc-strip">
                  {COMPARE_ROWS.map((r) => (
                    <div className={'fc-row' + (r.best ? ' fc-best' : '')} key={r.label}>
                      <div className="fc-label">
                        <b>{r.label}</b>
                        {r.source}
                      </div>
                      <div className="fc-text" style={{ fontFamily: r.stack }}>
                        {r.note ? `${COMPARE_TEXT} — ${r.note}` : COMPARE_TEXT}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* UI-font4: 한글만 OS 기본 한글 폰트(Tabby 재현)로 그릴지 — 기본 켜짐, 되돌리기 가능. */}
              <Row label={t('settings.krFallback')} desc={t('settings.krFallback.desc')}>
                <Toggle
                  on={font.krSystemFallback ?? true}
                  label={t('settings.krFallback')}
                  onChange={(krSystemFallback) => onChange({ krSystemFallback })}
                />
              </Row>

              {/* 터미널 폰트 선택(라디오) — UI-font: 선택은 --term뿐 아니라 --mono(UI 전체)에도 적용된다. */}
              <div className="set-sec-t">{t('settings.pick.title')}</div>
              <div className="set-sec-d">{t('settings.pick.desc')}</div>
              <div className="font-list">
                {FONT_OPTIONS.map((o) => (
                  <div
                    className={'font-item' + (font.term === o.key ? ' sel' : '')}
                    key={o.key}
                    onClick={() => onChange({ term: o.key })}
                  >
                    <span className="radio" />
                    <div className="fi-main">
                      <div className="fi-name">
                        {o.label} <span className={'fi-tag' + (o.tagSys ? ' sys' : '')}>{o.tag}</span>
                      </div>
                      <div className="fi-desc">{o.desc}</div>
                    </div>
                    <span className="fi-sample" style={{ fontFamily: o.stack }}>
                      가Ag
                    </span>
                  </div>
                ))}
              </div>

              {/* 크기(10–20px) + 행간 슬라이더 */}
              <div className="set-sec-t">{t('settings.preview.title')}</div>
              <div className="fp-controls">
                <div className="cg">
                  <label>{t('settings.size')}</label>
                  <div className="row">
                    <input
                      type="range"
                      min={SIZE_MIN}
                      max={SIZE_MAX}
                      value={font.sizePx}
                      onChange={(e) => onChange({ sizePx: Number(e.target.value) })}
                      aria-label={t('settings.size')}
                    />
                    <span className="v">{font.sizePx}px</span>
                  </div>
                </div>
                <div className="cg">
                  <label>{t('settings.lineHeight')}</label>
                  <div className="row">
                    <input
                      type="range"
                      min={LH_MIN}
                      max={LH_MAX}
                      step={LH_STEP}
                      value={font.lineHeight}
                      onChange={(e) => onChange({ lineHeight: Number(e.target.value) })}
                      aria-label={t('settings.lineHeight')}
                    />
                    <span className="v">{font.lineHeight.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* 실사용 한글 미리보기 (터미널 출력 형태) */}
              <div className="preview-box">
                <div className="pb-hd">
                  <span className="sb-dot" />
                  deploy@dev-server · {font.term} {font.sizePx}px
                </div>
                <div
                  className="pb-body"
                  style={{
                    fontFamily: stackFor(font.term, font.krSystemFallback ?? true),
                    fontSize: `${font.sizePx}px`,
                    lineHeight: font.lineHeight
                  }}
                >
                  {PREVIEW_LINES.map((l, i) => (
                    <span className={'pv-ln ' + l.cls} key={i}>
                      {l.text}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}

          {section === 'log' && (
            <>
              {/* 기본 off — 사내 DLP 환경에서 모든 원격 세션 출력을 묻지 않고 디스크에 남기지 않는다. */}
              <Row label={t('settings.sessionLog')} desc={t('settings.sessionLog.desc')}>
                <Toggle
                  on={prefs.sessionLog}
                  label={t('settings.sessionLog')}
                  onChange={(sessionLog) => onPrefsChange({ sessionLog })}
                />
              </Row>
              <Row label={t('settings.logRetention')} desc={t('settings.logRetention.desc')}>
                <Seg
                  value={String(prefs.logRetentionDays)}
                  options={RETENTION_VALUES}
                  onChange={(v) => onPrefsChange({ logRetentionDays: Number(v) })}
                  labelKey={(v) => 'settings.retention.' + v}
                />
              </Row>
              <Row label={t('settings.logFolder')} desc={t('settings.logFolder.desc')}>
                <button
                  type="button"
                  className="btn sec"
                  data-action="log.reveal"
                  onClick={() => void window.ev?.sessionLog.reveal()}
                >
                  {t('settings.logFolder.btn')}
                </button>
              </Row>
              <div className="set-note">{t('settings.log.note')}</div>
            </>
          )}

          {section === 'ai' && <AiSection prefs={prefs} onPrefsChange={onPrefsChange} ask={ask} />}

          {section === 'mcp' && <McpSection />}

          {section === 'keys' && (
            <>
              <div className="set-note">{t('settings.keys.note')}</div>
              {/* FB-monitor(FB-0004): tmux 를 처음 쓰는 사용자를 위한 진입점 — 명령어 북(F18)의
                  tmux 카테고리로 바로 연다. 새 도움말 화면을 만들지 않고 기존 검색형 치트시트를 재사용. */}
              <Row label={t('settings.keys.tmux')} desc={t('settings.keys.tmux.desc')}>
                <button
                  type="button"
                  className="btn sec"
                  data-action="cmdbook.open.tmux"
                  onClick={() => onOpenCommandBook?.('tmux')}
                >
                  {t('settings.keys.tmux.btn')}
                </button>
              </Row>
              {KEY_GROUPS.map((g) => {
                const rows = KEYMAP.filter((b) => b.implemented && g.cats.includes(b.category))
                if (rows.length === 0) return null
                return (
                  <div className="set-keys" key={g.title}>
                    <div className="sk-title">{g.title}</div>
                    {rows.map((b) => (
                      <div className="cs-row" key={b.action}>
                        <span className="cs-desc">{b.labelKo}</span>
                        <span className="cs-keys">
                          {(isMac ? b.mac : b.win).split('+').map((c, i) => (
                            <Fragment key={i}>
                              {i > 0 && <span className="cs-sep">+</span>}
                              <span className="cs-k">{c}</span>
                            </Fragment>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </>
          )}

          {section === 'about' && (
            <>
              <Row label={t('app.name')} desc={t('about.msg')}>
                <span className="v">v{version}</span>
              </Row>


              {/* OFL 라이선스 고지 (GAP-OFL) */}
              <div className="set-sec-t">{t('settings.license.title')}</div>
              <div className="license-list">
                {LICENSES.map((l) => (
                  <div className="license-row" key={l.name}>
                    <div className="lic-name">{l.name}</div>
                    <div className="lic-meta">
                      {l.copyright} · <span className="lic-ofl">SIL Open Font License 1.1</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="set-note">{t('settings.license.note')}</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
