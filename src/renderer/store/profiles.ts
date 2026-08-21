import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionProfile, ProfileInput } from '@shared/types'
import type { SshConnectResult } from '@shared/ipc'
import { t } from '../i18n'

export type ConnectFailure = Extract<SshConnectResult, { ok: false }>

// 연결 실패 → 사용자가 읽고 조치할 수 있는 한국어 사유. ssh2 원문(영문)은 detail 로만 덧붙인다.
// 실패 종류를 구분하지 않는 "연결 실패"만 보여 원인을 알 수 없다는 피드백(2026-08-03) 대응.
export function connectErrorTitle(res: ConnectFailure): string {
  return t('conn.fail.' + res.reason + '.title')
}

export function connectErrorMessage(res: ConnectFailure): string {
  return t('conn.fail.' + res.reason + '.msg')
}

// 프로필 목록 + 연결 상태(F3). CRUD는 main(vault 경유), 연결은 ssh:connect.
export type ConnState = Record<string, 'idle' | 'connecting' | 'connected' | 'error'>

/**
 * 상태 점 클래스(연결됨=on, 연결 중/오류=warn, 미연결=off).
 * **연결 트리와 연결 관리자가 같은 함수를 쓴다** — 2026-08-13 감사에서 관리자 쪽이 `var(--idle)`
 * 하드코딩이라 같은 서버가 화면마다 다른 색으로 보이던 것을 여기로 모았다.
 */
export function connDotClass(state: ConnState[string] | undefined): string {
  if (state === 'connected') return 'on'
  // 2026-08-16: 예전에는 connecting 과 error 를 'warn' 하나로 접었다. 그러면 **붙는 중인지 아까
  // 실패한 채인지** 구분이 안 된다 — 실패 창을 닫아도 점은 그대로 노랗고, 다시 눌러야 하는지
  // 기다려야 하는지 화면이 말해 주지 않았다. 접속은 이 앱의 첫 동작이라 그 몇 초가 중요하다.
  if (state === 'connecting') return 'connecting'
  if (state === 'error') return 'error'
  return 'off'
}

export function useProfiles() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([])
  const [conn, setConn] = useState<ConnState>({})
  // 렌더 사이클과 무관한 최신 목록. 저장 직후 같은 tick 에 연결을 시도하면 profiles 상태는 아직
  // 이전 배열이라 방금 만든 프로필을 못 찾는다 — 실패 다이얼로그에서 서버 정보가 비는 원인.
  const listRef = useRef<ConnectionProfile[]>([])

  const reload = useCallback(async () => {
    const list = await window.ev.profile.list()
    listRef.current = list
    setProfiles(list)
  }, [])

  // id → 프로필. 로컬 캐시에 없으면 main 에 다시 물어본다(실패 경로에서만 발생하는 저빈도 조회).
  const lookup = useCallback(async (id: string): Promise<ConnectionProfile | undefined> => {
    const local = listRef.current.find((p) => p.id === id)
    if (local) return local
    const list = await window.ev.profile.list()
    listRef.current = list
    return list.find((p) => p.id === id)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = useCallback(
    async (input: ProfileInput): Promise<ConnectionProfile> => {
      const { profile } = await window.ev.profile.save(input)
      await reload()
      return profile
    },
    [reload]
  )

  const remove = useCallback(
    async (id: string) => {
      await window.ev.profile.delete(id)
      await reload()
    },
    [reload]
  )

  // 연결. 호스트키 최초 접속(hostKeyNew) 시 상위에서 확인 다이얼로그 후 acceptHostKey로 재호출.
  // password: 저장해 두지 않은 비밀번호를 그 자리에서 받아 넘길 때만 실린다(저장되지 않는다).
  const connect = useCallback(
    async (profileId: string, acceptHostKey?: boolean, password?: string): Promise<SshConnectResult> => {
      setConn((c) => ({ ...c, [profileId]: 'connecting' }))
      const res = await window.ev.ssh.connect(profileId, acceptHostKey, password)
      setConn((c) => ({ ...c, [profileId]: res.ok ? 'connected' : 'error' }))
      return res
    },
    []
  )

  return { profiles, conn, reload, lookup, save, remove, connect }
}
