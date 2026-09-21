import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionProfile, ProfileInput } from '@shared/types'
import type { SshConnectResult } from '@shared/ipc'
import type { AiCommand } from '@shared/aiCli'
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

// 여기 있던 `serverRowActive` 는 2026-09-08 에 없앴다. 트리 서버 행에 **색으로 말할 상태가 하나도
// 없어졌기** 때문이다 — 준영님: *"연결된 세션을 선택하면 그 해당 세션의 서버는 색상이 보이지
// 않게. 단순히 진입점으로만."* 그리고 이어서 *"사람이 직접 서버를 클릭할때도 굳이 남길 필요는
// 없을것 같아. (…) 상태dot은 남겨줘."*
//
// 그래서 지금 서버 행이 말하는 것은 둘뿐이다: **연결 여부는 상태 점**(위 connDotClass),
// **키보드로 지금 어디인지는 전역 `:focus-visible`**(shell.css:21 — rowKeys 가 DOM 초점을 옮긴다).
// ⚠️ 색을 되살리려거든 그 둘로 안 되는 이유를 먼저 적어라. 접속 상태를 다시 묶으면 한 서버에
// 색이 둘이 된다(자식 세션 행 + 서버 행) — 2026-08-22 제보 2·3번이 그것이었다.

/**
 * 프로필 → 저장 입력. **조립은 여기 한 곳에서만 한다.**
 *
 * 저장은 통째 덮어쓰기다(ProfileStore.save) — 부르는 쪽이 필드를 하나 빠뜨리면 그 값이 조용히
 * 사라진다. 그룹만 바꾸는 호출이 rdp 의 `multiMonitor` 를 안 실어서 [다중 모니터 사용]이 꺼지던
 * 사고가 그것이라, 옮기기·복제·드래그가 전부 이 함수를 지나게 했다.
 * 비밀은 싣지 않는다 — `secret` 미지정 저장은 vault 의 기존 비밀을 그대로 둔다(ProfileStore 계약).
 */
export function profileInput(p: ConnectionProfile, patch?: Partial<ProfileInput>): ProfileInput {
  const base = { id: p.id, name: p.name, host: p.host, port: p.port, username: p.username, group: p.group }
  return p.type === 'rdp'
    ? { ...base, type: 'rdp', multiMonitor: p.multiMonitor, ...patch }
    : {
        ...base,
        type: 'ssh',
        authType: p.auth.type,
        keyPath: p.auth.type === 'key' ? p.auth.keyPath : undefined,
        ...patch
      }
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
  // size: 셸을 열 치수(#158). 부르는 쪽이 알면 준다 — 안 주면 main 이 80×24 로 연다.
  // aiCommand: D(#168) 주면 그 세션은 셸이 아니라 AI CLI 가 프로세스인 채로 열린다.
  // winId: 부른 창. 떼어낸 창이 자기 id 를 준다 — 안 주면 본창이고, 본창은 지금까지처럼 안 준다.
  const connect = useCallback(
    async (
      profileId: string,
      acceptHostKey?: boolean,
      password?: string,
      size?: { cols: number; rows: number },
      aiCommand?: { argv: AiCommand; cwd: string },
      winId?: string
    ): Promise<SshConnectResult> => {
      setConn((c) => ({ ...c, [profileId]: 'connecting' }))
      const res = await window.ev.ssh.connect(profileId, acceptHostKey, password, size, aiCommand, winId)
      setConn((c) => ({ ...c, [profileId]: res.ok ? 'connected' : 'error' }))
      return res
    },
    []
  )

  return { profiles, conn, reload, lookup, save, remove, connect }
}
