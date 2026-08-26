// 아라 프롬프트 조립 — 순수 함수만. 네트워크·전역 상태·electron 을 만지지 않는다(단위 테스트 대상).
//
// 이 파일이 **컨텍스트가 네트워크로 나가기 전 마지막 관문**이다. 렌더러도 미리보기용으로
// maskSecrets 를 돌리지만 그것은 이중 방어일 뿐이고, 실제 방어선은 여기다: 호출자가 무엇을
// 보내든 buildRequest 를 통과한 본문에는 마스킹되지 않은 비밀이 남지 않는다(설계 §3.3).
import { maskSecrets } from '@shared/maskSecrets'
import { AI_CONTEXT_LINES, type AiEnv, type AiTurn } from '@shared/types'
import { estimateTokens, trimToBudget, INPUT_BUDGET_TOKENS } from './budget'

// 출력 상한. 스트리밍 권장치(64K)보다 낮게 잡은 의도적 하향이다 — 사내 배포 + 개인 키 과금
// 환경에서 채팅 한 턴이 16K 출력을 넘는 것은 정상 상황이 아니다(설계 §1).
export const MAX_TOKENS = 16000
// 추론 깊이. 터미널 질문 대부분은 깊은 추론이 필요 없다. 상수다 — 설정으로 노출하지 않는다.
export const EFFORT = 'medium' as const

// 첨부한 터미널 출력을 감싸는 구분자. 사용자 질문과 기계 출력의 경계를 모델에게 알린다.
const CTX_OPEN = '<터미널 출력>'
const CTX_CLOSE = '</터미널 출력>'

// 한국어 페르소나(설계 §4.5). "실행했다고 말하지 마세요"가 F16 에서 가장 중요한 한 줄이다 —
// 실행 능력이 없는데 실행한 척하는 답변이 F23(승인 모델) 이전 단계에서 가장 위험한 실패 모드다.
const PERSONA = [
  '당신은 "아라"입니다. A.R.A 터미널에 내장된 개발 어시스턴트입니다.',
  '',
  '- 한국어 존댓말로, 짧고 단정하게 답합니다. 서론·요약·자기소개를 붙이지 않습니다.',
  '- 셸 명령은 반드시 펜스 코드블록으로 감싸고, 블록 하나에 명령 하나만 넣습니다.',
  '  사용자가 클릭하면 그 블록이 터미널 입력에 그대로 들어갑니다.',
  '- 되돌릴 수 없는 명령(삭제·덮어쓰기·강제 종료)은 무엇이 사라지는지 한 줄로 먼저 밝힙니다.',
  '- 당신은 명령을 실행할 수 없습니다. 실행했다거나 결과를 확인했다고 말하지 마세요.',
  '- 터미널 출력이 첨부되지 않았으면 추측하지 말고 무엇이 필요한지 물어보세요.'
].join('\n')

// 정당한 호출자(Shell.tsx)가 실제로 보내는 값만 통과시킨다. env 는 IPC 를 건너온 값이라 타입은
// 컴파일 타임 약속일 뿐 런타임에는 아무 문자열이든 실릴 수 있다 — 화이트리스트 밖은 위조로 보고
// 안전 기본값으로 떨어뜨린다(보안 리뷰 M1). cwd 는 자유 문자열이라 개행·제어문자를 지우고 길이를
// 잘라 프롬프트 구조를 깨는 삽입·가짜 시스템 태그를 막는다.
const KNOWN_OS = ['win32', 'darwin', 'linux']
const KNOWN_SESSION_TYPES = ['local', 'ssh']
const ENV_CWD_MAX = 200

function sanitizeCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string' || !cwd) return undefined
  // eslint-disable-next-line no-control-regex
  const cleaned = cwd.replace(/[\x00-\x1f\x7f]+/g, ' ').trim()
  return cleaned ? cleaned.slice(0, ENV_CWD_MAX) : undefined
}

function normalizeEnv(env: AiEnv): AiEnv {
  const os = typeof env?.os === 'string' && KNOWN_OS.includes(env.os) ? env.os : 'unknown'
  const sessionType =
    typeof env?.sessionType === 'string' && KNOWN_SESSION_TYPES.includes(env.sessionType)
      ? (env.sessionType as AiEnv['sessionType'])
      : 'local'
  const cwd = sanitizeCwd(env?.cwd)
  return { os, sessionType, ...(cwd ? { cwd } : {}) }
}

// 환경 한 줄. 호스트명·사용자명·IP 를 **넣을 자리가 없다** — 사내 인프라 식별자이므로
// SSH 세션이라는 사실(sessionType)만 알리고 어느 서버인지는 알리지 않는다(설계 §3.5).
function envLine(env: AiEnv): string {
  const safe = normalizeEnv(env)
  const parts = [`${safe.os} 에서 ${safe.sessionType} 세션`]
  if (safe.cwd) parts.push(`cwd: ${safe.cwd}`)
  return `사용자는 한국어를 쓰는 개발자이고, 지금 ${parts.join(', ')}을 보고 있습니다.`
}

/**
 * B 엔진(API 키)이 쓸 말투 글.
 *
 * **2026-08-26 이전에는 아래 F16 시절 PERSONA 를 그대로 썼다.** 그래서 CLI 쪽에 #138 로 넣은
 * 호칭·서버 표·노출 규칙이 API 대화에는 하나도 안 갔다 — 준영님이 API 로 *"kvt 연결해줘"* 했을 때
 * 아라가 *"kvt가 어떤 서비스인지 모르겠다, `which kvt` 를 쳐 보시라"* 고 답한 이유가 이것이다.
 * **서버 이름을 아예 몰랐다.**
 *
 * 이제 말투 글은 한 벌이고(shared/araPersona.ts) 도구 유무만 갈린다. 주입이 없으면 예전 글로
 * 떨어진다 — 테스트와 옛 호출자를 위해서다.
 */
let personaFor: (() => string) | null = null
export function setApiPersona(fn: (() => string) | null): void {
  personaFor = fn
}

export function systemPrompt(env?: AiEnv): string {
  const base = personaFor?.() ?? PERSONA
  if (!env) return base
  const [head, ...rest] = base.split('\n')
  return [head, envLine(env), ...rest].join('\n')
}

// 컨텍스트 상한(보안 리뷰 M2) — AI_CONTEXT_LINES(120)는 AiPanel.tsx 의 tailLines 관행일 뿐이라
// main(신뢰 경계)이 강제하지 않으면 다음 호출자가 그 규율을 안 지켜도 그대로 통과한다. 줄 수·문자
// 수를 둘 다 강제해 개행 없는 대용량 단일 줄도 잡는다(리뷰가 실측한 5MB 단일 줄 사례). 뒤쪽(최근
// 출력)을 남기고 앞을 자른다.
const CTX_MAX_LINE_CHARS = 2000 // 줄당 최대 문자수 가정 — AI_CONTEXT_LINES 와 곱해 총 문자 상한을 만든다.
const CTX_MAX_CHARS = AI_CONTEXT_LINES * CTX_MAX_LINE_CHARS

// F23: session_read(MCP)도 같은 상한을 쓴다 — "MCP 읽기용" 상수를 새로 만들지 않는다(설계 §1.5).
export function capContext(raw: string): string {
  const lines = raw.split('\n')
  const kept = lines.length > AI_CONTEXT_LINES ? lines.slice(-AI_CONTEXT_LINES) : lines
  let text = kept.join('\n')
  let truncated = kept.length < lines.length
  if (text.length > CTX_MAX_CHARS) {
    text = text.slice(-CTX_MAX_CHARS)
    truncated = true
  }
  return truncated ? `(...앞부분 잘림...)\n${text}` : text
}

// 사용자 한 턴의 본문. 컨텍스트는 여기서 상한을 강제한 뒤 다시 마스킹된다 — 이미 마스킹된
// 문자열에 또 걸려도 결과가 같으므로(maskSecrets 는 멱등) 미리보기와 전송본이 글자 단위로 일치한다.
export function userContent(turn: AiTurn): string {
  if (!turn.context) return turn.text
  return `${turn.text}\n\n${CTX_OPEN}\n${capContext(maskSecrets(turn.context))}\n${CTX_CLOSE}` // D1: 마스킹을 먼저(절단 경계에서 비밀이 새는 것을 막는다)
}

// W5: 프로바이더 무관 중립 모양(camelCase) — Anthropic 전용이던 max_tokens/output_config.effort 를
// 어댑터가 각자의 와이어 포맷으로 변환한다(providers/anthropic.ts 가 max_tokens 로 되돌린다).
// model 은 자유 입력(설계 §1)이라 AiModel 유니온이 아니라 string.
export type AiRequestCore = {
  model: string
  maxTokens: number
  effort: typeof EFFORT
  system: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  /** #80: 예산 때문에 앞에서 버린 턴 수. 0 이 아니면 화면이 "이전 대화 N개 생략됨"을 알린다. */
  droppedTurns: number
}

// 대화 전량 → 프로바이더 무관 요청 본체. 본문이 빈 assistant 턴(진행 중·취소된 빈 턴)은 싣지 않는다 —
// API 가 빈 content 를 400 으로 거부하고, 보낼 내용도 없다. AraSession 이 여기에 provider/apiKey/baseUrl
// 을 얹어 어댑터로 넘긴다(providers/types.ts 의 AiRequest).
//
// ⚠️ temperature/top_p/top_k 를 넣지 않는다(Sonnet 5·Opus 5 는 비기본값을 400 으로 거부한다).
// ⚠️ thinking 을 명시하지 않는다(생략 시 adaptive). budget_tokens 는 400 이다.
export function buildRequestCore(turns: AiTurn[], model: string, env?: AiEnv): AiRequestCore {
  const live = turns.filter((t) => t.role === 'user' || t.text.length > 0)
  // #80: **첨부한 터미널 출력은 마지막 사용자 턴에만 싣는다.** 예전에는 3턴 전 `ps aux` 출력을
  // 매 요청마다 다시 보냈다 — 이 앱은 로그·exec 결과를 붙여 묻는 기능이 있어 그게 컨텍스트의
  // 대부분을 차지한다. 사용자가 되짚어 볼 원본은 AiTurn.context 에 그대로 남아 있다(화면용).
  const lastUser = live.map((t) => t.role).lastIndexOf('user')
  const messages = live.map((t, i) => ({
    role: t.role,
    content: t.role === 'user' ? (i === lastUser ? userContent(t) : t.text) : t.text
  }))

  const system = systemPrompt(env)
  // 시스템 프롬프트도 입력이다 — 예산에서 먼저 뺀다.
  const { kept, dropped } = trimToBudget(messages, INPUT_BUDGET_TOKENS - estimateTokens(system))
  return {
    model,
    maxTokens: MAX_TOKENS,
    effort: EFFORT,
    system,
    messages: kept,
    droppedTurns: dropped
  }
}
