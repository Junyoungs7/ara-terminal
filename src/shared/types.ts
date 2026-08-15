// Shared domain types — main·preload·renderer 공유. (계획서 §B.3 스키마)
import type { AiCliRecent } from './aiCli'
export type { AiCliRecent }

// v2: 터미널 우클릭 기본값을 리스트 메뉴로 바꾸면서 기존 저장값(radial/palette)을 1회 list 로 옮긴다.
// v3: 탭바 순환 토글을 제거(R1.4) — 스타일을 바꿀 UI 가 없어졌으므로 남아 있는 radial/palette 를 다시 list 로 내린다.
// v4: W4sat F21 — 프로필에 type(ssh/rdp) 판별 필드가 생겼다. 기존 프로필(전부 ssh)에 type:'ssh' 를 채운다.
// v5: W5 아라 멀티 프로바이더 — 단일 ui.aiModel 을 provider-분리 ui.aiModels{provider:model} 로 옮긴다.
// 기존 값은 실제 사용자 데이터(임의로 defaulting 할 수 없다)라 v3→v4 프로필 백필과 같은 실 마이그레이션.
export const SCHEMA_VERSION = 5 as const

export type SecretRef = { store: 'vault'; key: string }

// W4sat F21: ssh/rdp를 판별 유니온으로 나눠 rdp 쪽에서 auth 필드 자체가 존재하지 않게 한다
// (있으나 안 쓰는 필드를 만들지 않는다). RDP 는 인증 방식 선택이 없어 secretRef 하나로 족하다.
// (F21 당시엔 OS 클라이언트 외부 실행뿐이라 비밀번호를 아예 저장하지 않았지만, F25 로 앱 안에서
//  접속하게 되면서 매번 입력이 부담이라는 실사용 피드백에 따라 vault 저장을 열었다 — 2026-08-07.)
export type SshAuth =
  | { type: 'key'; keyPath: string; secretRef?: SecretRef }
  | { type: 'password'; secretRef: SecretRef }

export type SshProfile = {
  id: string
  type: 'ssh'
  name: string
  host: string
  port: number
  username: string
  auth: SshAuth
  group?: string
}

export type RdpProfile = {
  id: string
  type: 'rdp'
  name: string
  host: string
  port: number
  username: string
  // F25-pw(2026-08-07 준영님 요청): 저장해 두면 접속할 때 입력 화면 없이 바로 붙는다. ssh 와 달리
  // 인증 방식 선택이 없어(RDP 는 비밀번호뿐) auth 유니온 대신 참조 하나만 둔다. 없으면 매번 입력받는다.
  secretRef?: SecretRef
  group?: string
}

export type ConnectionProfile = SshProfile | RdpProfile

export type KnownHost = {
  algorithm: string
  fingerprint: string
  firstSeen: string
}

// 프로필 저장 입력(renderer→main). 비밀은 평문으로 여기서만 잠깐 전달되고 main이 vault에 넣는다.
// workspace.json에는 절대 저장되지 않는다(secretRef만).
export type ProfileInput = {
  id?: string // 미지정 시 신규(main이 uuid 발급)
  // W4sat F21: 미지정 시 'ssh'(기존 호출부 전부 그대로 동작). rdp면 authType/keyPath/secret 은 무시된다.
  type?: 'ssh' | 'rdp'
  name: string
  host: string
  port: number
  username: string
  // rdp 프로필에는 뜻이 없다(옵셔널 — RDP 폼은 이 필드를 보내지 않는다).
  authType?: 'key' | 'password'
  keyPath?: string
  group?: string
  // 비밀번호 인증의 비밀번호, 또는 키 인증의 패스프레이즈. undefined면 기존 비밀 유지(키 회전 안 함).
  secret?: string
}

// 호스트키 TOFU: 최초 접속 시 지문 확인 프롬프트 / 불일치 시 차단 경고.
export type HostKeyVerdict =
  | { kind: 'known' } // 이미 알려진 일치 호스트키 → 통과
  | { kind: 'new'; hostId: string; algorithm: string; fingerprint: string } // 최초 → 사용자 확인 필요
  | { kind: 'mismatch'; hostId: string; algorithm: string; fingerprint: string; known: KnownHost } // 불일치 → 차단

export type LayoutNode =
  | { type: 'pane'; sessionId: string | null }
  | { type: 'split'; direction: 'row' | 'col'; ratio: number[]; children: LayoutNode[] }

// F25: rdp 는 pty 가 없는 렌더러 전용 세션이다(원격 화면을 캔버스로 그린다) — main 의 세션 원장에
// 들어가지 않으므로 destroy·복원 경로에서 구분이 필요하다.
export type SessionType = 'local' | 'ssh' | 'rdp'

export type Session = {
  id: string
  type: SessionType
  shell?: string
  profileId?: string | null
  cwd?: string
  title: string
  serverKey: string
  // R3.6: 사용자가 직접 이름을 바꾼 세션. 셸이 보내는 OSC 0/2 제목이 이 이름을 덮어쓰지 않게 한다.
  // 스냅샷에 함께 저장돼 재시작·복원 후에도 사용자 이름이 유지된다.
  manualTitle?: boolean
}

export type TabGroup = {
  serverKey: string
  color: string
  collapsed: boolean
}

export type FontConfig = {
  term: string
  sizePx: number
  lineHeight: number
  // UI-font4(2026-08-05): 한글만 OS 기본 한글 폰트(맑은 고딕/Apple SD Gothic Neo)로 그린다
  // (Tabby 재현 — 근거: agent_talk/UI-font4-done.md). 옵셔널 + 미지정 시 true(다른 UiState
  // 불boolean 필드와 같은 관례) — 옛 스냅샷도 마이그레이션 없이 새 기본 동작을 받는다.
  krSystemFallback?: boolean
}

// 창 크기·위치(F6 복원). 저장 없으면 기본 크기로 기동.
export type WindowBounds = { x: number; y: number; width: number; height: number }

// UI 배율(UI-font5, 2026-08-11). tokens.css 의 --ui-scale 로 내려가 --fs-* 척도와 행 높이를
// 함께 키운다. 준영님: "폰트가 작아서 살짝 가독성이 떨어진다."
//
// 왜 설정으로 여는가: UI 글자 크기는 UI-font1~3 에서 세 라운드를 "얼마가 맞나"로 소모하고도
// 적용되지 못했다. 한 값을 또 추측하는 대신 쓰는 사람이 고르게 한다. 무단계 슬라이더가 아닌
// 이산 4단계인 이유는 그 사이 값에 의미가 없기 때문이다(0.05 차이를 눈으로 못 가린다).
// 터미널 글자는 이 배율을 타지 않는다 — F5 폰트 설정에 자체 크기 슬라이더가 이미 있다.
// 저장값은 숫자가 아니라 **이름**이다 — 나중에 배율 수치를 다시 손봐도(예: large 를 1.15→1.2)
// 사용자가 고른 값이 그대로 살아 있다. 숫자로 저장하면 그때 스냅샷 마이그레이션이 필요해진다.
export const UI_SCALES = ['small', 'normal', 'large', 'xlarge'] as const
export type UiScale = (typeof UI_SCALES)[number]
export const DEFAULT_UI_SCALE: UiScale = 'normal'
export const UI_SCALE_FACTOR: Record<UiScale, number> = { small: 0.92, normal: 1, large: 1.12, xlarge: 1.25 }
/** 스냅샷의 자유 입력값을 목록 안으로 클램프한다(손상·구버전 대비 — aiProviderOf 와 같은 결). */
export function uiScaleOf(v: unknown): UiScale {
  return UI_SCALES.includes(v as UiScale) ? (v as UiScale) : DEFAULT_UI_SCALE
}

// 터미널 동작 기본값(R3.1/R3.4). R5 설정 창 [일반]·[터미널] 섹션이 이 값들을 노출한다.
// 옛 스냅샷에는 필드가 없으므로 읽는 쪽이 ?? 로 이 상수를 쓴다(스키마 버전 올릴 일 아님 —
// 전부 옵셔널이라 v3 파일이 그대로 읽힌다. 버전만 올리는 no-op 스텝은 파일을 다시 쓸 뿐이다).
export const DEFAULT_SCROLLBACK = 10000
export const DEFAULT_COPY_ON_SELECT = true

// 스크롤백 슬라이더 범위(R5). 1k 아래는 되감을 것이 없고, 100k 위는 세션당 메모리가 눈에 띄게 는다.
export const SCROLLBACK_MIN = 1000
export const SCROLLBACK_MAX = 100000
export const SCROLLBACK_STEP = 1000

// 커서 모양·깜빡임(R5 [터미널]). 값은 xterm 의 cursorStyle 표기를 그대로 쓴다 — 변환표를 만들지 않는다.
export const CURSOR_STYLES = ['block', 'bar', 'underline'] as const
export type CursorStyle = (typeof CURSOR_STYLES)[number]
export const DEFAULT_CURSOR_STYLE: CursorStyle = 'block'
export const DEFAULT_CURSOR_BLINK = true

// 벨(BEL, \x07). xterm 5 에는 소리·시각 벨 옵션이 없고 onBell 이벤트만 있으므로 시각 벨은
// 패널을 한 번 번쩍이는 것으로 구현한다(소리는 사내 환경에서 원한 적이 없어 넣지 않는다).
export const BELL_STYLES = ['off', 'visual'] as const
export type BellStyle = (typeof BELL_STYLES)[number]
export const DEFAULT_BELL: BellStyle = 'off'

// F12 세션 로그. 기본은 꺼짐 — 사내 DLP 환경에서 모든 원격 세션 출력을 묻지 않고 디스크에 남기는 것은
// 사용자가 명시적으로 선택할 일이다(설계 §5.5). 보존 기간 0 = 무제한(스윕이 아무것도 지우지 않는다).
export const DEFAULT_SESSION_LOG = false
export const DEFAULT_LOG_RETENTION_DAYS = 30
export const LOG_RETENTION_OPTIONS = [7, 30, 90, 0] as const

// W5 멀티 프로바이더: F16 은 Anthropic 구현체 하나뿐이라 provider 추상을 만들지 않았다(그때의 기각
// 사유 — `.omc/plans/w3-f16-design.md` §1). 사용자 요구로 두 번째 이후 구현체(OpenAI/Gemini/호환
// 엔드포인트)가 실제로 생겨 그 seam 을 낸다. `compatible`(사용자 지정 base URL)이 Azure OpenAI·
// OpenRouter·사내 게이트웨이·로컬 LLM(Ollama/vLLM)까지 커버하므로 프로바이더는 이 4개로 고정한다
// (ponytail — 더 늘리지 않는다).
export const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'compatible'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]
export const DEFAULT_AI_PROVIDER: AiProvider = 'anthropic'
// 목록 밖 문자열 클램프(신뢰 경계 밖 입력용) — provider 는 어댑터 테이블의 키라 알려진 4개 밖의
// 값이 들어오면 테이블 조회 자체가 깨진다. 모델명과 달리 자유 입력을 허용하지 않는다.
export function aiProviderOf(value: unknown): AiProvider {
  return AI_PROVIDERS.includes(value as AiProvider) ? (value as AiProvider) : DEFAULT_AI_PROVIDER
}

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
  google: 'Google Gemini',
  compatible: '호환 엔드포인트'
}

// 프로바이더가 고정 호스트로 전송하는 곳(반출 고지·설정 화면에 "어디로 전송되는지" 상시 표시하는 데
// 쓴다). compatible 은 고정 호스트가 없다 — 사용자가 입력한 baseUrl 에서 파싱한다(shared/aiBaseUrl).
export const AI_PROVIDER_HOSTS: Record<Exclude<AiProvider, 'compatible'>, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  google: 'generativelanguage.googleapis.com'
}

// 설정 UI 추천 모델 목록(자유 입력도 항상 허용 — 목록 밖 문자열도 그대로 쓸 수 있다). anthropic 만
// 날짜 접미사 없는 별칭이 API 계약이다(`claude-sonnet-5-2026xxxx` 는 404). 나머지는 추천값일 뿐이라
// 낡아도(신모델 출시) 기능이 깨지지 않는다 — 자유 입력이 항상 열려 있다.
export const AI_MODELS_BY_PROVIDER: Record<AiProvider, readonly string[]> = {
  anthropic: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
  openai: ['gpt-5.1', 'gpt-4.1', 'gpt-4o-mini'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  compatible: [] // 사용자 게이트웨이마다 모델명이 다르다 — 추천 목록 없이 자유 입력만.
}
export const DEFAULT_AI_MODEL_BY_PROVIDER: Record<AiProvider, string> = {
  anthropic: 'claude-sonnet-5',
  openai: AI_MODELS_BY_PROVIDER.openai[0],
  google: AI_MODELS_BY_PROVIDER.google[0],
  compatible: ''
}
// 하위 호환: 마이그레이션(v4→v5)이 옛 단일 aiModel 필드를 anthropic 모델로 옮길 때 쓴다.
export const DEFAULT_AI_MODEL = DEFAULT_AI_MODEL_BY_PROVIDER.anthropic

// 모델명은 자유 입력이라(설계 §1 구조 결정) 목록 클램프를 하지 않는다 — 대신 개행·제어문자를 지우고
// 길이를 상한해 시스템 프롬프트·요청 조립에 삽입 공격 표면을 만들지 않는다(env.cwd 와 같은 판단).
const MODEL_NAME_MAX = 200
export function sanitizeModelName(value: unknown): string {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MODEL_NAME_MAX)
}
// UiState(옵셔널·부분) → UiPrefs(프로바이더 4개 전부 확정값) — 손상·구버전 스냅샷에서 빠진 프로바이더는
// 그 프로바이더의 기본 모델로 채운다. 렌더러(하이드레이트)와 main(요청 조립)이 같은 함수를 쓴다.
export function aiModelsOf(raw: unknown): Record<AiProvider, string> {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<AiProvider, unknown>>
  const out = {} as Record<AiProvider, string>
  for (const p of AI_PROVIDERS) {
    out[p] = sanitizeModelName(src[p]) || DEFAULT_AI_MODEL_BY_PROVIDER[p]
  }
  return out
}

// 컨텍스트로 첨부하는 터미널 꼬리 줄 수. 상한이 있어야 스크롤백이 통째로 외부 API 로 나가지 않는다.
// 설정으로 노출하지 않는다(값이 바뀌지 않는 것에 설정을 만들지 않는다).
export const AI_CONTEXT_LINES = 120

// 우측 액티비티 바 항목(FB-ui2). 2026-08-13 부터 **끄고 켜고 순서를 바꿀 수 있어** 설정으로
// 저장되므로 shared 에 둔다 — 렌더러 화면 지식이 아니라 저장되는 값의 스키마다.
// 아래 순서가 **기본 순서**이자, 저장된 목록에 없는 새 항목이 뒤에 붙는 기준이다.
export type ActivityId =
  | 'ai'
  | 'monitor'
  | 'sys'
  | 'aisess'
  | 'log'
  | 'preview'
  | 'explorer'
  | 'console'
  | 'settings'

export const ACTIVITY_ITEMS: readonly ActivityId[] = [
  'ai',
  'monitor',
  'sys',
  'aisess',
  'log',
  'preview',
  'explorer',
  'console',
  'settings'
] as const

// 우측 레일 — 터미널 옆에 붙어 **폭을 뺏는다.** #79(2026-08-14)부터 한 번에 하나만 열린다.
//
// #78(2026-08-15): 여섯이었는데 넷으로 줄었다. **가로가 필요한 것은 아래로 내려갔다** —
// 포트 목록(주소·포트·프로세스 3열)과 세션 기록(로그 한 줄)을 280~340px 세로 레일에 넣은 것이
// 애초에 안 맞았다. 남은 넷은 세로가 맞는 것들이다: 대화(ai)·카드 목록(preview·aisess)·그래프(sys).
export const RAIL_IDS = ['ai', 'sys', 'aisess', 'preview'] as const
export type RailId = (typeof RAIL_IDS)[number]

export function isRailId(id: ActivityId): id is RailId {
  return (RAIL_IDS as readonly string[]).includes(id)
}

// 하단 패널 — 터미널 **아래**에 붙어 세로만 먹는다(터미널 80칸에 영향이 없다).
// 액티비티 바 항목은 그대로 두고, 누르면 하단 패널이 그 탭으로 열린다 — 바를 옮기지 않는 이유는
// 우리 바가 "무엇을 열지"를 고르는 것이지 VS Code 처럼 "사이드바 내용을 바꾸는" 것이 아니어서다.
export const BOTTOM_IDS = ['monitor', 'log'] as const
export type BottomId = (typeof BOTTOM_IDS)[number]

export function isBottomId(id: ActivityId): id is BottomId {
  return (BOTTOM_IDS as readonly string[]).includes(id)
}

// 설정 창이 한 덩어리로 저장하는 터미널 동작(ui:setPrefs). UiState 의 부분집합이지만 이쪽은
// 기본값이 채워진 확정값만 담는다 — 화면·xterm 에 그대로 꽂을 수 있어야 하기 때문이다.
export type UiPrefs = {
  // UI-font5: UI 글자·행 높이 배율. 터미널 글자는 별개(F5 ui.font).
  uiScale: UiScale
  scrollback: number
  copyOnSelect: boolean
  cursorStyle: CursorStyle
  cursorBlink: boolean
  bell: BellStyle
  // F12: 세션 로그 기록 여부·보존 기간. 전용 설정 채널을 만들지 않고 이 묶음에 얹는다.
  sessionLog: boolean
  logRetentionDays: number
  // W5: 아라가 쓸 프로바이더 + 프로바이더별 모델(4개 전부 확정값 — aiModelsOf 가 채운다).
  // API 키는 여기 없다 — 키는 프로바이더별로 vault 에만 있고(`ai.apiKey.<provider>`) 이 묶음은
  // workspace.json 으로 간다. baseUrl 은 compatible 전용, 비밀이 아니라(사용자가 직접 보는 값) vault 대상이 아니다.
  aiProvider: AiProvider
  aiModels: Record<AiProvider, string>
  aiCompatibleBaseUrl: string
  // 우측 액티비티 바(2026-08-13): 항목 순서 + 숨긴 항목. 순서는 **전체 목록**을 담고, 숨김은 그중
  // 안 보이는 것만 담는다 — 껐다 켜도 원래 자리로 돌아오게 하려면 순서를 잃지 말아야 한다.
  activityOrder: ActivityId[]
  activityHidden: ActivityId[]
}

// 사이드바 상태(R4.3). 스키마는 F1부터 있었지만 아무도 읽지 않는 죽은 필드였다 — 폭 드래그·접힘·
// 활성 탭을 실제로 여기에 싣고 재시작 후 복원한다.
// W1 F9: 'monitor'(포트 모니터) 탭이 세 번째로 붙었었다.
// FB-ui2: 모니터를 우측 액티비티 바로 이관하면서 사이드바에는 다시 conn/file 두 탭만 남았다.
// 옛 스냅샷에 'monitor' 가 남아 있을 수 있어 읽는 쪽(store/sidebar.ts)이 그 값을 conn 으로 되돌린다.
export type SidebarState = { collapsed: boolean; activeTab: 'conn' | 'file'; width: number }

export type UiState = {
  sidebar: SidebarState
  // #67(2026-08-14): ctxMenuStyle 이 여기 있었다. 라디얼·팔레트를 지워 고를 것이 없어졌다 —
  // 옛 스냅샷에 남아 있는 키는 읽는 쪽이 없어 그대로 무시된다(마이그레이션 불필요).
  font: FontConfig
  locale: string
  // UI-font5 [일반]: UI 글자·행 높이 배율 이름. 미지정이면 normal. uiScaleOf 가 클램프한다.
  uiScale?: string
  // 스크롤백 줄 수 / 드래그 선택 즉시 복사(X11·PuTTY 관례). 미지정이면 위 기본값.
  scrollback?: number
  copyOnSelect?: boolean
  // R5 [터미널]: 커서 모양·깜빡임·벨. 미지정이면 위 DEFAULT_* 상수.
  cursorStyle?: CursorStyle
  cursorBlink?: boolean
  bell?: BellStyle
  // F12 [로그]: 세션 로그 기록·보존 기간. 미지정이면 꺼짐 / 30일.
  sessionLog?: boolean
  logRetentionDays?: number
  // W5 [AI]: 아라가 쓸 프로바이더 + 프로바이더별 모델. 미지정 필드는 aiProviderOf/aiModelsOf 가
  // 기본값으로 채운다. 키는 여기 없다(vault 전용, 프로바이더별로 분리 저장).
  aiProvider?: AiProvider
  aiModels?: Partial<Record<AiProvider, string>>
  // compatible 전용 base URL. 비밀이 아니다 — 설정 화면에 항상 보이는 값(전송 대상 투명성).
  aiCompatibleBaseUrl?: string
  // 우측 액티비티 바 항목 순서·숨김(2026-08-13). 저장된 값은 신뢰 경계 밖이라 읽는 쪽에서
  // activityOrderOf/activityHiddenOf 가 모르는 이름을 버리고 새 항목을 뒤에 채운다.
  activityOrder?: string[]
  activityHidden?: string[]
  // R6: 프로필에서 파생되지 않는 그룹까지 담는 목록. 프로필이 있는 그룹은 파생으로 나오므로
  // 여기 저장이 필요한 것은 "빈 그룹"이지만, 이름 변경·삭제를 한 곳에서 처리하려고 전체를 싣는다.
  groups?: string[]
  // 작업 프로필: "이 서버의 이 폴더"를 이름 붙여 저장해 둔 목록. 연결 프로필(ConnectionProfile)과
  // 별개다 — 하나의 서버에 여러 작업 위치가 붙을 수 있고, 로컬 폴더도 같은 목록에 들어간다.
  workProfiles?: WorkProfile[]
  // F27: AI CLI 를 시작한 조합(서버+폴더+CLI+플래그) 최근 목록. 작업 프로필과 달리 **저장이 전제가
  // 아니다** — 시작하면 저절로 쌓이고, 상한(AI_CLI_RECENT_MAX)을 넘으면 오래된 것부터 버린다.
  // 비밀은 없다(서버는 profileId 로만 참조).
  aiCliRecent?: AiCliRecent[]
  window?: WindowBounds // F6: 복원 대상. 최초 실행 시 없음.
}

/**
 * 작업 프로필 — 접속 대상 + 시작 폴더. 비밀은 없다(연결 정보는 profileId 로 참조만 한다).
 * profileId=null 이면 로컬 셸을 그 폴더에서 연다.
 */
export type WorkProfile = { id: string; name: string; profileId: string | null; path: string }

// W1 F9 포트 모니터: 원격 리슨 포트 한 줄. pid/process 는 권한 없으면 ss 가 비워 보낸다.
export type RemotePort = { proto: 'tcp' | 'tcp6'; port: number; pid?: number; process?: string }

// W1 F10 리소스 바: 원격 CPU/메모리(+GPU). gpu* 는 nvidia-smi 가 있는 서버에서만 채워진다.
// GPU 메모리는 MiB 단위(nvidia-smi 가 주는 단위 그대로 — KB 로 바꿔 담으면 곱하기 실수만 는다).
export type RemoteStats = {
  cpuPct: number
  memUsedKb: number
  memTotalKb: number
  gpuPct?: number
  gpuMemUsedMb?: number
  gpuMemTotalMb?: number
}

// F29 시스템 모니터. 파일시스템 한 칸(로컬 statfs · 원격 df 양쪽이 이 모양으로 맞춰 들어온다).
export type DiskUsage = { mount: string; totalKb: number; usedKb: number; usePct: number }

// F29 [로컬] 탭 — 세션과 무관한 내 PC 상태. RemoteStats 와 필드를 겹쳐 두어 화면이 같은 코드로 그린다.
// gpuPct 는 없다: Windows 에 무의존 조회 방법이 없고, 원격처럼 nvidia-smi 를 부르는 것은 내 PC 에서
// 외부 명령을 주기적으로 실행하는 일이라 하지 않는다(LocalTelemetry.ts 머리주석의 기존 판단 유지).
export type HostStats = {
  cpuPct: number
  memUsedKb: number
  memTotalKb: number
  disks: DiskUsage[]
  hostname: string
  platform: string
}

// W2 F8 활성 포트 포워딩 한 줄(내 PC 127.0.0.1:localPort → 원격 127.0.0.1:remotePort).
// ⚠️ 호스트 필드가 **없다**. 로컬 바인드도 원격 목적지도 main 이 loopback 으로 하드코딩하므로
// 렌더러는 "어느 호스트로 터널을 팔지"를 타입 수준에서 표현할 수 없다 — 사내망 피벗에 대한 1차 방어다(설계 §4.2).
export type PortForward = {
  id: string // `${sessionId}:${remotePort}` — 멱등 키(같은 포트를 두 번 열지 않는다)
  sessionId: string
  remotePort: number
  localPort: number // 실제 바인딩된 포트. exact=false 면 remotePort 와 다르다
  exact: boolean // 요청한 번호 그대로 열렸는가(OAuth 성립 조건 — redirect_uri 에 번호가 박혀 있다)
  conns: number // 현재 열린 소켓 수(표시용)
  lastError?: string // 마지막 forwardOut 실패 사유(원격이 아직 안 듣고 있음 등)
}

// 포워딩 생성 결과. 예외 대신 판별 유니온 — 실패 사유마다 UI 처리가 다르다
// (portInUse 는 다이얼로그로 중단을 알리고, 임의 포트로 조용히 넘어가지 않는다).
export type ForwardResult =
  | { ok: true; forward: PortForward }
  | { ok: false; reason: 'noSession' | 'portInUse' | 'invalid'; message: string }

// ── F16 아라 대화 (설계 §6) ────────────────────────────────────────────
// 프롬프트에 함께 실리는 최소 환경 정보. 호스트명·사용자명·IP·프로필명은 **없다** —
// 사내 인프라 식별자라 SSH 세션이라는 사실만 알리고 어느 서버인지는 알리지 않는다(설계 §3.5).
// (셸 이름은 넣지 않는다 — 렌더러가 들고 있지 않은 값이라 채울 사람이 없다. 필요해지면 그때 붙인다.)
export type AiEnv = { os: string; sessionType: SessionType; cwd?: string }

// 채팅 한 턴. id/at 은 F23 감사 추적이 지목할 좌표(설계 §5) — 지금은 렌더러 key 로도 쓴다.
export type AiTurn = {
  id: string
  at: number
  role: 'user' | 'assistant'
  text: string
  // 사용자 턴에 첨부된 컨텍스트(**이미 마스킹된** 텍스트). 사용자가 "내가 뭘 보냈나"를 되짚는 데 쓴다.
  context?: string
  // assistant 턴 종료 사유. 'canceled' 는 사용자가 중단한 것.
  end?: 'done' | 'canceled' | 'error'
  error?: string
}

// 아라 패널이 마운트/재마운트 시 받아 가는 전량(session:attach 와 같은 역할).
// ⚠️ API 키는 여기 존재하지 않는다 — hasKey 뿐이다. 키를 반환하는 채널이 계약에 없다는 것이 불변식이다.
export type AiState = {
  hasKey: boolean // 현재 선택된 provider 의 키 보유 여부(프로바이더별로 분리 저장 — 설계 W5 §3)
  provider: AiProvider
  model: string // W5: 자유 입력이라 AiModel 유니온이 아니라 string(설계 §1 구조 결정)
  turns: AiTurn[]
  streaming: boolean // 재마운트 시 진행 중 턴이 있으면 스피너 복원
  usage: { input: number; output: number } // 이번 실행 누적(설계 §8-2 — 표시만, 상한 미강제)
  // #80: 입력 예산(10만 토큰) 때문에 앞에서 버린 턴 수. 0 이 아니면 패널이 "이전 대화 N개
  // 생략됨"을 띄운다 — 조용히 버리면 모델이 왜 앞을 잊었는지 사용자가 알 길이 없다.
  droppedTurns: number
}

// 키 저장 결과. 예외 대신 구조화 — 사유마다 화면 문구가 다르다.
export type AiKeyResult =
  | { ok: true }
  | { ok: false; reason: 'auth' | 'network' | 'noEncryption' | 'model'; message: string }

// 스트림 종료. 오류는 예외 대신 구조화(패널 안 시스템 말풍선으로 표시, 다이얼로그 금지).
export type AiEnd =
  | { turnId: string; ok: true }
  | {
      turnId: string
      ok: false
      reason: 'noKey' | 'auth' | 'rateLimit' | 'network' | 'canceled' | 'api'
      message: string
    }

// 사람이 읽는 영속 스냅샷 루트 (비밀 제외 — 비밀은 secrets.vault).
export type WorkspaceSnapshot = {
  schemaVersion: number
  savedAt: string
  app: { version: string }
  profiles: ConnectionProfile[]
  knownHosts: Record<string, KnownHost>
  layout: LayoutNode
  sessions: Session[]
  tabGroups: TabGroup[]
  ui: UiState
}

// 렌더러가 소유한 부분만 = workspace:save 페이로드. profiles·knownHosts·ui 의 주인은 main 이고
// (profile:*, ssh:forgetHostKey, ui:set*) 각각 즉시 flush 하므로, 렌더러가 읽어 둔 사본을 스냅샷째
// 되돌려 보내면 그 사이 일어난 삭제·재설정이 되살아난다. 타입으로 아예 보낼 수 없게 막는다.
export type WorkspaceSaveInput = Pick<WorkspaceSnapshot, 'sessions' | 'layout' | 'tabGroups'>

// ── W4 F23 MCP 조종 모드 (설계 §6/§7) ──────────────────────────────────
// 세션별 권한 상태. 전역 스위치가 아니다 — 세션 A 를 자동 허용해도 세션 B 는 그대로 승인 모드다.
// 재시작 시 전부 'approval' 로 복귀한다(영속하지 않는다 — 어디에도 저장하지 않는 것이 그 계약이다).
export type McpSessionMode = 'readOnly' | 'approval' | 'autoAllow'
export type McpSessionState = { sessionId: string; mode: McpSessionMode; autoAllowUntil?: number }

// 상수(설정으로 노출하지 않는다 — 값이 바뀌지 않는 것에 설정을 만들지 않는다, AI_CONTEXT_LINES 와 같은 원칙).
export const MCP_DEFAULT_PORT = 39217
export const MCP_AUTO_ALLOW_MINUTES = 10
export const MCP_AUTO_ALLOW_MAX_MINUTES = 60 // D3: setMode() 의 minutes 상한 — 신뢰 경계(main)가 강제한다.
export const MCP_RATE_LIMIT_PER_MIN = 20
export const MCP_APPROVAL_TIMEOUT_MS = 2 * 60 * 1000

export type McpState = {
  enabled: boolean
  port: number
  hasToken: boolean // 토큰 원문은 여기 없다 — 발급 순간에만 mcp:issueToken 응답으로 1회 나간다
  connected: number
  sessions: McpSessionState[]
  handedBack: boolean // D2: 인계 중이면 session_create/ssh_connect 를 즉시 거부한다(상태바 표시용).
}

// 승인 다이얼로그가 그릴 요청. argsSummary 는 이미 마스킹된 표시용 문자열(원본 그대로 렌더러에 안 보낸다).
export type McpApprovalRequest = {
  requestId: string
  sessionId: string
  tool: string
  argsSummary: string
  expiresAt: number
}
export type McpApprovalDecision =
  | { requestId: string; decision: 'approve' }
  | { requestId: string; decision: 'deny' }
  | { requestId: string; decision: 'autoAllow'; minutes: number } // 해당 세션 전체를 autoAllow 로

// 상태바·활동 로그가 실시간으로 그리는 이벤트(push).
export type McpActivity = {
  seq: number
  at: number
  sessionId: string
  tool: string
  outcome: 'auto' | 'approved' | 'denied' | 'timeout' | 'rateLimited'
}
