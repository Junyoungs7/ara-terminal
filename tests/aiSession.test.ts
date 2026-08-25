// #128 AI 세션(작업대) 모델 — **껐다 켰을 때 무엇을 되살리고 무엇을 '끊김'으로 두는가.**
// 그 판단이 이 기능의 성격을 정한다(설계 §10.5). 저장값은 신뢰 경계 밖이라 클램프도 여기서 본다.
import { describe, it, expect } from 'vitest'
import {
  aiSessionsOf,
  childrenOf,
  defaultTitle,
  restoreVerdict,
  sortAiSessions,
  type AiSessionState
} from '../src/shared/aiSession'
import { migrate } from '../src/main/workspace/migrations'
import { SCHEMA_VERSION } from '../src/shared/types'

const mk = (over: Partial<AiSessionState> = {}): AiSessionState => ({
  id: 's1',
  kind: 'local',
  cwd: 'D:/work/app',
  engine: 'claude',
  skipPerms: false,
  title: 'app',
  lastUsedAt: 100,
  ...over
})

describe('복원 판정 (설계 §10.5 규칙 3)', () => {
  it('폴더가 있으면 쉬는 중으로 연다 — **프로세스는 안 띄운다**(첫 질문에서 뜬다)', () => {
    expect(restoreVerdict(mk(), { pathExists: true, profileExists: true })).toBe('idle')
  })

  it('★ 폴더가 없어졌으면 끊김 — 조용히 홈으로 떨어지지 않는다', () => {
    // 잘못된 폴더에서 파일을 고치는 것보다 "못 연다"가 낫다. worktree 를 사용자가 지운 경우도 같다.
    expect(restoreVerdict(mk(), { pathExists: false, profileExists: true })).toBe('noPath')
  })

  it('★ 원격은 프로필이 먼저다 — 서버에 못 붙으면 경로를 볼 방법도 없다', () => {
    const remote = mk({ kind: 'remote', profileId: 'p1' })
    expect(restoreVerdict(remote, { pathExists: false, profileExists: false })).toBe('noProfile')
    expect(restoreVerdict(remote, { pathExists: true, profileExists: true })).toBe('idle')
    // 원격인데 프로필 id 자체가 없는 항목(옛 스냅샷·손상)도 같은 처지다.
    expect(restoreVerdict({ kind: 'remote' }, { pathExists: true, profileExists: true })).toBe('noProfile')
  })
})

describe('저장값 클램프', () => {
  it('모양이 안 맞는 항목은 버린다 · 같은 id 는 앞의 것만', () => {
    const list = aiSessionsOf([
      mk(),
      { id: '', cwd: 'x' }, // id 없음
      { id: 's2' }, // cwd 없음
      mk({ id: 's1', title: '중복' }),
      'nope',
      null
    ])
    expect(list.map((s) => s.id)).toEqual(['s1'])
    expect(list[0]!.title).toBe('app')
    expect(aiSessionsOf(undefined)).toEqual([])
  })

  it('★ skipPerms 는 없거나 이상하면 **끈다** — 깨진 값이 권한 확인을 건너뛰게 두지 않는다', () => {
    expect(aiSessionsOf([{ id: 'a', cwd: 'c' }])[0]!.skipPerms).toBe(false)
    expect(aiSessionsOf([{ id: 'a', cwd: 'c', skipPerms: 'yes' }])[0]!.skipPerms).toBe(false)
    expect(aiSessionsOf([{ id: 'a', cwd: 'c', skipPerms: true }])[0]!.skipPerms).toBe(true)
  })

  it('모르는 엔진·빈 제목은 기본값으로 · 로컬에는 profileId 를 안 남긴다', () => {
    const s = aiSessionsOf([{ id: 'a', cwd: 'D:/x/vgt-erp', engine: '몰라', profileId: 'p9' }])[0]!
    expect(s.engine).toBe('claude')
    expect(s.title).toBe('vgt-erp')
    expect(s.profileId).toBeUndefined() // kind 가 local 이면 서버 참조가 남으면 안 된다
  })

  it('제목은 경로의 마지막 칸 — 경로 전체는 길고 사람이 구분하는 건 그 칸이다', () => {
    expect(defaultTitle(String.raw`D:\work\vgt-erp`)).toBe('vgt-erp')
    expect(defaultTitle('/home/jun/app/')).toBe('app')
  })
})

describe('목록 다루기', () => {
  it('최근 쓴 것이 위 · 같은 시각이면 제목순(재시작마다 순서가 흔들리지 않게)', () => {
    const list = [mk({ id: 'a', title: '나', lastUsedAt: 5 }), mk({ id: 'b', title: '가', lastUsedAt: 5 }), mk({ id: 'c', lastUsedAt: 9 })]
    expect(sortAiSessions(list).map((s) => s.id)).toEqual(['c', 'b', 'a'])
    expect(list[0]!.id).toBe('a') // 원본을 건드리지 않는다
  })

  it('분리 세션의 부모를 찾는다 — 지울 때 먼저 알리려고(설계 §10.3 규칙 4)', () => {
    const list = [mk({ id: 'p' }), mk({ id: 'c1', worktree: { parentId: 'p', branch: 'ara/x' } }), mk({ id: 'o' })]
    expect(childrenOf(list, 'p').map((s) => s.id)).toEqual(['c1'])
    expect(childrenOf(list, 'o')).toEqual([])
  })
})

describe('스키마 6 마이그레이션', () => {
  it('★ 옛 스냅샷은 **빈 배열**로 온다 — 없던 작업대를 지어내지 않는다', () => {
    const old = { schemaVersion: 5, profiles: [], ui: {}, sessions: [{ id: 'x' }] }
    const out = migrate(old)!
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    expect(out.aiSessions).toEqual([])
    expect(out.sessions).toHaveLength(1) // 나머지는 그대로 온다
  })
})
