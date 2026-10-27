import type { KeymapAction } from './keymap'

/**
 * 기능 스위치 — **끄는 자리를 한 곳으로 모은다.**
 *
 * 지우는 것과 숨기는 것은 다르다. 지우면 되살릴 때 다시 만들어야 하고, 흩어진 채 반쯤 켜 두면
 * 어디는 보이고 어디는 안 보이는 상태가 된다. 그래서 **코드는 그대로 두고 진입점만** 이 파일의
 * 상수 하나로 막는다.
 */

/**
 * 아라 대화(내장 AI 채팅) — **0.1.0 배포에서는 숨긴다** (2026-08-23 준영님 결정).
 *
 * 왜: 준영님이 "내 터미널에 등록된 서버가 뭐가 있냐"고 물었을 때 아라가 일반론(`~/.ssh/config`
 * 를 확인해 보세요)을 답했다. 아라 대화는 **앱의 상태를 하나도 모르는** 그냥 LLM 이기 때문이다
 * (MCP 는 반대 방향 — 바깥 AI 가 우리 터미널을 조종하는 서버다). 도구 호출·세션 인지·컨텍스트
 * 관리가 갖춰지기 전에는 "터미널에 붙은 AI"라고 부를 수 없으므로, 반쯤 되는 채로 내보내지 않는다.
 *
 * **지금 이 값이 끄는 것은 없다**(AUDIT-R5 에서 바로잡았다 — 전에는 여기에 "우측 레일 [대화] ·
 * Alt+A · Ctrl+Shift+A · 우클릭 [아라에게 질문] · AI 부트스트랩 · 설정 [AI]" 여섯을 숨긴다고
 * 적혀 있었는데 **여섯 다 켜져 있다**). 그 여섯은 전부 아래 AI_ENTRY 가 문을 지키고,
 * `AI_ENTRY = AI_CHAT || ARA_CHAT` 인데 #125 에서 `ARA_CHAT = true` 가 되어 상수 true 다.
 * 옛 AiPanel 화면도 이 값이 아니라 `ARA_CHAT` 이 가른다(Shell.tsx 의 삼항).
 * 살아 있는 소비자는 `tests/e2e/ai.spec.ts` 하나 — 이 값을 보고 스스로 건너뛴다.
 *
 * 그래도 남겨 둔다: `ARA_CHAT` 을 되돌리는 날 **무엇을 다시 켜는지**를 이 문장이 갖고 있고,
 * 그때 `AI_ENTRY` 가 다시 이 값을 본다. 옛 화면 정리(AiPanel 404줄)는 그 결정과 함께 한다.
 */
export const AI_CHAT = false

/**
 * 아라 대화 v2(#125) — **되살아난 그 자리**.
 *
 * 위 AI_CHAT 이 끈 것은 "앱의 상태를 하나도 모르는 그냥 LLM"이었다. 이건 다른 물건이다:
 * 로컬 Claude Code 를 상주 프로세스로 띄우고(#123), 아라 MCP 도구를 물리고(#124), 갈림길에서
 * 사람에게 되묻는다(#125). 준영님이 처음 물었던 *"내 터미널에 등록된 서버가 뭐가 있냐"* 에
 * **실제로 답할 수 있는** 상태가 됐기 때문에 다시 켠다.
 *
 * AI_CHAT 은 여전히 false 다 — 그것이 끄는 것은 **옛 대화 화면**(AiPanel: API 키로 도는 순수 LLM)
 * 하나뿐이다. #127 에서 그 화면으로 가던 진입점들을 새 패널로 돌려놓았다.
 */
export const ARA_CHAT = true

/**
 * **아라 대화로 가는 문이 열려 있나**(#127).
 *
 * 우클릭 [아라에게 묻기]·`Alt+A`·메뉴바·프로세스 표의 [아라에게 묻기]는 전부 **우측 ai 레일**로
 * 간다. 그 레일에 무엇이 걸려 있든(옛 AiPanel 이든 새 AraChatPanel 이든) 문이 있으면 열어야 한다 —
 * 자리마다 `AI_CHAT || ARA_CHAT` 을 쓰면 하나 빠뜨렸을 때 "메뉴엔 있는데 안 열리는" 항목이 생긴다.
 */
export const AI_ENTRY = AI_CHAT || ARA_CHAT

// 음성 모드(말로 아라 부르기)는 **없다** — 2026-09-05 준영님 결정으로 코드째 걷었다(#140).
// 마이크·받아쓰기·읽어 주기를 한 번도 소리로 확인하지 못한 채 반 년을 숨긴 플래그로 들고 있었고,
// 그동안 vosk-browser 5.5MB 가 못 쓰는 채로 설치본에 실렸다. 되살릴 계획은 없다.

/**
 * 2.0 3단계 — **사용자가 고르는 기능 표시**(설정 › 기능). 위 상수들과 같은 방식이다: 코드는 그대로 두고
 * **진입점만**(하단 패널 탭 · 메뉴바 · 좌측 레일) 막는다. 단축키와 통합 검색은 숨겨도 늘 실행되고,
 * 실행한 그 순간에는 보인다(하단 탭은 BottomPanel 이 "열린 탭은 목록에 없어도 그린다"로 이미 그렇게 한다).
 *
 * `hidden` = 기본 숨김(0단계 "덜어낼 기능 후보" 표, 2026-10-27 준영님 결정).
 * `key` = 이 기능을 여는 KEYMAP 액션, `menu` = 메뉴바 명령 id — 메뉴·검색에서 이 기능을 알아보는 열쇠이자
 * 설정 화면의 단축키 칸이다. **이 표에 단축키를 새로 만들지 않는다**(없으면 빈칸).
 *
 * 브라우저 창은 여기 없다: 따로 여는 자리가 없고(포트 [열기]·터미널 링크가 그 결과로 띄운다)
 * 숨길 진입점이 없다 — 스위치를 달면 눌러도 아무 일 없는 스위치가 된다.
 */
export type FeatureId =
  | 'monitor'
  | 'sys'
  | 'ps'
  | 'svc'
  | 'disk'
  | 'pkg'
  | 'ctr'
  | 'log'
  | 'pastlog'
  | 'explorer'
  | 'cmdbook'
  | 'k8s'
  | 'applog'
  | 'console'

export type Feature = { id: FeatureId; hidden?: true; key?: KeymapAction; menu?: string }

export const FEATURES: readonly Feature[] = [
  { id: 'monitor', menu: 'panel.ports' },
  { id: 'sys', menu: 'panel.sysmon' },
  { id: 'ps', menu: 'panel.ps' },
  { id: 'svc', menu: 'panel.svc' },
  { id: 'disk', menu: 'panel.disk' },
  { id: 'pkg', menu: 'panel.pkg' },
  { id: 'ctr', menu: 'panel.ctr' },
  { id: 'log', menu: 'panel.log', key: 'log.save' },
  { id: 'pastlog', menu: 'panel.pastlog' },
  { id: 'explorer', key: 'explorer.toggle' },
  { id: 'cmdbook', key: 'commandBook.toggle' },
  { id: 'k8s', menu: 'panel.k8s', hidden: true },
  { id: 'applog', menu: 'panel.applog', hidden: true },
  { id: 'console', menu: 'panel.console', hidden: true }
]

export type FeatureShown = Record<FeatureId, boolean>

/** 저장된 값(신뢰 경계 밖 — 손으로 고친 파일·옛 파일) → 기능마다 보이나. 모르는 값은 기본으로. */
export function featuresOf(raw: unknown): FeatureShown {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return Object.fromEntries(
    FEATURES.map((f) => [f.id, typeof r[f.id] === 'boolean' ? r[f.id] : !f.hidden])
  ) as FeatureShown
}

/** 메뉴·검색 항목 id(KEYMAP 액션 또는 메뉴 명령) → 그 항목이 여는 기능. 없으면 스위치 밖(늘 보임). */
export function featureOf(entryId: string): Feature | undefined {
  return FEATURES.find((f) => f.key === entryId || f.menu === entryId)
}
