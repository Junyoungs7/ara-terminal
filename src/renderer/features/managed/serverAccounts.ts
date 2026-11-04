// 원격 3차 R3 서버 계정 — 서버마다 계정 목록 하나(설정 화면·원격 탭의 "다른 계정으로 이어서"가 같이 본다). 처음 볼 때 서버에 묻는다.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { ServerAccounts } from '@shared/managedServers'
import type { ManagedAccountsRequest, ManagedAccountsResult } from '@shared/ipc'

type Entry = ServerAccounts | { error: string }
export const useServerAccountsStore = create<{ byHost: Record<string, Entry> }>(() => ({ byHost: {} }))

/** 서버에 묻고(op 가 있으면 그 일을 하고) 목록을 고친다. 실패면 목록은 그대로 두고 사유를 돌려준다. */
export async function serverAccounts(req: ManagedAccountsRequest): Promise<ManagedAccountsResult> {
  const r = await window.ev.managed.accounts(req).catch((e: unknown): ManagedAccountsResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  useServerAccountsStore.setState((s) => {
    const prev = s.byHost[req.hostKey]
    const next: Entry = r.ok ? { accounts: r.accounts, default: r.default } : prev && 'accounts' in prev ? prev : { error: r.error }
    return { byHost: { ...s.byHost, [req.hostKey]: next } }
  })
  return r
}

/** 그 서버의 계정 목록(없으면 묻기 시작하고 null). hostKey 가 없으면(로컬 탭) 늘 null. */
export function useServerAccounts(hostKey: string | undefined): ServerAccounts | null {
  const e = useServerAccountsStore((s) => (hostKey ? s.byHost[hostKey] : undefined))
  useEffect(() => {
    if (hostKey && !e) void serverAccounts({ hostKey })
  }, [hostKey, e])
  return e && 'accounts' in e ? e : null
}
