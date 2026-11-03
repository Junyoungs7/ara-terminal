import { AI_ENTRY, FEATURES } from '@shared/features'
import { callNameOf } from '@shared/araPersona'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { PasswordInput } from './PasswordInput'
import {
  AI_MODELS_BY_PROVIDER,
  AI_PROVIDER_HOSTS,
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  UI_SCALES,
  MOUSE_CURSORS,
  DEFAULT_MOUSE_CURSOR,
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
import type { DiagProbeStatus, GpuInfo, UpdateState } from '@shared/ipc'
import { validateBaseUrl } from '../../shared/aiBaseUrl'
import { FONT_OPTIONS, stackFor } from '../terminal/fontStacks'
import { termRenderer } from '../terminal/webglChoice'
import { writeClipboard } from '../store/clipboardWrite'
import { forgetCachedScope } from '../store/history'
import { CODE_NOTICES, LICENSES } from '../fonts/licenses'
import { KEYMAP, keyText, comboFromEvent, lockShortcutProblem, type KeymapCategory } from '../../shared/keymap'
import { AUTO_LOCK_OPTIONS, LOCK_MIN_PASSWORD, type LockResult } from '@shared/lock'
import { useLockView } from '../store/lock'
import { OtpInput } from './LockScreen'
import qrcode from 'qrcode-generator'
import { CURSOR_KINDS, cursorSrc, cursorValue } from '../cursorThemes'
import { CHANGELOG_URL, MANUAL_URL } from '@shared/links'
import type { DialogResult, DialogSpec } from './Dialog'
import { Dropdown } from './Dropdown'
import { ArrowLeft, Check, Clock, KeyRound, Mic, Play, Search, ShieldAlert } from 'lucide-react'
import { VOICES, VOICE_FACES, VOICE_KEEP, VOICE_LISTEN, VOICE_SPEEDS } from '@shared/voice'
import { openMic, listMics, type MicHandle } from '../voice/audio'
import { previewVoice, setBypass, useVoice } from '../store/voice'
import { SETTINGS_INDEX, searchSettings, sectionDef, type SettingsSection } from '@shared/settingsIndex'
import { editorPrefsOf, type DiffView } from '@shared/editorPrefs'
import type { SettingsTarget } from '../store/settingsNav'
import { TermExtraRows, UpdateChannelRow } from './TermExtraSettings'
// M3 에이전트 설정 — AI 작업 공간 청크(지연 로드). 이 진입점 밖의 aiws 파일은 직접 import 하지 않는다(feature-module.md).
import { AgentSettings } from '../features/aiws'
import { ManagedServers } from '../features/managed'
import { UsageSettings } from '../features/usage'
import { AutomationsSettings, McpServersSettings, SkillsSettings } from '../features/automations'
import { GitLabSettings, SlackSettings } from '../features/integrations'

// 설정 페이지 (F5 드로어 → 2.0 가운데 창 → M1 1-A **전체 화면 + 검색**, 시안 SW-final 설정 장면).
// 묶음·섹션·항목 목록은 shared/settingsIndex.ts 한 곳에 있다(검색·딥링크가 그 표를 읽는다).
// 닫아도 언마운트하지 않는다(open 클래스만 토글 — 보던 섹션 유지). 각 섹션의 `open` 은 그래서 필요하다.
//
// 슬라이더 범위(계획서 C-5 확정): 크기 10–20px, 행간 1.3–2.0.
// R3.7 Ctrl+휠 확대/축소도 같은 범위를 쓴다(슬라이더와 값이 어긋나면 안 된다).
export const SIZE_MIN = 10
export const SIZE_MAX = 20
const LH_MIN = 1.3
const LH_MAX = 2.0
const LH_STEP = 0.02


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
// 설정 열(720)은 치트시트보다 좁아 4열 대신 카테고리 한 덩어리씩 세로로 쌓는다.
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
const DIFF_VIEWS: readonly DiffView[] = ['inline', 'side-by-side']

// 세그먼트 컨트롤(연결 관리자 인증 방식과 같은 .seg-ctl) — 값이 2~3개인 선택지에 쓴다.
function Seg<T extends string>({
  value,
  options,
  onChange,
  labelKey,
  field
}: {
  value: T
  options: readonly T[]
  onChange: (v: T) => void
  labelKey: (v: T) => string
  /**
   * 이 세그먼트가 무엇을 고르는지(입력칸의 `data-field` 와 같은 규칙 — 스모크가 이걸로 집는다).
   *
   * 왜 필요한가: `.seg-ctl` 만 보고 집으면 **같은 섹션에 세그먼트가 하나 더 생기는 날** 조용히
   * 엉뚱한 것을 센다. [AI] 섹션에서 실제로 그랬다 — AI CLI 고르기 세그먼트가 프로바이더 검사에
   * 섞여 들어갔다(#150).
   */
  field?: string
}) {
  return (
    <div className="seg-ctl" data-field={field}>
      {options.map((o) => (
        <button type="button" key={o} className={value === o ? 'on' : ''} onClick={() => onChange(o)} data-value={o}>
          {t(labelKey(o))}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  on,
  label,
  onChange,
  disabled
}: {
  on: boolean
  label: string
  onChange: (v: boolean) => void
  /** 조건이 안 갖춰져 켤 수 없는 스위치. 이유는 옆 문장이 말한다. */
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
  // 개발 모드 — [업데이트] 가 섹션 하나가 되어 빈 칸으로 두지 않는다(예전엔 [일반] 끝 줄이라 숨겼다).
  if (st.status === 'off') return <div className="set-note" data-item="update">{t('settings.update.off')}</div>
  // `available` 은 **busy 가 아니다** — 새 버전을 찾아 두고 안 받은 상태에서도 다시 확인할 수 있어야
  // 한다. 여기에 넣으면 버튼이 영영 잠긴다(AUDIT-R2 ③ — check() 가드와 같은 이유).
  // 맥: 확인·받기 버튼 없이 안내 문장만.
  if (st.status === 'manual')
    return (
      <Row label={t('settings.update')} item="update">
        <div className="set-dir">
          <span className="set-dir-path is-msg" data-update-status="manual">
            {t('settings.update.manual')}
          </span>
        </div>
      </Row>
    )
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
    <Row label={t('settings.update')} item="update">
      <div className="set-dir">
        {/* 경로가 아니라 **문장**이다 — .is-msg 가 경로용 rtl·말줄임·고정폭을 되돌린다
            (2026-09-04: 그게 없어 "…다 — [받기]를 누르세요 1.0.0" 으로 보였다). */}
        <span className="set-dir-path is-msg" data-update-status={st.status} title={detail}>
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
  item,
  value,
  onChange,
  resolve
}: {
  label: string
  desc: string
  item: string
  value: string
  onChange: (next: string) => void
  /** 지금 실제로 쓰이는 자리를 main 에게 묻는다. 없으면 기록 폴더 둘(logPaths) 중 하나. */
  resolve?: () => Promise<string>
}) {
  const [effective, setEffective] = useState('')
  useEffect(() => {
    const ask =
      resolve ??
      (() =>
        window.ev.app
          .logPaths()
          .then((p) => (label === t('settings.dir.session') ? p.sessionLogDir : p.appLogDir)))
    void Promise.resolve()
      .then(ask)
      .then(setEffective)
      .catch(() => {})
    // resolve 는 렌더마다 새 함수라 의존성에서 뺀다 — 값이 바뀔 때만 다시 묻는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, label])
  return (
    <Row label={label} desc={desc} item={item}>
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

export function Row({ label, desc, item, children }: { label: string; desc?: string; item?: string; children: React.ReactNode }) {
  return (
    <div className="set-row" data-item={item}>
      <div className="sr-main">
        <div className="sr-label">{label}</div>
        {desc && <div className="sr-desc">{desc}</div>}
      </div>
      <div className="sr-ctl">{children}</div>
    </div>
  )
}

/**
 * M15 R2 TM-04 macOS 로컬 네트워크(Orca 설정 › 개발자 권한의 Local Network 줄 + 연결 시험). 맥에서만 그린다.
 * macOS 는 권한 상태를 앱에 알려 주지 않는다 — [권한 요청]으로 창을 띄우고, 안 뜨면 [시스템 설정 열기], 됐는지는 [시험]으로 본다.
 */
function LocalNetworkRow() {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [msg, setMsg] = useState('')
  const test = async () => {
    setMsg(t('settings.localNet.testing'))
    const r = await window.ev.localNetwork.test(host, Number(port))
    setMsg(r.ok ? t('settings.localNet.ok') : t('settings.localNet.fail.' + (r.failure ?? 'failed')))
  }
  return (
    <Row label={t('settings.localNet')} desc={t('settings.localNet.desc')}>
      <div className="row">
        <button type="button" className="btn sec" data-action="localNet.request" onClick={() => void window.ev.localNetwork.request().then(() => setMsg(t('settings.localNet.requested')))}>
          {t('settings.localNet.request')}
        </button>
        <button type="button" className="btn sec" data-action="localNet.open" onClick={() => void window.ev.localNetwork.openSettings()}>
          {t('settings.localNet.open')}
        </button>
      </div>
      <div className="row">
        <input type="text" className="ai-key-input" data-field="localNet.host" spellCheck={false} placeholder="192.168.0.10" value={host} onChange={(e) => setHost(e.target.value)} />
        <input type="text" className="ai-key-input" data-field="localNet.port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        <button type="button" className="btn" data-action="localNet.test" disabled={!host.trim()} onClick={() => void test()}>
          {t('settings.localNet.test')}
        </button>
      </div>
      {msg && <div className="sr-desc" role="status">{msg}</div>}
    </Row>
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
// 설정 페이지 props 나 상위 스토어로 올리면 저장된 키가 렌더러 상태 트리에 남는다.
//
// ⚠️ 저장된 키를 되읽어 표시하지 않는다. 마스킹된 형태(sk-ant-…)조차 그리지 않는다 —
// 접두사 몇 글자도 로그·스크린샷으로 새어 나가면 의미가 있는 정보다(설계 §2). 프로바이더별로
// vault 에 분리 저장되므로 hasKey 도 "현재 선택된 프로바이더"의 것만 보여준다.
// M1 1-A: AI CLI 줄(훅·CLI 기본 플래그)은 AI 작업 공간 › 에이전트로 갔다. 여기는 전역 › 아라 채팅.
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
    // 성공하면 입력 필드를 즉시 비운다 — 설정 페이지를 다시 열었을 때 키가 남아 있지 않게.
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
      {/* #138 호칭 — 엔진과 무관하다(Claude Code 든 API 든 아라는 같은 이름으로 부른다).
          그래서 프로바이더보다 위, 이 섹션의 첫 줄이다. */}
      <Row label={t('settings.ai.call')} desc={t('settings.ai.call.desc')} item="ai.callName">
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
      <Row label={t('settings.ai.provider')} desc={t('settings.ai.provider.desc')} item="ai.provider">
        <Seg
          value={provider}
          options={AI_PROVIDERS}
          onChange={(v) => void switchProvider(v)}
          labelKey={(v) => 'settings.ai.provider.' + v}
          field="ai.provider"
        />
      </Row>

      {provider === 'compatible' && (
        <Row label={t('settings.ai.baseUrl')} desc={t('settings.ai.baseUrl.desc')} item="ai.baseUrl">
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

      <Row label={t('settings.ai.key')} desc={t('settings.ai.key.desc')} item="ai.key">
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

      <Row label={t('settings.ai.model')} desc={t('settings.ai.model.desc')} item="ai.model">
        <ModelPicker provider={provider} value={model} onChange={(v) => onPrefsChange({ aiModels: { ...prefs.aiModels, [provider]: v } })} />
      </Row>
      <Row label={t('settings.ai.usage')} desc={t('settings.ai.usage.desc')} item="ai.usage">
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
// 설정 페이지를 열면 사라져 있다(재조회 채널이 계약에 없다 — mcp:getToken 부재).
// 잠금 결과 → 한 줄 안내. 비밀번호 값은 어디에도 남기지 않는다(보낸 뒤 칸을 비운다).
function lockMsg(r: LockResult): string {
  if (r.ok) return ''
  if (r.reason === 'wait') return t('lock.wait').replace('{s}', String(Math.ceil((r.waitMs ?? 0) / 1000)))
  if (r.reason === 'weak') return t('lock.rule.len').replace('{n}', String(LOCK_MIN_PASSWORD))
  return t(r.reason === 'wrong' ? 'lock.wrong' : 'settings.sec.fail')
}

/**
 * 설정 › 보안 — 2.0 앱 잠금(시안 mockups/v2/L-settings). 상태의 주인은 main(AppLock)이고 여기는 그리기·요청만 한다.
 * 비밀번호 칸은 버튼을 누를 때만 펼친다: 켜기(두 번) · 끄기(현재) · 바꾸기(현재 + 새 두 번).
 */
function SecuritySection({ open, ask }: { open: boolean; ask?: (spec: DialogSpec) => Promise<DialogResult> }) {
  const v = useLockView()
  const on = !!v && v.state !== 'off'
  type Form = 'enable' | 'disable' | 'change' | null
  const [form, setForm] = useState<Form>(null)
  const [cur, setCur] = useState('')
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [capture, setCapture] = useState(false)
  const [otp, setOtp] = useState<{ secret: string; uri: string } | null>(null)
  const [code, setCode] = useState('')
  // 이 PC 에서 못 푸는 저장값 개수(main 은 개수만 준다). 섹션을 열 때·잠금 상태가 바뀔 때(켜기 직후 포함) 다시 센다.
  const [bad, setBad] = useState(0)
  const lockState = v?.state
  const countBad = useCallback(() => {
    void window.ev?.lock
      ?.unreadable()
      .then(setBad)
      .catch(() => setBad(0))
  }, [])
  useEffect(() => {
    if (open) countBad()
  }, [open, lockState, countBad])
  // 확인 다이얼로그가 없으면(하네스) 지우지 않는다 — HistorySection.wipe 와 같다.
  const clearBad = async (): Promise<void> => {
    if (!ask) return
    const r = await ask({
      title: t('settings.sec.bad.title'),
      message: t('settings.sec.bad.msg').replace('{n}', String(bad)),
      tone: 'danger',
      confirmLabel: t('settings.sec.bad.clear'),
      cancelLabel: t('dlg.cancel')
    })
    if (r !== 'confirm') return
    const res = await window.ev.lock.clearUnreadable().catch((): LockResult => ({ ok: false, reason: 'state' }))
    setMsg(lockMsg(res))
    countBad()
  }

  const clear = (): void => {
    setCur('')
    setP1('')
    setP2('')
  }
  // 설정 페이지를 닫으면 펼친 칸·받아 둔 OTP 비밀을 버린다(다시 열면 처음부터).
  useEffect(() => {
    if (open) return
    clear()
    setForm(null)
    setOtp(null)
    setCode('')
    setCapture(false)
    setMsg('')
  }, [open])

  // 단축키 바꾸기 — 누른 키를 **다른 리스너보다 먼저**(window 캡처) 가로챈다: 안 그러면 Ctrl+Shift+T 같은
  // 키가 바꾸는 동안 새 세션을 연다. Esc = 취소.
  useEffect(() => {
    if (!capture) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') return setCapture(false)
      const combo = comboFromEvent(e)
      if (!combo) return
      const bad = lockShortcutProblem(combo)
      setCapture(false)
      if (bad) return setMsg(t('settings.sec.key.' + bad).replace('{k}', keyText(combo)))
      setMsg('')
      void window.ev.lock.setPrefs({ shortcut: combo })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capture])

  const run = async (fn: () => Promise<LockResult>): Promise<void> => {
    setBusy(true)
    const r = await fn().catch((): LockResult => ({ ok: false, reason: 'state' }))
    setBusy(false)
    clear()
    setMsg(lockMsg(r))
    if (r.ok) setForm(null)
  }

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (busy) return
    if ((form === 'enable' || form === 'change') && p1 !== p2) return setMsg(t('lock.rule.same'))
    if (form === 'enable') void run(() => window.ev.lock.enable(p1))
    if (form === 'disable') void run(() => window.ev.lock.disable(cur))
    if (form === 'change') void run(() => window.ev.lock.change(cur, p1))
  }

  const qrUrl = (() => {
    if (!otp) return ''
    const q = qrcode(0, 'M')
    q.addData(otp.uri)
    q.make()
    return q.createDataURL(4, 2)
  })()

  const beginOtp = async (): Promise<void> => {
    setMsg('')
    setCode('')
    setOtp(await window.ev.lock.otpBegin().catch(() => null))
  }
  const confirmOtp = async (): Promise<void> => {
    const r = await window.ev.lock.otpConfirm(code).catch((): LockResult => ({ ok: false, reason: 'state' }))
    setCode('')
    if (r.ok) {
      setOtp(null)
      setMsg('')
    } else setMsg(r.reason === 'wrong' ? t('lock.forgot.wrongOtp') : lockMsg(r))
  }

  if (!v) return <div className="set-note">{t('settings.sec.na')}</div>
  const changed = v.changedAt ? new Date(v.changedAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }) : ''
  const needTwo = form === 'enable' || form === 'change'
  const needCur = form === 'disable' || form === 'change'

  return (
    <>
      <div className="set-note">{t('settings.sec.note')}</div>
      <div className="set-note sec-keep">{t('settings.sec.keep')}</div>
      {bad > 0 && (
        <Row label={t('settings.sec.bad').replace('{n}', String(bad))}>
          <button type="button" className="btn sec" data-action="lock.clearUnreadable" disabled={!ask} onClick={() => void clearBad()}>
            {t('settings.sec.bad.clear')}
          </button>
        </Row>
      )}
      <div className="set-sec-t">{t('settings.sec.lock')}</div>
      <Row label={t('settings.sec.use')} desc={t('settings.sec.use.desc')} item="sec.use">
        <Toggle
          on={on}
          label={t('settings.sec.use')}
          onChange={(want) => {
            clear()
            setMsg('')
            setForm(want ? 'enable' : 'disable')
          }}
        />
      </Row>
      {form && (
        <form className="sec-form" onSubmit={submit} data-form={form}>
          {needCur && (
            <PasswordInput value={cur} onChange={setCur} placeholder={t('settings.sec.cur')} ariaLabel={t('settings.sec.cur')} autoFocus />
          )}
          {needTwo && (
            <>
              <PasswordInput value={p1} onChange={setP1} placeholder={t('lock.forgot.new')} ariaLabel={t('lock.forgot.new')} autoFocus={!needCur} />
              <PasswordInput value={p2} onChange={setP2} placeholder={t('lock.forgot.again')} ariaLabel={t('lock.forgot.again')} />
              <div className="lock-cap">{t('lock.rule.len').replace('{n}', String(LOCK_MIN_PASSWORD))}</div>
            </>
          )}
          <div className="row">
            <button type="button" className="btn sec" onClick={() => (clear(), setForm(null), setMsg(''))}>
              {t('dlg.cancel')}
            </button>
            <button
              type="submit"
              className="btn pri"
              disabled={busy || (needCur && !cur) || (needTwo && (!p1 || !p2))}
              data-action={'lock.' + form}
            >
              {t('settings.sec.go.' + form)}
            </button>
          </div>
        </form>
      )}
      {msg && (
        <div className="set-note sec-msg" role="status">
          {msg}
        </div>
      )}
      <Row item="sec.pw" label={t('settings.sec.pw')} desc={on ? t('settings.sec.pw.set').replace('{d}', changed) : t('settings.sec.pw.none')}>
        <button type="button" className="btn sec" disabled={!on} onClick={() => (clear(), setMsg(''), setForm('change'))}>
          {t('settings.sec.pw.change')}
        </button>
      </Row>
      <Row label={t('settings.sec.key')} desc={t('settings.sec.key.desc')} item="sec.key">
        <div className="row">
          <kbd className="kbd">{capture ? t('settings.sec.key.press') : keyText(v.shortcut)}</kbd>
          <button type="button" className="btn sec" disabled={!on} onClick={() => (setMsg(''), setCapture((c) => !c))}>
            {t(capture ? 'dlg.cancel' : 'settings.sec.key.change')}
          </button>
        </div>
      </Row>
      <Row label={t('settings.sec.auto')} desc={t('settings.sec.auto.desc')} item="sec.auto">
        <Seg
          value={String(v.autoLockMin)}
          options={AUTO_LOCK_OPTIONS.map(String)}
          onChange={(m) => on && void window.ev.lock.setPrefs({ autoLockMin: Number(m) })}
          labelKey={(m) => (m === '0' ? 'settings.sec.auto.off' : 'settings.sec.auto.min.' + m)}
          field="autoLock"
        />
      </Row>
      <div className="set-sec-t" data-item="sec.otp">
        {t('settings.sec.otp')} <span className="sec-otp-st">{t(v.otp ? 'settings.sec.otp.on' : 'settings.sec.otp.off')}</span>
      </div>
      {!otp && (
        <Row label={t('settings.sec.otp.reg')} desc={t('settings.sec.otp.note')}>
          <button type="button" className="btn sec" disabled={v.state !== 'unlocked'} onClick={() => void beginOtp()}>
            {t(v.otp ? 'settings.sec.otp.again' : 'settings.sec.otp.start')}
          </button>
        </Row>
      )}
      {otp && (
        <div className="sec-otp">
          <img className="sec-qr" src={qrUrl} alt={t('settings.sec.otp.qr')} />
          <ol className="sec-steps">
            <li>{t('settings.sec.otp.s1')}</li>
            <li>
              {t('settings.sec.otp.s2')}
              <div className="row">
                <code className="sec-key">{otp.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                <button type="button" className="btn sec" onClick={() => void writeClipboard(otp.secret)}>
                  {t('settings.sec.otp.copy')}
                </button>
              </div>
            </li>
            <li>
              {t('settings.sec.otp.s3')}
              <div className="row">
                <OtpInput value={code} onChange={setCode} label={t('settings.sec.otp.s3')} />
                <button type="button" className="btn pri" disabled={code.length !== 6} onClick={() => void confirmOtp()}>
                  {t('settings.sec.otp.confirm')}
                </button>
              </div>
            </li>
          </ol>
          <div className="set-note">{t('settings.sec.otp.note')}</div>
        </div>
      )}
    </>
  )
}

function McpSection({ ask }: { ask?: (spec: DialogSpec) => Promise<DialogResult> }) {
  // 잠긴 동안 외부 도구 허용 — 값의 주인은 잠금(lock.json)이지만 자리는 외부 도구다(대응표 4-3).
  const lock = useLockView()
  const lockOn = !!lock && lock.state !== 'off'
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
      <Row label={t('settings.mcp.enable')} desc={t('settings.mcp.enable.desc')} item="mcp.enable">
        <Toggle on={state.enabled} label={t('settings.mcp.enable')} onChange={(v) => void toggle(v)} />
      </Row>
      {state.enabled && (
        <>
          <Row label={t('settings.mcp.port')} desc={t('settings.mcp.port.desc')} item="mcp.port">
            <span className="v" data-field="mcp.port">
              127.0.0.1:{state.port}
            </span>
          </Row>
          <Row label={t('settings.mcp.token')} desc={t('settings.mcp.token.desc')} item="mcp.token">
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
          <Row label={t('settings.mcp.connected')} desc={t('settings.mcp.connected.desc')} item="mcp.connected">
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
      {lock && (
        <Row label={t('settings.sec.mcp')} desc={t('settings.sec.mcp.desc')} item="sec.mcp">
          <Toggle
            on={lock.mcpWhileLocked}
            label={t('settings.sec.mcp')}
            disabled={!lockOn}
            onChange={(mcpWhileLocked) => void window.ev.lock.setPrefs({ mcpWhileLocked })}
          />
        </Row>
      )}
      <div className="set-note" data-note="mcp.scope">
        {t('settings.mcp.note')}
      </div>
    </>
  )
}

/**
 * #190 터미널 렌더러 — **이 라운드는 고치는 행이 아니라 재는 행이다.**
 *
 * 2026-09-07 사내 제보(타이핑 딜레이 · tmux 로 빠르게 PgUp/PgDn 할 때 사각형이 깜빡인다)의 첫
 * 후보가 WebGL 렌더러인데, 앱은 자기가 무엇으로 그리는지 화면에 한 글자도 안 보여 줬다 —
 * 제보자 PC 가 진짜 GPU 를 쓰는지 소프트웨어 래스터라이저 위에 있는지 물어볼 방법조차 없었다.
 * 그래서 셋을 한 줄에 모은다: **실제로 실린 렌더러**(프로브 값이 아니다) · 프로브가 읽은 GPU
 * 이름 · main 이 아는 GPU 상태(`app:gpuInfo`).
 *
 * **복사 버튼이 이 행의 절반이다.** 스크린샷을 다시 청하는 왕복이 없어야 제보가 한 번에 끝난다 —
 * 화면에는 요약만 두고(긴 GPU 이름이 줄을 밀지 않게 desc 로 흘린다), 붙여 줄 것에는 features
 * 전체와 앱 버전·UA 까지 담는다. 형식을 손으로 짜지 않고 JSON 그대로 두는 이유도 그것이다 —
 * 항목을 고르면 나중에 하나가 빠져도 아무도 모른다.
 *
 * 판정을 고치는 것은 이 라운드가 아니다(webglChoice.ts 의 🔴 주석 참고).
 */
function GpuRow({ open, version }: { open: boolean; version: string }) {
  const [gpu, setGpu] = useState<GpuInfo | null>(null)
  // **열릴 때마다** 묻는다(#162 — 이 설정 페이지는 언마운트되지 않으므로
  // 마운트 한 번에 한 번은 곧 "기동 직후 한 번"이고, 그때는 터미널조차 아직 없다).
  useEffect(() => {
    if (!open) return
    void window.ev?.app
      ?.gpuInfo?.()
      .then(setGpu)
      .catch(() => {})
  }, [open])
  const unknown = t('settings.gpu.unknown')
  const kind =
    termRenderer.kind === null ? t('settings.gpu.noTerm') : termRenderer.kind === 'webgl' ? 'WebGL' : 'DOM'
  // 프로브가 읽은 이름이 먼저다(판정이 그걸 보고 했으니까). 확장이 막혀 비면 main 이 본 이름으로
  // 떨어진다 — 그 자리가 바로 이 라운드가 알고 싶은 PC 다. 둘 다 복사본에는 따로 들어간다.
  const desc = t('settings.gpu.desc')
    .replace('{gpu}', termRenderer.gpu || gpu?.gl.renderer || unknown)
    .replace('{webgl2}', gpu?.features['webgl2'] ?? unknown)
  return (
    <Row label={t('settings.gpu.title')} desc={desc} item="gpu">
      <div className="ai-key-ctl">
        <span className="v" data-field="gpu.renderer">
          {kind}
        </span>
        <button
          type="button"
          className="btn sec"
          data-action="gpu.copy"
          onClick={() =>
            void writeClipboard(
              JSON.stringify({ version, ua: navigator.userAgent, renderer: termRenderer, gpu }, null, 2),
              true
            )
          }
        >
          {t('settings.gpu.copy')}
        </button>
      </div>
    </Row>
  )
}

/**
 * M0 FD-03 진단 프로브 — main 이벤트 루프 지연을 1초마다 앱 로그 폴더 event-loop-delay.ndjson 에 남긴다.
 * 켜 둔 동안은 마지막 1초 창을 설명 자리에 보여 준다. 저장하지 않는다(재시작하면 꺼짐 — 켜 둔 채 잊지 않게).
 */
function ProbeRow({ open }: { open: boolean }) {
  const [st, setSt] = useState<DiagProbeStatus | null>(null)
  // 설정 페이지는 언마운트되지 않는다(GpuRow 주석) — 열려 있는 동안만 1초마다 묻는다.
  useEffect(() => {
    if (!open) return
    const read = (): void => void window.ev?.app?.probe?.().then(setSt).catch(() => {})
    read()
    const id = setInterval(read, 1000)
    return () => clearInterval(id)
  }, [open])
  const last = st?.on ? st.last : null
  const desc = last
    ? t('settings.probe.last')
        .replace('{p50}', String(last.p50))
        .replace('{p99}', String(last.p99))
        .replace('{max}', String(last.max))
        .replace('{elu}', String(Math.round(last.elu * 100)))
    : t('settings.probe.desc')
  return (
    <Row label={t('settings.probe.title')} desc={desc} item="probe">
      <Toggle
        on={st?.on === true}
        label={t('settings.probe.title')}
        onChange={(v) => void window.ev?.app?.probe?.(v).then(setSt).catch(() => {})}
      />
    </Row>
  )
}

/**
 * [명령 기록] 섹션 (#204). **지울 길**을 준다 — 지금까지는 `history.json` 을 손으로 여는 것
 * 말고는 없었다.
 *
 * 🔴 **내용은 그리지 않는다.** 통 이름과 줄 수뿐이다. 프롬프트에 그냥 친 비밀번호가 여기 섞여
 * 있을 수 있는데(그것이 이 기능이 생긴 이유다), 지우자고 그 줄들을 화면에 한 번 더 펼치면
 * 문제를 옮겨 놓는 것밖에 안 된다. 직접 보실 분을 위해 파일 자리만 한 줄 적는다.
 *
 * ⚠️ 에이전트 탭의 통(`AGENT_SCOPE`)은 이 목록에 **안 나온다** — 디스크에 간 적이 없어 main 이 그 이름을 모른다.
 *    그래서 "지울 것이 없다"는 사실을 아래 안내 한 줄로 대신 말한다.
 */
function HistorySection({ ask, open }: { ask?: (spec: DialogSpec) => Promise<DialogResult>; open: boolean }) {
  const [info, setInfo] = useState<{ path: string; scopes: { scope: string; count: number }[] } | null>(null)

  const refresh = (): Promise<void> =>
    window.ev?.history?.scopes().then(setInfo).catch(() => {}) ?? Promise.resolve()
  // 설정 페이지는 언마운트되지 않으므로(열림 클래스만 토글) 열릴 때마다 다시 센다 — 그사이 쌓인 줄이 있다.
  useEffect(() => {
    if (open) void refresh()
  }, [open])

  /**
   * scope 를 안 주면 전부 지운다.
   *
   * 🔴 되돌릴 수 없어 **무엇을 지우는지 이름으로** 확인받는다(`MainArea.destroySessions` 와 같은 모양).
   * 확인 다이얼로그가 없으면(하네스) 아예 지우지 않는다 — 조용히 지르는 쪽으로 기울지 않는다.
   * 🔴 디스크를 지운 **뒤 렌더러 캐시도 버린다.** 안 그러면 고스트가 지운 명령을 계속 제안하고,
   *    다음 명령 한 줄에 캐시 전체가 디스크로 되살아난다(forgetCachedScope 주석).
   */
  const wipe = async (scope?: string): Promise<void> => {
    const targets = scope ? [scope] : (info?.scopes ?? []).map((s) => s.scope)
    if (targets.length === 0 || !ask) return
    const r = await ask({
      title: t('settings.hist.clear.title'),
      message: t('settings.hist.clear.msg'),
      detail: targets.map((s) => ({ label: t('settings.hist.clear.target'), value: s })),
      tone: 'danger',
      confirmLabel: t('settings.hist.clear.confirm'),
      cancelLabel: t('dlg.cancel')
    })
    if (r !== 'confirm') return
    await window.ev?.history?.clear(scope).catch(() => {})
    forgetCachedScope(scope)
    await refresh()
  }

  const scopes = info?.scopes ?? []
  return (
    <>
      <div className="set-note">{t('settings.hist.note')}</div>
      {scopes.length === 0 && <div className="set-note">{t('settings.hist.empty')}</div>}
      {scopes.map((s) => (
        <Row key={s.scope} label={s.scope} desc={`${s.count}${t('settings.hist.lines')}`}>
          <button type="button" className="btn sec" data-action="hist.clear" onClick={() => void wipe(s.scope)}>
            {t('settings.hist.clear')}
          </button>
        </Row>
      ))}
      {scopes.length > 0 && (
        <Row label={t('settings.hist.clearAll')} desc={t('settings.hist.clearAll.desc')} item="hist.clearAll">
          <button type="button" className="btn sec" data-action="hist.clearAll" onClick={() => void wipe()}>
            {t('settings.hist.clearAll')}
          </button>
        </Row>
      )}
      <div className="set-note">{t('settings.hist.ai')}</div>
      {info && <div className="set-note">{t('settings.hist.path')} {info.path}</div>}
    </>
  )
}

/** VS-c 의 한 줄 행 — 이름 · 설명 · (오른쪽) 컨트롤. 음성 칸만 이 모양이다(시안 그대로). */
function Fr({ name, desc, item, children }: { name: string; desc?: string; item?: string; children: React.ReactNode }) {
  return (
    <div className="vs-fr" data-item={item}>
      <span className="nm">{name}</span>
      <span className="ds">{desc ?? ''}</span>
      <span className="ctl">{children}</span>
    </div>
  )
}

const LEVEL_BARS = 20
const voiceLabel = (name: string): string => {
  const v = VOICES.find((x) => x.name === name)
  return v ? `${v.name} · ${v.ko}` : name
}
const minutesText = (sec: number): string => {
  const m = Math.floor(sec / 60)
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}${t('settings.voice.h')} ${m % 60}${t('settings.voice.m')}` : `${m}${t('settings.voice.m')}`
}

/**
 * 2.1 설정 › 음성 — 시안 VS-c(왼쪽 미리보기 + 오른쪽 한 줄 행) 그대로.
 * 얼굴 그림은 다음 라운드라 미리보기 자리는 비어 있고, 고른 값만 저장한다.
 * bypass 는 prefs 가 아니다 — main 메모리 값(앱 재시작 시 꺼짐)이라 voice store 를 거친다.
 */
function VoiceSection({
  prefs,
  onPrefsChange,
  ask,
  open,
  goAi
}: {
  prefs: UiPrefs
  onPrefsChange: (p: Partial<UiPrefs>) => void
  ask?: (spec: DialogSpec) => Promise<DialogResult>
  open: boolean
  goAi: () => void
}) {
  const v = prefs.voice
  const set = (p: Partial<typeof v>): void => onPrefsChange({ voice: { ...v, ...p } })
  const { bypass } = useVoice()
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [usage, setUsage] = useState<{ seconds: number; by: 'tokens' | 'time'; low: number; high: number } | null>(null)
  const [mics, setMics] = useState<{ id: string; label: string }[]>([])
  const [rms, setRms] = useState(0)
  const [micErr, setMicErr] = useState(false)

  useEffect(() => {
    if (!open) return
    void window.ev?.voice?.state().then((s) => setHasKey(s.hasKey)).catch(() => {})
    void window.ev?.voice?.usage().then(setUsage).catch(() => {})
  }, [open])

  // 입력 레벨 — 이 칸이 보이는 동안만 마이크를 연다(소리는 어디로도 보내지 않는다).
  useEffect(() => {
    if (!open) return
    let alive = true
    let h: MicHandle | null = null
    setMicErr(false)
    openMic(v.inputDeviceId, () => {}, (x) => alive && setRms(x))
      .then((m) => {
        if (alive) h = m
        else m.stop()
        return listMics()
      })
      .then((l) => alive && setMics(l))
      .catch(() => alive && setMicErr(true))
    return () => {
      alive = false
      h?.stop()
    }
  }, [open, v.inputDeviceId])

  const db = rms > 0 ? Math.max(-60, Math.round(20 * Math.log10(rms))) : -60
  const lit = Math.round(((db + 60) / 60) * LEVEL_BARS)
  const defaultMic = t('settings.voice.mic.default')
  const micOptions = [defaultMic, ...mics.map((m) => m.label || m.id.slice(0, 8))]
  const micAt = mics.findIndex((m) => m.id === v.inputDeviceId)
  const micValue = micAt >= 0 ? micOptions[micAt + 1] : defaultMic
  const key = KEYMAP.find((k) => k.action === 'voice.toggle')

  const flipBypass = async (on: boolean): Promise<void> => {
    if (on) {
      // 확인 창이 없으면(하네스) 켜지 않는다 — 위험한 쪽으로 조용히 기울지 않는다.
      if (!ask) return
      const r = await ask({
        title: t('settings.voice.bypass.ask.title'),
        message: t('settings.voice.bypass.ask.msg'),
        tone: 'danger',
        confirmLabel: t('settings.voice.bypass.ask.ok'),
        cancelLabel: t('dlg.cancel')
      })
      if (r !== 'confirm') return
    }
    await setBypass(on)
  }

  const usd = (n: number): string => n.toFixed(2)
  const cost = !usage
    ? '—'
    : usage.by === 'tokens'
      ? `${t('settings.voice.cost.about')} ${usd(usage.low)}${t('settings.voice.cost.usd')}`
      : `${t('settings.voice.cost.about')} ${usd(usage.low)}~${usd(usage.high)}${t('settings.voice.cost.usd')}`

  return (
    <div className="vs">
      <p className="vs-lead">{t('settings.voice.lead')}</p>
      <div className="vs-keyln">
        <KeyRound size={13} aria-hidden />
        <span>{t('settings.voice.key')}</span>
        {hasKey ? (
          <span className="okk">
            <Check size={12} aria-hidden />
            {t('settings.voice.key.ok')}
          </span>
        ) : (
          <span className="nok">{t('settings.voice.key.none')}</span>
        )}
        <span>{t('settings.voice.key.paid')}</span>
        <button type="button" className="lnk" data-action="voice.toAi" onClick={goAi}>
          {t('settings.voice.key.go')}
        </button>
      </div>
      <div className="vs-cols">
        <div className="vs-pv">
          <div className="vs-stage">
            <span className="tag">
              <i />
              {t('settings.voice.pv.tag')} · {t('settings.voice.face.' + v.face)}
            </span>
            <div className="sub">
              <span className="me">{t('voice.me')} </span>
              {t('settings.voice.pv.me')}
              {v.captionLines > 1 && (
                <>
                  <br />
                  {t('settings.voice.pv.ara')}
                </>
              )}
            </div>
          </div>
          <div className="vs-pvseg">
            <Seg value={v.face} options={VOICE_FACES} onChange={(face) => set({ face })} labelKey={(f) => 'settings.voice.face.' + f} field="voice.face" />
          </div>
          <p className="vs-note">{t('settings.voice.face.note')}</p>
          <div className="vs-row">
            <button type="button" className="btn sec" data-action="voice.preview" disabled={!hasKey} onClick={() => void previewVoice()}>
              <Play size={12} aria-hidden />
              {t('settings.voice.preview')}
            </button>
            <span className="vs-note">
              {v.voiceName} · {t('settings.voice.speed.' + v.speed)}
            </span>
          </div>
          <div className="vs-row">
            <Mic size={14} aria-hidden />
            <span className="vs-lvl" aria-label={t('settings.voice.level')}>
              {Array.from({ length: LEVEL_BARS }, (_, i) => (
                <i key={i} className={i < lit ? 'on' : undefined} />
              ))}
            </span>
            <span className="vs-lvl-t">{micErr ? t('settings.voice.mic.err') : `${db} dB`}</span>
          </div>
          <p className="vs-note">{t('settings.voice.level.note')}</p>
        </div>
        <div className="vs-rt">
          <div className="vs-fg">{t('settings.voice.g.voice')}</div>
          <Fr name={t('settings.voice.enabled')} desc={t('settings.voice.enabled.desc')} item="voice.enabled">
            <kbd className="kbd">{key ? keyText(isMac ? key.mac : key.win) : ''}</kbd>
            <Toggle on={v.enabled} label={t('settings.voice.enabled')} onChange={(enabled) => set({ enabled })} />
          </Fr>
          <div className="vs-fg">{t('settings.voice.g.speak')}</div>
          <Fr name={t('settings.voice.voice')} item="voice.voice">
            <div className="vs-dd">
              <Dropdown
                value={voiceLabel(v.voiceName)}
                options={VOICES.map((x) => voiceLabel(x.name))}
                onChange={(label) => set({ voiceName: VOICES.find((x) => voiceLabel(x.name) === label)?.name ?? v.voiceName })}
                ariaLabel={t('settings.voice.voice')}
              />
            </div>
          </Fr>
          <Fr name={t('settings.voice.speed')} item="voice.speed">
            <Seg value={v.speed} options={VOICE_SPEEDS} onChange={(speed) => set({ speed })} labelKey={(x) => 'settings.voice.speed.' + x} field="voice.speed" />
          </Fr>
          <div className="vs-fg">{t('settings.voice.g.mic')}</div>
          <Fr name={t('settings.voice.mic')} item="voice.mic">
            <div className="vs-dd wide">
              <Dropdown
                value={micValue}
                options={micOptions}
                onChange={(label) => set({ inputDeviceId: label === defaultMic ? '' : (mics[micOptions.indexOf(label) - 1]?.id ?? '') })}
                ariaLabel={t('settings.voice.mic')}
              />
            </div>
          </Fr>
          <Fr name={t('settings.voice.listen')} desc={t('settings.voice.listen.desc')} item="voice.listen">
            <Seg value={v.listen} options={VOICE_LISTEN} onChange={(listen) => set({ listen })} labelKey={(x) => 'settings.voice.listen.' + x} field="voice.listen" />
          </Fr>
          <div className="vs-fg">{t('settings.voice.g.caption')}</div>
          <Fr name={t('settings.voice.lines')} item="voice.lines">
            <Seg
              value={String(v.captionLines) as '1' | '2' | '3'}
              options={['1', '2', '3'] as const}
              onChange={(n) => set({ captionLines: Number(n) as 1 | 2 | 3 })}
              labelKey={(x) => 'settings.voice.lines.' + x}
              field="voice.lines"
            />
          </Fr>
          <Fr name={t('settings.voice.keep')} desc={t('settings.voice.keep.desc')} item="voice.keep">
            <Seg
              value={v.keep}
              options={VOICE_KEEP}
              onChange={(keep) => set({ keep })}
              labelKey={(x) => (x === 'off' ? 'settings.voice.keep.off' : 'settings.retention.' + x)}
              field="voice.keep"
            />
          </Fr>
          <div className="vs-fg">{t('settings.voice.g.approve')}</div>
          <Fr name={t('settings.voice.approve')} desc={t('settings.voice.approve.desc')} item="voice.approve">
            <span className="vs-lvl-t">{t('settings.voice.approve.always')}</span>
          </Fr>
          <Fr name={t('settings.voice.bypass')} desc={t('settings.voice.bypass.desc')} item="voice.bypass">
            <Toggle on={bypass} label={t('settings.voice.bypass')} onChange={(on) => void flipBypass(on)} />
          </Fr>
          {bypass && (
            <div className="vs-warn">
              <ShieldAlert size={15} aria-hidden />
              <span>
                {t('settings.voice.bypass.warn1')}
                <em>{t('settings.voice.bypass.warn2')}</em>
                {t('settings.voice.bypass.warn3')}
              </span>
            </div>
          )}
          <div className="vs-foot">
            <Clock size={13} aria-hidden />
            <span>
              {t('settings.voice.month')} <b>{usage ? minutesText(usage.seconds) : '—'}</b> · {t('settings.voice.cost')} <b>{cost}</b>{' '}
              <span>{t(usage?.by === 'tokens' ? 'settings.voice.cost.byTokens' : 'settings.voice.cost.byTime')}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
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
  /**
   * 딥링크(store/settingsNav openSettings) — 이 섹션·항목으로 열린다. 없으면 마지막에 보던 섹션 그대로.
   * n 은 같은 목적지를 다시 불러도 effect 가 다시 돌게 하는 꼬리표다.
   */
  entry?: SettingsTarget & { n: number }
}

/** 검색어가 든 부분을 <mark> 로. 대소문자는 무시한다(searchSettings 와 같은 규칙). */
function Hl({ text, q }: { text: string; q: string }) {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  )
}

const FLASH_MS = 1600

export function SettingsPage({ open, font, prefs, version, onClose, onChange, onPrefsChange, ask, onOpenCommandBook, entry }: Props) {
  const [section, setSection] = useState<SettingsSection>(SETTINGS_INDEX[0].id)
  const [query, setQuery] = useState('')
  // 딥링크로 온 항목 — 섹션이 그려진 뒤 그 줄로 스크롤하고 잠깐 밝힌다.
  const [focusItem, setFocusItem] = useState<{ item: string; n: number } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)

  const go = useCallback((s: SettingsSection, item?: string) => {
    setQuery('')
    setSection(s)
    setFocusItem(item ? { item, n: Date.now() } : null)
  }, [])

  /**
   * **AI 키가 아직 없으면 [아라 채팅] 섹션으로 열린다** (2026-08-22 준영님 제보 8번).
   *
   * 이 페이지는 언마운트되지 않고 `open` 클래스만 토글되므로 마지막에 보던 섹션이 그대로 남는다 —
   * 평소엔 그게 맞지만, 키를 아직 안 넣은 사람에게는 **첫 할 일이 그것**이라 그 자리를 스스로
   * 찾아가게 두지 않는다. 키가 한 번이라도 저장되면 이 분기는 다시는 타지 않는다(기존 동작 복귀).
   * 열릴 때 한 번만 묻는다 — 페이지가 떠 있는 동안 사용자가 고른 섹션을 빼앗지 않기 위해서다.
   */
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.ev?.ai
      .getState()
      .then((s) => {
        if (alive && AI_ENTRY && !s.hasKey && !entry) setSection('ai')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open])

  useEffect(() => {
    if (open && entry) go(entry.section, entry.item)
  }, [open, entry, go])

  // 열릴 때 포커스를 페이지 안으로 들인다 — 뒤 터미널에 남아 있으면 친 글자가 셸로 간다.
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) boxRef.current?.focus()
  }, [open])

  // 열린 동안 페이지 바깥(타이틀바·상태바는 빼고)을 inert 로 묶는다 — 덮인 터미널·사이드바가 Tab 으로 잡히지 않게.
  // 페이지에서 앱 뿌리까지 올라가며 **형제**만 묶는다(조상은 이 페이지를 품고 있어 묶으면 페이지도 죽는다).
  useEffect(() => {
    const box = boxRef.current
    if (!open || !box) return
    const locked: Element[] = []
    for (let el: Element = box; el.parentElement && el !== document.body; el = el.parentElement) {
      for (const sib of Array.from(el.parentElement.children)) {
        if (sib === el || sib.hasAttribute('inert') || sib.matches('.titlebar, .statusbar, .overlay, script')) continue
        sib.setAttribute('inert', '')
        locked.push(sib)
      }
    }
    return () => locked.forEach((x) => x.removeAttribute('inert'))
  }, [open])

  // Ctrl+F — 설정 찾기(시안). 열린 동안만, 다른 리스너보다 먼저 가로챈다.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopImmediatePropagation()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  // 딥링크 항목 밝히기. 섹션 몸통이 비동기로 채워지는 줄(훅 상태 등)이 있어 잠깐 기다리며 찾는다.
  useEffect(() => {
    if (!focusItem || !open) return
    let tries = 0
    let off: ReturnType<typeof setTimeout> | undefined
    const find = (): void => {
      const el = paneRef.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(focusItem.item)}"]`)
      if (!el) {
        if (++tries < 20) off = setTimeout(find, 50)
        return
      }
      el.scrollIntoView({ block: 'center' })
      el.classList.add('sp-flash')
      off = setTimeout(() => el.classList.remove('sp-flash'), FLASH_MS)
    }
    find()
    return () => clearTimeout(off)
  }, [focusItem, open])

  const q = query.trim()
  const hits = q ? searchSettings(q, t) : []
  const hitCount = hits.reduce((n, h) => n + Math.max(1, h.items.length), 0)
  const def = sectionDef(section)

  // 왼쪽 목록 — 묶음 머리 + 섹션. 검색 중이면 맞는 섹션만, 옆에 맞은 항목 수.
  const navRows: React.ReactNode[] = []
  let lastGroup = ''
  for (const d of SETTINGS_INDEX) {
    const hit = q ? hits.find((h) => h.section.id === d.id) : undefined
    if (q && !hit) continue
    if (d.group !== lastGroup) {
      lastGroup = d.group
      navRows.push(
        <div className="sp-group" key={'g.' + d.group} data-group={d.group}>
          {t('settings.group.' + d.group)}
          {d.group === 'aiws' && <span className="sp-new">{t('settings.group.new')}</span>}
        </div>
      )
    }
    navRows.push(
      <button
        type="button"
        key={d.id}
        role="tab"
        aria-selected={!q && section === d.id}
        data-section={d.id}
        className={'sp-item' + (!q && section === d.id ? ' on' : '') + (d.soon ? ' soon' : '')}
        onClick={() => go(d.id)}
      >
        <Hl text={t('settings.nav.' + d.id)} q={q} />
        {hit && hit.items.length > 0 && <span className="sp-hits">{hit.items.length}</span>}
      </button>
    )
  }

  return (
    <div
      className={'settings-page' + (open ? ' open' : '')}
      role="region"
      aria-label={t('settings.title')}
      tabIndex={-1}
      ref={boxRef}
    >
      <nav className="sp-nav" aria-label={t('settings.title')}>
        <button type="button" className="sp-back" data-action="settings.close" onClick={onClose}>
          <ArrowLeft size={14} aria-hidden />
          {t('settings.back')}
          <kbd className="kbd">Esc</kbd>
        </button>
        <label className="sp-search">
          <Search size={14} aria-hidden />
          <input
            ref={searchRef}
            type="search"
            placeholder={t('settings.search')}
            aria-label={t('settings.search')}
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // 검색어가 있으면 Esc 는 먼저 검색어를 지운다(페이지 닫기는 그다음 Esc).
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              }
            }}
          />
          <kbd className="kbd">{isMac ? '⌘ F' : 'Ctrl F'}</kbd>
        </label>
        <div className="sp-list" role="tablist" aria-orientation="vertical">
          {navRows.length > 0 ? navRows : <div className="sp-empty">{t('settings.search.none').replace('{q}', q)}</div>}
        </div>
      </nav>

      <div className="sp-main" ref={paneRef}>
        <div className="sp-col">
          {q ? (
            <div className="sp-results" data-count={hitCount}>
              <div className="sp-crumb">{t('settings.search.crumb')}</div>
              <h1 className="sp-h1">{t('settings.search.title').replace('{q}', q).replace('{n}', String(hitCount))}</h1>
              <div className="sp-desc">{t('settings.search.desc')}</div>
              {hits.map(({ section: d, items }) => (
                <div className="sp-hit-sec" key={d.id} data-section={d.id}>
                  <h2 className="sp-h2">
                    {t('settings.group.' + d.group)} › <Hl text={t('settings.nav.' + d.id)} q={q} />
                  </h2>
                  {(items.length > 0 ? items : [{ id: '', label: 'settings.nav.' + d.id, desc: d.soon ? 'settings.soon' : undefined }]).map((x) => (
                    <button
                      type="button"
                      key={x.id || d.id}
                      className="sp-hit"
                      data-item={x.id || undefined}
                      onClick={() => go(d.id, x.id || undefined)}
                    >
                      <span className="sp-hit-l">
                        <Hl text={t(x.label)} q={q} />
                      </span>
                      {x.desc && (
                        <span className="sp-hit-d">
                          <Hl text={t(x.desc)} q={q} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="sp-crumb">{t('settings.group.' + def.group)}</div>
              <h1 className="sp-h1">{t('settings.nav.' + section)}</h1>
              <div className="sp-pane" role="tabpanel" data-section={section}>
          {def.soon && <div className="set-note sp-soon">{t('settings.soon')}</div>}

          {section === 'agents' && (
            <>
              {/* 열렸을 때만 — 이 페이지는 닫혀도 마운트돼 있어 감지(powershell·where·--version 4~7개)가 켤 때마다 돌아
                  작업공간 복원과 CPU 를 다퉜다(perf-creep-done.md, workspaceMs +214ms). */}
              {open && (
                <Suspense fallback={null}>
                  <AgentSettings />
                </Suspense>
              )}
            </>
          )}

          {section === 'managed' && open && (
            <Suspense fallback={null}>
              <ManagedServers />
            </Suspense>
          )}

          {/* M13 계정·사용량 — 열렸을 때만(계정별 사용량·통계를 묻는다). */}
          {section === 'usage' && open && (
            <Suspense fallback={null}>
              <UsageSettings />
            </Suspense>
          )}

          {/* M15 연동 — 열렸을 때만(GitLab · Slack). */}
          {section === 'integrations' && open && (
            <Suspense fallback={null}>
              <GitLabSettings />
            </Suspense>
          )}
          {section === 'slack' && open && (
            <Suspense fallback={null}>
              <SlackSettings />
            </Suspense>
          )}

          {/* M14 R1 예약 실행·스킬·MCP 서버 — 열렸을 때만(스킬 폴더·MCP 설정 파일을 그때 읽는다). */}
          {section === 'automations' && open && (
            <Suspense fallback={null}>
              <AutomationsSettings />
            </Suspense>
          )}
          {section === 'skills' && open && (
            <Suspense fallback={null}>
              <SkillsSettings />
            </Suspense>
          )}
          {section === 'mcpServers' && open && (
            <Suspense fallback={null}>
              <McpServersSettings />
            </Suspense>
          )}

          {section === 'update' && (
            <>
              <UpdateRow />
              {/* P3 R2-A TM-15 릴리스 채널(사내 베타). */}
              <UpdateChannelRow prefs={prefs} onPrefsChange={onPrefsChange} />
            </>
          )}

          {section === 'notify' && (
            // M1 라운드 3: 알림 센터(벨·토스트·공간 맥박). M3 부터 AI 작업 공간이 기본 공개라 늘 보인다.
            <>
              <Row label={t('settings.notify.toast')} desc={t('settings.notify.toast.desc')} item="notify.toast">
                <Toggle on={prefs.notifyToast} label={t('settings.notify.toast')} onChange={(notifyToast) => onPrefsChange({ notifyToast })} />
              </Row>
              <Row label={t('settings.notify.agents')} desc={t('settings.notify.agents.desc')} item="notify.agents">
                <Toggle on={prefs.notifyAgents} label={t('settings.notify.agents')} onChange={(notifyAgents) => onPrefsChange({ notifyAgents })} />
              </Row>
              <Row label={t('settings.notify.sound')} desc={t('settings.notify.sound.desc')} item="notify.sound">
                <span className="set-note">{t('aiws.soon')}</span>
              </Row>
            </>
          )}

          {section === 'editor' && (
            // M12 R2 에디터 옵션(Orca 기본값 — shared/editorPrefs.ts). AI 작업 공간 코드 에디터·변경 비교가 바로 따른다.
            <>
              <Row label={t('settings.editor.wordWrap')} desc={t('settings.editor.wordWrap.desc')} item="editor.wordWrap">
                <Toggle on={prefs.codeEditor.wordWrap} label={t('settings.editor.wordWrap')} onChange={(wordWrap) => onPrefsChange({ codeEditor: { ...prefs.codeEditor, wordWrap } })} />
              </Row>
              <Row label={t('settings.editor.minimap')} desc={t('settings.editor.minimap.desc')} item="editor.minimap">
                <Toggle on={prefs.codeEditor.minimap} label={t('settings.editor.minimap')} onChange={(minimap) => onPrefsChange({ codeEditor: { ...prefs.codeEditor, minimap } })} />
              </Row>
              <Row label={t('settings.editor.font')} desc={t('settings.editor.font.desc')} item="editor.font">
                <input
                  type="text"
                  className="ai-key-input"
                  data-field="editor.font"
                  spellCheck={false}
                  placeholder={t('settings.editor.font.placeholder')}
                  value={prefs.codeEditor.fontFamily}
                  onChange={(e) => onPrefsChange({ codeEditor: editorPrefsOf({ ...prefs.codeEditor, fontFamily: e.target.value }) })}
                />
              </Row>
              <Row label={t('settings.editor.previewTabs')} desc={t('settings.editor.previewTabs.desc')} item="editor.previewTabs">
                <Toggle on={prefs.codeEditor.previewTabs} label={t('settings.editor.previewTabs')} onChange={(previewTabs) => onPrefsChange({ codeEditor: { ...prefs.codeEditor, previewTabs } })} />
              </Row>
              <Row label={t('settings.editor.diffView')} desc={t('settings.editor.diffView.desc')} item="editor.diffView">
                <Seg value={prefs.codeEditor.diffView} options={DIFF_VIEWS} onChange={(diffView) => onPrefsChange({ codeEditor: { ...prefs.codeEditor, diffView } })} labelKey={(v) => 'settings.editor.diffView.' + v} field="editor.diffView" />
              </Row>
            </>
          )}

          {section === 'advanced' && (
            <>
              <GpuRow open={open} version={version} />
              <ProbeRow open={open} />
              <DirRow
                label={t('settings.dir.app')}
                item="dir.app"
                desc={t('settings.dir.app.desc')}
                value={prefs.appLogDir}
                onChange={(appLogDir) => onPrefsChange({ appLogDir })}
              />
            </>
          )}

          {section === 'general' && (
            <>
              {/* UI-font5: 글자 크기를 우리가 한 번 더 추측하지 않고 쓰는 사람이 고른다.
                  터미널 글자는 이 배율을 타지 않는다 — [터미널] 섹션에 자체 크기 슬라이더가 있다. */}
              <Row label={t('settings.uiScale')} desc={t('settings.uiScale.desc')} item="uiScale">
                <Seg
                  value={prefs.uiScale}
                  options={UI_SCALES}
                  onChange={(uiScale) => onPrefsChange({ uiScale })}
                  labelKey={(v) => 'ui.scale.' + v}
                />
              </Row>
              {/* #139 켤 때 인사. 멋은 한 번이고 방해는 매일이라 **끌 수 있어야** 한다. */}
              <Row label={t('settings.bootSplash')} desc={t('settings.bootSplash.desc')} item="bootSplash">
                <Toggle
                  on={prefs.bootSplash}
                  label={t('settings.bootSplash')}
                  onChange={(bootSplash) => onPrefsChange({ bootSplash })}
                />
              </Row>
              {/* R15(신고 #3): "설정에 저장할 폴더를 지정하는 부분이 없음". 받는 곳은 [파일] 탭의 일이라
                  [로그] 가 아니라 여기다. 사라진 폴더는 받을 때 묻는다(FileTree.download). */}
              <DirRow
                label={t('settings.dir.download')}
                item="dir.download"
                desc={t('settings.dir.download.desc')}
                value={prefs.downloadDir}
                onChange={(downloadDir) => onPrefsChange({ downloadDir })}
                resolve={() =>
                  window.ev.fs
                    .downloadTarget()
                    .then((r) => (r.missing ? `${r.missing} — ${t('settings.dir.missing')}` : r.dir))
                }
              />
            </>
          )}

          {/* 2.0 4단계 — 모양 › 마우스 커서(시안 Z-cursor). 견본 칸에 마우스를 올리면 그 커서가 된다. */}
          {section === 'look' && (
            <>
              {/* G1 글라스(시안 C). 기본 끔 — 성능 A/B 뒤 기본값을 정한다. ARA_GLASS 로 강제한 판이면 이 스위치보다 env 가 이긴다. */}
              <Row label={t('settings.glass')} desc={t('settings.glass.desc')} item="glass">
                <Toggle on={prefs.glass} label={t('settings.glass')} onChange={(glass) => onPrefsChange({ glass })} />
              </Row>
              <div className="set-sec-t" data-item="mouseCursor">{t('settings.mouseCursor')}</div>
              <div className="set-note">{t('settings.mouseCursor.desc')}</div>
              <div className="cur-legend" aria-hidden>
                {CURSOR_KINDS.map((k) => (
                  <span key={k}>{t('mouseCursor.kind.' + k)}</span>
                ))}
              </div>
              <div className="cur-list" role="radiogroup" aria-label={t('settings.mouseCursor')}>
                {MOUSE_CURSORS.map((c) => (
                  <label key={c} className={'cur-opt' + (prefs.mouseCursor === c ? ' on' : '')} data-value={c}>
                    <input
                      type="radio"
                      name="mouse-cursor"
                      checked={prefs.mouseCursor === c}
                      onChange={() => onPrefsChange({ mouseCursor: c })}
                    />
                    <span className="cur-tx">
                      <span className="cur-nm">
                        {t('mouseCursor.' + c)}
                        {c === DEFAULT_MOUSE_CURSOR && <span className="cur-badge">{t('settings.mouseCursor.default')}</span>}
                      </span>
                      <span className="cur-ds">{t('mouseCursor.' + c + '.desc')}</span>
                    </span>
                    <span className="cur-smp">
                      {CURSOR_KINDS.map((k) => (
                        <span key={k} style={{ cursor: cursorValue(c, k) }} title={t('mouseCursor.kind.' + k)}>
                          <img src={cursorSrc(c, k)} alt="" />
                        </span>
                      ))}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}

          {section === 'terminal' && (
            <>
              {/* #194 ④ 자동완성 스위치. 지금까지 빠져나갈 길이 없었다 — 거슬리는 사람에게
                  "끄세요" 라고 말할 수 있는 자리가 이 한 줄이다. 기본은 켬(기존 동작 유지). */}
              <Row label={t('settings.termCompletion')} desc={t('settings.termCompletion.desc')} item="termCompletion">
                <Toggle
                  on={prefs.termCompletion}
                  label={t('settings.termCompletion')}
                  onChange={(termCompletion) => onPrefsChange({ termCompletion })}
                />
              </Row>
              <Row label={t('settings.cursorStyle')} desc={t('settings.cursorStyle.desc')} item="cursorStyle">
                <Seg
                  value={prefs.cursorStyle}
                  options={CURSOR_STYLES}
                  onChange={(cursorStyle) => onPrefsChange({ cursorStyle })}
                  labelKey={(v) => 'settings.cursor.' + v}
                />
              </Row>
              <Row label={t('settings.cursorBlink')} desc={t('settings.cursorBlink.desc')} item="cursorBlink">
                <Toggle
                  on={prefs.cursorBlink}
                  label={t('settings.cursorBlink')}
                  onChange={(cursorBlink) => onPrefsChange({ cursorBlink })}
                />
              </Row>
              <Row label={t('settings.bell')} desc={t('settings.bell.desc')} item="bell">
                <Seg
                  value={prefs.bell}
                  options={BELL_STYLES}
                  onChange={(bell) => onPrefsChange({ bell })}
                  labelKey={(v) => 'settings.bell.' + v}
                />
              </Row>
              {/* M1 1-A: 선택 시 자동 복사·스크롤백은 [일반]에서 여기로 왔다(대응표 4-3). */}
              <Row label={t('settings.copyOnSelect')} desc={t('settings.copyOnSelect.desc')} item="copyOnSelect">
                <Toggle
                  on={prefs.copyOnSelect}
                  label={t('settings.copyOnSelect')}
                  onChange={(copyOnSelect) => onPrefsChange({ copyOnSelect })}
                />
              </Row>
              <Row label={t('settings.scrollback')} desc={t('settings.scrollback.desc')} item="scrollback">
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
              {isMac && <LocalNetworkRow />}
              {/* P3 R2-A 터미널 3차 — 셸·테마·대비·가져오기·인라인 이미지·OSC 52(TermExtraSettings.tsx). */}
              <TermExtraRows prefs={prefs} onPrefsChange={onPrefsChange} onFont={onChange} />
            </>
          )}

          {section === 'features' && (
            <>
              {/* 2.0 3단계 — 시안 Z-settings. 끄는 것은 진입점(하단 탭·메뉴·레일)뿐이다(features.ts). */}
              <div className="set-note">{t('settings.features.note')}</div>
              {[false, true].map((def) => {
                const list = FEATURES.filter((f) => !!f.hidden === def)
                return (
                  <div key={String(def)} data-sec={def ? 'hidden' : 'shown'}>
                    <div className="set-sec-t">
                      {t(def ? 'settings.features.hidden' : 'settings.features.shown')} {list.length}
                    </div>
                    {list.map((f) => {
                      const b = f.key && KEYMAP.find((k) => k.action === f.key)
                      return (
                        <div className="feat-row" key={f.id} data-feature={f.id} data-item={'feature.' + f.id}>
                          <span className="fr-name">{t('feature.' + f.id)}</span>
                          <span className="fr-desc">{t('feature.' + f.id + '.desc')}</span>
                          <span className="cs-keys">
                            {b && <kbd className="cs-k kbd">{keyText(isMac ? b.mac : b.win)}</kbd>}
                          </span>
                          <Toggle
                            on={prefs.features[f.id]}
                            label={t('feature.' + f.id)}
                            onChange={(on) => onPrefsChange({ features: { ...prefs.features, [f.id]: on } })}
                          />
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </>
          )}

          {section === 'font' && (
            <>
              {/* 폰트 비교 스트립 — 동일 한글 문장을 후보별로 나란히 */}
              <div className="font-compare" data-item="font.compare">
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
              <Row label={t('settings.krFallback')} desc={t('settings.krFallback.desc')} item="font.krFallback">
                <Toggle
                  on={font.krSystemFallback ?? true}
                  label={t('settings.krFallback')}
                  onChange={(krSystemFallback) => onChange({ krSystemFallback })}
                />
              </Row>

              {/* 터미널 폰트 선택(라디오) — 2026-08-21 부터 **--term 하나만** 바꾼다.
                  앱 화면 글꼴(--ui Pretendard · --mono 나눔고딕코딩)은 고정이고 설정에 없다. */}
              <div className="set-sec-t" data-item="font.term">{t('settings.pick.title')}</div>
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
              <div className="set-sec-t" data-item="font.preview">{t('settings.preview.title')}</div>
              <div className="fp-controls">
                <div className="cg" data-item="font.size">
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
                <div className="cg" data-item="font.lineHeight">
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
              <Row label={t('settings.sessionLog')} desc={t('settings.sessionLog.desc')} item="sessionLog">
                <Toggle
                  on={prefs.sessionLog}
                  label={t('settings.sessionLog')}
                  onChange={(sessionLog) => onPrefsChange({ sessionLog })}
                />
              </Row>
              <Row label={t('settings.logRetention')} desc={t('settings.logRetention.desc')} item="logRetention">
                <Seg
                  value={String(prefs.logRetentionDays)}
                  options={RETENTION_VALUES}
                  onChange={(v) => onPrefsChange({ logRetentionDays: Number(v) })}
                  labelKey={(v) => 'settings.retention.' + v}
                />
              </Row>
              <Row label={t('settings.logFolder')} desc={t('settings.logFolder.desc')} item="logFolder">
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
                item="dir.session"
                desc={t('settings.dir.session.desc')}
                value={prefs.sessionLogDir}
                onChange={(sessionLogDir) => onPrefsChange({ sessionLogDir })}
              />
              <div className="set-note">{t('settings.log.note')}</div>
            </>
          )}

          {section === 'ai' && <AiSection prefs={prefs} onPrefsChange={onPrefsChange} ask={ask} />}

          {section === 'voice' && (
            <VoiceSection prefs={prefs} onPrefsChange={onPrefsChange} ask={ask} open={open} goAi={() => go('ai', 'ai.key')} />
          )}

          {section === 'mcp' && <McpSection ask={ask} />}

          {section === 'security' && <SecuritySection open={open} ask={ask} />}

          {section === 'keys' && (
            <>
              <div className="set-note" data-item="keys.list">{t('settings.keys.note')}</div>
              {/* FB-monitor(FB-0004): tmux 를 처음 쓰는 사용자를 위한 진입점 — 명령어 북(F18)의
                  tmux 카테고리로 바로 연다. 새 도움말 화면을 만들지 않고 기존 검색형 치트시트를 재사용. */}
              <Row label={t('settings.keys.tmux')} desc={t('settings.keys.tmux.desc')} item="keys.tmux">
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
                          <kbd className="cs-k kbd">{keyText(isMac ? b.mac : b.win)}</kbd>
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </>
          )}

          {section === 'history' && <HistorySection ask={ask} open={open} />}

          {section === 'about' && (
            <>
              <Row label={t('app.name')} desc={t('about.msg')} item="about.version">
                <span className="v">v{version}</span>
              </Row>

              {/* #175 — 배포 전엔 앱 어디에도 사용 설명서로 가는 길이 없었다. 정보 탭에 이미 버전·
                  라이선스가 있으니 여기 한 행이 제일 싸다. 새 창이 아니라 OS 기본 브라우저로(이 앱은
                  터미널이지 브라우저가 아니다) — app:openExternal 의 스킴 화이트리스트를 그대로 탄다. */}
              <Row label={t('settings.manual.title')} desc={t('settings.manual.desc')} item="manual">
                <button
                  type="button"
                  className="btn sec"
                  data-action="manual.open"
                  onClick={() => void window.ev?.app.openExternal(MANUAL_URL)}
                >
                  {t('settings.manual.open')}
                </button>
              </Row>

              {/* 1.0.12 패치 내역. **아라 브라우저로 연다** — 업데이트 직후 뜨는 창과 같은 자리여야
                  하고(준영님: *"창 하나 띄워서 거기서도 보여주는 건"*), 그 창이 아라 안에서 연다.
                  ⚠️ 바로 위 [사용 설명서]는 **OS 브라우저**다(그 주석의 판단 — 이 앱은 터미널이지
                     브라우저가 아니다). 두 줄이 다른 곳으로 여는 것이 지금 상태이고, 어느 쪽으로
                     통일할지는 준영님 몫으로 남겼다. 조용히 한쪽을 바꾸지 않는다. */}
              <Row label={t('settings.notes.title')} desc={t('settings.notes.desc')} item="notes">
                <button
                  type="button"
                  className="btn sec"
                  data-action="notes.open"
                  onClick={() => void window.ev?.oriel?.open(CHANGELOG_URL)}
                >
                  {t('settings.notes.open')}
                </button>
              </Row>

              {/* OFL 라이선스 고지 (GAP-OFL) */}
              <div className="set-sec-t" data-item="license">{t('settings.license.title')}</div>
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

              {/* M0 — 옮겨 온 코드의 고지. 원문은 설치 폴더 resources/NOTICE(electron-builder extraResources). */}
              <div className="set-sec-t" data-item="notice">{t('settings.notice.title')}</div>
              <div className="license-list">
                {CODE_NOTICES.map((l) => (
                  <div className="license-row" key={l.name}>
                    <div className="lic-name">{l.name}</div>
                    <div className="lic-meta">
                      {l.copyright} · <span className="lic-ofl">{l.license}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="set-note">{t('settings.notice.note')}</div>
            </>
          )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
