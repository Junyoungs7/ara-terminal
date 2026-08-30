import { AI_ENTRY, VOICE } from '@shared/features'
import { callNameOf } from '@shared/araPersona'
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
import type { UpdateState } from '@shared/ipc'
import { validateBaseUrl } from '../../shared/aiBaseUrl'
import { WAKE_WORDS } from '@shared/voice'
import { AI_CLI_IDS, AI_CLIS, toggleFlag, type AiCliId } from '../../shared/aiCli'
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

// 2026-08-28: 음성은 숨김(features.VOICE) — 목록에서 아예 빼서 탭도 본문도 안 생긴다.
export const SETTINGS_SECTIONS = (
  ['general', 'terminal', 'font', 'log', 'ai', 'voice', 'mcp', 'keys', 'about'] as const
).filter((s) => VOICE || s !== 'voice') as readonly SettingsSectionAll[]
type SettingsSectionAll = 'general' | 'terminal' | 'font' | 'log' | 'ai' | 'voice' | 'mcp' | 'keys' | 'about'
export type SettingsSection = SettingsSectionAll

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

function Toggle({
  on,
  label,
  onChange,
  disabled
}: {
  on: boolean
  label: string
  onChange: (v: boolean) => void
  /** 조건이 안 갖춰져 켤 수 없는 스위치(2026-08-27 음성 — 키가 없을 때). 이유는 옆 문장이 말한다. */
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={'set-toggle' + (on ? ' on' : '') + (disabled ? ' locked' : '')}
      role="switch"
      aria-checked={on}
      aria-disabled={disabled === true}
      aria-label={label}
      onClick={() => !disabled && onChange(!on)}
    >
      <span className="st-knob" />
    </button>
  )
}

// 항목 하나 = 제목 → 설명 → 컨트롤(위에서 아래로). 준영님 피드백(2026-08-13)으로 배치를 통일했다 —
// 그전엔 컨트롤이 오른쪽 끝에 붙어 있어, 설명이 길면 제목과 짝이 안 읽혔다.
// 예전 `stack` 예외(넓은 컨트롤만 아래로)는 이제 전부가 그 배치라 사라졌다.
/**
 * 폴더 하나를 고르는 줄(2026-08-23 설정 [기록 폴더]).
 *
 * **경로를 직접 타이핑하게 두지 않는다** — 오타 난 경로는 "안 써지는데 이유를 모르는" 상태가
 * 된다. OS 폴더 선택 창으로만 정하고(fs.pickDir), 지금 어디로 가는지는 늘 보여 준다.
 * 빈 값 = 기본 자리라 그 경로는 main 에게 물어 온다(그 자리는 main 만 안다).
 */
/**
 * #98 업데이트 — 설정 [일반]의 마지막 줄.
 *
 * 여기서만 보여 준다(배너·모달 없음). 업데이트는 **뒤에서 받아 두고 다음 실행 때** 적용되므로
 * 하던 일을 끊고 알릴 이유가 없다. 개발 모드(status: 'off')에서는 줄 자체를 숨긴다 — 있어 봐야
 * 늘 "확인 불가"만 뜬다.
 */
function UpdateRow() {
  const [st, setSt] = useState<UpdateState>({ status: 'off' })
  useEffect(() => {
    void window.ev?.app
      ?.updateState?.()
      .then(setSt)
      .catch(() => {})
    return window.ev?.app?.onUpdateState?.(setSt)
  }, [])
  if (st.status === 'off') return null
  // `available` 은 **busy 가 아니다** — 새 버전을 찾아 두고 안 받은 상태에서도 다시 확인할 수 있어야
  // 한다. 여기에 넣으면 버튼이 영영 잠긴다(AUDIT-R2 ③ — check() 가드와 같은 이유).
  const busy = st.status === 'checking' || st.status === 'downloading'
  const detail =
    st.status === 'available'
      ? t('settings.update.available').replace('{v}', st.version ?? '')
      : st.status === 'downloading'
        ? t('settings.update.downloading').replace('{v}', st.version ?? '').replace('{p}', String(st.percent ?? 0))
        : st.status === 'ready'
          ? t('settings.update.ready').replace('{v}', st.version ?? '')
          : st.status === 'checking'
            ? t('settings.update.checking')
            : st.status === 'error'
              ? t('settings.update.error') + ' — ' + (st.message ?? '')
              : t('settings.update.idle')
  return (
    <Row label={t('settings.update')} desc={t('settings.update.desc')}>
      <div className="set-dir">
        <span className="set-dir-path" data-update-status={st.status} title={detail}>
          {detail}
        </span>
        <button
          type="button"
          className="btn sec"
          data-action="update.check"
          disabled={busy}
          onClick={() => void window.ev?.app?.updateCheck?.()}
        >
          {t('settings.update.check')}
        </button>
        {st.status === 'available' && (
          <button
            type="button"
            className="btn"
            data-action="update.download"
            onClick={() => void window.ev?.app?.updateDownload?.()}
          >
            {t('settings.update.download')}
          </button>
        )}
        {st.status === 'ready' && (
          <button
            type="button"
            className="btn"
            data-action="update.install"
            onClick={() => void window.ev?.app?.updateInstall?.()}
          >
            {t('settings.update.install')}
          </button>
        )}
      </div>
    </Row>
  )
}

function DirRow({
  label,
  desc,
  value,
  onChange
}: {
  label: string
  desc: string
  value: string
  onChange: (next: string) => void
}) {
  const [effective, setEffective] = useState('')
  useEffect(() => {
    void window.ev?.app
      ?.logPaths?.()
      .then((p) => setEffective(label === t('settings.dir.session') ? p.sessionLogDir : p.appLogDir))
      .catch(() => {})
  }, [value, label])
  return (
    <Row label={label} desc={desc}>
      <div className="set-dir">
        <span className="set-dir-path" title={effective}>
          {effective || t('settings.dir.loading')}
          {!value && <span className="set-dir-tag">{t('settings.dir.default')}</span>}
        </span>
        <button
          type="button"
          className="btn sec"
          data-action="dir.pick"
          onClick={() => void window.ev?.fs?.pickDir?.().then((d) => d && onChange(d))}
        >
          {t('settings.dir.pick')}
        </button>
        <button type="button" className="btn sec" data-action="dir.reset" disabled={!value} onClick={() => onChange('')}>
          {t('settings.dir.reset')}
        </button>
      </div>
    </Row>
  )
}

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
/**
 * [음성] — 말로 아라를 부르는 설정(2026-08-27 준영님).
 *
 * **키가 없으면 켤 수 없다.** 받아쓰기·읽어 주기가 둘 다 API 를 쓰기 때문인데, 스위치를 그냥
 * 회색으로 두면 "왜 안 되지"가 된다 — 잠근 채로 **왜 잠겼고 어디서 푸는지**를 그 자리에 적는다.
 */
function VoiceSection({
  prefs,
  onPrefsChange
}: {
  prefs: UiPrefs
  onPrefsChange: (patch: Partial<UiPrefs>) => void
}) {
  const [ready, setReady] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void window.ev?.voice
      .ready()
      .then((r) => alive && setReady(r.ok))
      .catch(() => alive && setReady(false))
    return () => {
      alive = false
    }
  }, [])
  const set = (patch: Partial<UiPrefs['voice']>): void => onPrefsChange({ voice: { ...prefs.voice, ...patch } })
  const locked = ready === false

  return (
    <>
      <Row label={t('settings.voice.on')} desc={t('settings.voice.on.desc')}>
        <Toggle
          on={prefs.voice.on && !locked}
          label={t('settings.voice.on')}
          disabled={locked}
          onChange={(on) => set({ on })}
        />
      </Row>
      {locked && <div className="voice-note">{t('settings.voice.noKey')}</div>}
      <Row label={t('settings.voice.wake')} desc={t('settings.voice.wake.desc')}>
        <select className="sel" value={prefs.voice.wake} onChange={(e) => set({ wake: e.target.value })}>
          {WAKE_WORDS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t('settings.voice.tts')} desc={t('settings.voice.tts.desc')}>
        <select className="sel" value={prefs.voice.ttsVoice} onChange={(e) => set({ ttsVoice: e.target.value })}>
          {TTS_VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.ko}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t('settings.voice.speak')} desc={t('settings.voice.speak.desc')}>
        <Toggle on={prefs.voice.speakBack} label={t('settings.voice.speak')} onChange={(speakBack) => set({ speakBack })} />
      </Row>
      <div className="voice-note">{t('settings.voice.privacy')}</div>
    </>
  )
}

/** OpenAI 목소리. 한글 이름은 들어 본 인상이 아니라 **성별·톤**만 적는다(과장하지 않는다). */
const TTS_VOICES = [
  { id: 'alloy', ko: '차분한 중성' },
  { id: 'nova', ko: '밝은 여성' },
  { id: 'shimmer', ko: '부드러운 여성' },
  { id: 'onyx', ko: '낮은 남성' },
  { id: 'echo', ko: '담담한 남성' }
] as const

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

  /**
   * 0.1.0: **아라 대화는 숨긴다**(features.AI_ENTRY). 이 섹션에서 프로바이더·키·모델·사용량은
   * 대화 기능의 설정이라 함께 사라지고, **AI CLI 시작**(원격 claude·codex·gemini)의 플래그만 남는다 —
   * 그쪽은 대화가 아니라 터미널 기능이라 계속 쓰인다.
   *
   * #126 부터 `ARA_CHAT` 도 이 문을 연다. 아라 대화 v2 의 **폴백이 API 키 엔진**이라, 여기를 닫아
   * 두면 "API 키로 쓰기"를 눌러도 키를 넣을 자리가 없다 — 갈 곳 없는 버튼이 된다.
   */
  if (!AI_ENTRY) {
    return (
      <>
        <div className="set-note" data-note="ai.hidden">
          {t('settings.ai.hidden')}
        </div>
        <div className="set-sec-t" data-sec="ai.cli">
          {t('settings.ai.cliSec')}
        </div>
        <div className="set-sec-d">{t('settings.ai.cliSec.desc')}</div>
        <AiCliFlagRows prefs={prefs} onPrefsChange={onPrefsChange} />
      </>
    )
  }

  return (
    <>
      {/* #138 호칭 — 엔진과 무관하다(Claude Code 든 API 든 아라는 같은 이름으로 부른다).
          그래서 프로바이더보다 위, 이 섹션의 첫 줄이다. */}
      <Row label={t('settings.ai.call')} desc={t('settings.ai.call.desc')}>
        <input
          type="text"
          className="ai-key-input"
          data-field="ai.callName"
          maxLength={20}
          spellCheck={false}
          placeholder={t('welcome.placeholder')}
          value={prefs.araCallName}
          onChange={(e) => onPrefsChange({ araCallName: callNameOf(e.target.value) })}
        />
      </Row>
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
      {/* 2026-08-23 준영님 제보: "키를 저장했는데 연결됐는지 아무것도 안 뜬다."
          검증은 늘 하고 있었지만 **확인하는 동안 화면이 조용했다** — 사내망에서 프로바이더까지
          왕복이 몇 초 걸리면 사용자는 아무 일도 안 일어난 것으로 읽는다. 진행 중을 먼저 말한다. */}
      <div className="ai-key-state" data-state={busy ? 'checking' : hasKey ? 'has' : 'none'}>
        <span>{busy ? t('settings.ai.key.checking') : hasKey ? t('settings.ai.key.saved') : t('settings.ai.key.none')}</span>
        {busy && <span className="ai-key-spin" aria-hidden="true" />}
        {!busy && result && (
          <span className={'ai-key-badge' + (result.ok ? ' ok' : ' err')}>
            {result.ok ? t('settings.ai.key.ok') : t('settings.ai.key.fail.' + result.reason)}
          </span>
        )}
        {!busy && !result && !hasKey && <span className="ai-key-hint">{t('settings.ai.key.hint')}</span>}
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
      <div className="set-sec-t" data-sec="ai.cli" style={{ marginTop: 18 }}>
        {t('settings.ai.cliSec')}
      </div>
      <div className="set-sec-d">{t('settings.ai.cliSec.desc')}</div>
      <AiCliFlagRows prefs={prefs} onPrefsChange={onPrefsChange} />
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

/**
 * AI CLI 기본 플래그 (2026-08-20 · A-79).
 *
 * 우클릭 [AI 실행 ▸] 이 **최근에 쓴 조합이 없을 때** 붙일 플래그다. 시작 창을 없애면서
 * (2026-08-18) 플래그를 고르는 화면이 통째로 사라졌는데, 준영님 PC 는 최근 목록에 조합이 남아
 * 있어 티가 안 났다 — **새로 설치한 동료는 맨몸 `claude`** 로 떴다.
 *
 * 플래그가 있는 CLI 만 줄이 뜬다(2026-08-23 부터 claude·codex·gemini 셋). 표에 플래그를 더하면
 * 줄이 저절로 생긴다 — 여기에 CLI 이름을 다시 적지 않는다.
 *
 * `--dangerously-skip-permissions` 를 기본으로 켜 두는 것은 가벼운 결정이 아니다. 카탈로그가
 * 그렇게 정해 뒀고 준영님이 늘 쓰시는 조합이지만, **끌 자리가 있어야 켜 둘 수 있다** — 이 줄이
 * 그 자리다. 설명 문구에 무엇을 끄는 플래그인지 적어 둔다.
 */
/** 플래그가 있는 CLI 만 고를 수 있다 — custom 은 사용자가 직접 적는 것이라 표가 없다. */
const FLAGGED_CLIS = AI_CLI_IDS.filter((cli) => AI_CLIS[cli].flags.length > 0)

/**
 * AI CLI 기본 플래그(2026-08-25 준영님 요청으로 **하나씩** 보이게 고쳤다).
 *
 * 전에는 세 CLI 의 플래그가 한꺼번에 세 줄로 깔려 있었다. 그 줄들은 서로 무관한데 같이 보여서
 * "지금 어느 것을 고치는 중인가"가 흐렸다 — 위 프로바이더처럼 **세그먼트로 하나만** 본다.
 *
 * 세그먼트를 **프로바이더에 묶지 않은** 이유: 다른 축이다. 서버에서 `codex` 를 띄우면서 아라 대화의
 * API 는 anthropic 일 수 있다. 묶어 두면 한쪽을 고치려다 다른 쪽이 따라 바뀐다.
 */
function AiCliFlagRows({ prefs, onPrefsChange }: { prefs: UiPrefs; onPrefsChange: (p: Partial<UiPrefs>) => void }) {
  const [cli, setCli] = useState<AiCliId>(FLAGGED_CLIS[0] ?? 'claude')
  const set = (flags: string[]) => onPrefsChange({ aiCliFlags: { ...prefs.aiCliFlags, [cli]: flags } })
  const on = prefs.aiCliFlags[cli] ?? []
  return (
    <>
      <Row label={t('settings.ai.cliPick')} desc={t('settings.ai.cliPick.desc')}>
        <Seg value={cli} options={FLAGGED_CLIS} onChange={setCli} labelKey={(v) => 'settings.ai.cli.' + v} />
      </Row>
      <Row label={`${t('settings.ai.cliFlags')} — ${AI_CLIS[cli].bin}`} desc={t('settings.ai.cliFlags.desc')}>
        <div className="cliflags">
          {AI_CLIS[cli].flags.map((f) => (
            <label key={f.id} className="cliflag" data-flag={`${cli}.${f.id}`}>
              <input
                type="checkbox"
                checked={on.includes(f.id)}
                // 배타 그룹(-r/-c)은 toggleFlag 가 처리한다 — 여기서 또 해석하지 않는다.
                onChange={() => set(toggleFlag(cli, on, f.id))}
              />
              <span>{t(f.labelKey)}</span>
              <code>{f.arg}</code>
            </label>
          ))}
        </div>
      </Row>
    </>
  )
}

// [MCP] 섹션 (W4 F23). AI 키 섹션과 같은 절제 원칙: 발급된 토큰 원문을 이 컴포넌트 밖(상위 상태·
// workspace.json)으로 올리지 않는다 — 발급 응답에서 받은 그 순간에만 화면에 잠깐 보여주고, 다시
// 드로어를 열면 사라져 있다(재조회 채널이 계약에 없다 — mcp:getToken 부재).
function McpSection({ ask }: { ask?: (spec: DialogSpec) => Promise<DialogResult> }) {
  const [state, setState] = useState<McpState | null>(null)
  const [busy, setBusy] = useState(false)
  const [freshToken, setFreshToken] = useState<string | null>(null)

  const refresh = () => window.ev?.mcp.getState().then(setState).catch(() => {})
  useEffect(() => {
    void refresh()
    const off = window.ev?.mcp.onStateChanged(setState)
    return () => off?.()
  }, [])

  /**
   * 끄기 전에 **무엇을 잃는지** 말한다(2026-08-26 준영님 지시).
   *
   * 이 토글은 겉보기에 "서버 하나 끄기"지만 실제로는 **아라의 손을 자르는 일**이다 — 우리 도구에
   * 닿는 길이 이것뿐이라, 끈 채로 아라에게 시키면 아라는 밖에서 방법을 찾거나(로컬 셸·다른 MCP)
   * 못 한다고 답한다. 켜는 쪽은 묻지 않는다(되돌리는 방향이라 놀랄 일이 없다).
   */
  const toggle = async (on: boolean) => {
    if (!on && ask) {
      const r = await ask({
        title: t('settings.mcp.off.title'),
        message: t('settings.mcp.off.msg'),
        confirmLabel: t('settings.mcp.off.btn'),
        cancelLabel: t('dlg.cancel'),
        tone: 'danger'
      })
      if (r !== 'confirm') return
    }
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

  /**
   * **AI 키가 아직 없으면 [AI] 섹션으로 열린다** (2026-08-22 준영님 제보 8번).
   *
   * 이 드로어는 언마운트되지 않고 `open` 클래스만 토글되므로 마지막에 보던 섹션이 그대로 남는다 —
   * 평소엔 그게 맞지만, 키를 아직 안 넣은 사람에게는 **첫 할 일이 그것**이라 그 자리를 스스로
   * 찾아가게 두지 않는다. 키가 한 번이라도 저장되면 이 분기는 다시는 타지 않는다(기존 동작 복귀).
   * 열릴 때 한 번만 묻는다 — 드로어가 떠 있는 동안 사용자가 고른 섹션을 빼앗지 않기 위해서다.
   */
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.ev?.ai
      .getState()
      .then((s) => {
        if (alive && AI_ENTRY && !s.hasKey) setSection('ai')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open])

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
        <button type="button" className="x" title={t('settings.close')} onClick={onClose}>
          <IconClose />
        </button>
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
              {/* #139 켤 때 인사. 멋은 한 번이고 방해는 매일이라 **끌 수 있어야** 한다. */}
              <Row label={t('settings.bootSplash')} desc={t('settings.bootSplash.desc')}>
                <Toggle
                  on={prefs.bootSplash}
                  label={t('settings.bootSplash')}
                  onChange={(bootSplash) => onPrefsChange({ bootSplash })}
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
              <UpdateRow />
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

              {/* 터미널 폰트 선택(라디오) — 2026-08-21 부터 **--term 하나만** 바꾼다.
                  앱 화면 글꼴(--ui Pretendard · --mono 나눔고딕코딩)은 고정이고 설정에 없다. */}
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
              {/* 2026-08-23 준영님 요청 — 어디에 쌓을지 고른다. 둘로 나눈 이유는 성격이 달라서다:
                  세션 기록은 크고 사람이 열어 보는 것, 앱 로그는 문제 생겼을 때만 보는 진단용. */}
              <DirRow
                label={t('settings.dir.session')}
                desc={t('settings.dir.session.desc')}
                value={prefs.sessionLogDir}
                onChange={(sessionLogDir) => onPrefsChange({ sessionLogDir })}
              />
              <DirRow
                label={t('settings.dir.app')}
                desc={t('settings.dir.app.desc')}
                value={prefs.appLogDir}
                onChange={(appLogDir) => onPrefsChange({ appLogDir })}
              />
              <div className="set-note">{t('settings.log.note')}</div>
            </>
          )}

          {section === 'ai' && <AiSection prefs={prefs} onPrefsChange={onPrefsChange} ask={ask} />}
          {section === 'voice' && <VoiceSection prefs={prefs} onPrefsChange={onPrefsChange} />}

          {section === 'mcp' && <McpSection ask={ask} />}

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
