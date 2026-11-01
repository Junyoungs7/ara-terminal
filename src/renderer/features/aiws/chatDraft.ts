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
