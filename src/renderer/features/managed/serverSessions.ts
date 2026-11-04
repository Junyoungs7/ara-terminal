// R1 다른 PC 에서 이어 보기 — 관리형 서버의 살아 있는 세션 목록(F1 "서버 세션"·AI 공간 › 서버가 함께 쓴다). 진입 청크에 실려도 되는 작은 상태.
import { create } from 'zustand'
import type { ServerSessionsHost } from '@shared/managedServers'

type ServerSessionsState = {
  hosts: ServerSessionsHost[]
  loading: boolean
  /** 다시 읽기(겹치면 하나만). 동의한 서버가 없으면 main 이 바로 빈 목록을 준다. */
  refresh: () => Promise<void>
}

export const useServerSessions = create<ServerSessionsState>()((set, get) => ({
  hosts: [],
  loading: false,
  refresh: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      set({ hosts: await window.ev.managed.sessions() })
    } catch {
      /* 못 읽으면 지난 목록 그대로 */
    } finally {
      set({ loading: false })
    }
  }
}))
