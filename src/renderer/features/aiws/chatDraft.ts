// M5 AI-17 초안 보존 — 탭별로 보내지 않은 글·첨부 경로를 localStorage 에 둔다(재시작 뒤에도: 탭 id = 데몬 세션 id).
// 설정이 아니라 잠깐의 기억이라 localStorage(aiws store 의 핀과 같은 이유). 탭을 닫으면 지운다.
import { draftOf, type ChatDraft } from '@shared/agentChat'

const KEY = 'aiws.chatDraft.'

export function readDraft(sessionId: string): ChatDraft {
  try {
    const raw = localStorage.getItem(KEY + sessionId)
    return draftOf(raw === null ? null : JSON.parse(raw))
  } catch {
    return draftOf(null)
  }
}

export function writeDraft(sessionId: string, d: ChatDraft): void {
  try {
    if (!d.text && !d.files.length) localStorage.removeItem(KEY + sessionId)
    else localStorage.setItem(KEY + sessionId, JSON.stringify(d))
  } catch {
    // 저장 못 해도 이번 창에서는 그대로 쓴다
  }
}

export const clearDraft = (sessionId: string): void => writeDraft(sessionId, { text: '', files: [] })

// M5 AI-14 — 탭별 채팅/터미널 선택도 재시작 뒤까지(탭 id = 데몬 세션 id). 닫은 탭의 것은 closeTab 이 지운다.
const VIEW_KEY = 'aiws.chatOn'

export function readChatOn(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}')
    return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter((x): x is [string, boolean] => x[1] === true)) : {}
  } catch {
    return {}
  }
}

export function writeChatOn(on: Record<string, boolean>): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(Object.fromEntries(Object.entries(on).filter((x) => x[1]))))
  } catch {
    // 저장 못 해도 이번 실행에서는 그대로
  }
}
