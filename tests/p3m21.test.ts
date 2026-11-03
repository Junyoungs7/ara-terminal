// p3-M21 셋업 가이드 · 에이전트 잠재우기 · 펫 — 판정 순수 함수. Orca 시험(feature-wall-setup-progress.test.ts ·
// agent-hibernation-confirmation.test.ts · agent-hibernation-planner.test.ts · pet-agent-state 판정)에서 아라에 남은 경우를 옮겼다.
import { describe, expect, it } from 'vitest'
import { firstIncompleteStep, sectionOfStep, setupGuideProgress, SETUP_STEP_IDS, showSidebarEntry, type SetupGuideInput } from '../src/renderer/features/aiws/setupGuide/steps'
import { confirmHibernation, planHibernation, type HibernationSnapshot } from '../src/renderer/features/aiws/hibernation'
import { agentSettingsOf, defaultAgentSettings, hibernateMinutesOf } from '../src/shared/agents'
import { clampPetPos, DEFAULT_PET, isPetImageName, petMood, petOf } from '../src/shared/pet'
import type { AgentStatusView } from '../src/shared/agentHooks'

const none: SetupGuideInput = {
  defaultAgentInstalled: false,
  agentNotes: false,
  skillInstalled: false,
  trackerConnected: false,
  hasSetupScript: false,
  repoCount: 0,
  extraWorktreeCount: 0,
  orielInstalled: false
}

describe('셋업 가이드(Orca feature-wall-setup-progress)', () => {
  it('여덟 단계, 준비 6 · 병렬 2', () => {
    expect(SETUP_STEP_IDS.length).toBe(8)
    expect(SETUP_STEP_IDS.filter((id) => sectionOfStep(id) === 'parallel')).toEqual(['two-worktrees', 'browser'])
  })
  it('저장소 두 개부터 add-two-repos', () => {
    expect(setupGuideProgress({ ...none, repoCount: 1 }).stepDone['add-two-repos']).toBe(false)
    expect(setupGuideProgress({ ...none, repoCount: 2 }).stepDone['add-two-repos']).toBe(true)
  })
  it('본 폴더 밖 작업 단위 하나면 two-worktrees', () => {
    expect(setupGuideProgress({ ...none, extraWorktreeCount: 1 }).stepDone['two-worktrees']).toBe(true)
  })
  it('완료 수를 센다', () => {
    const p = setupGuideProgress({ ...none, agentNotes: true, orielInstalled: true })
    expect([p.doneCount, p.total]).toEqual([2, 8])
  })
  it('처음 열면 준비 쪽 안 끝난 첫 단계, 준비가 다 끝나야 병렬 단계', () => {
    expect(firstIncompleteStep({})).toBe('default-agent')
    expect(firstIncompleteStep({ 'default-agent': true, notifications: true })).toBe('agent-capabilities')
    const setupDone = Object.fromEntries(SETUP_STEP_IDS.filter((id) => sectionOfStep(id) === 'setup').map((id) => [id, true]))
    expect(firstIncompleteStep(setupDone)).toBe('two-worktrees')
    expect(firstIncompleteStep(Object.fromEntries(SETUP_STEP_IDS.map((id) => [id, true])))).toBe('default-agent')
  })
  it('사이드바 줄: 판정 끝 · 안 끝남 · 안 숨김일 때만(Orca shouldShowSetupGuideEntry)', () => {
    expect(showSidebarEntry(setupGuideProgress(none, false), false)).toBe(false)
    expect(showSidebarEntry(setupGuideProgress(none), false)).toBe(true)
    expect(showSidebarEntry(setupGuideProgress(none), true)).toBe(false)
    const all = { defaultAgentInstalled: true, agentNotes: true, skillInstalled: true, trackerConnected: true, hasSetupScript: true, repoCount: 2, extraWorktreeCount: 1, orielInstalled: true }
    expect(showSidebarEntry(setupGuideProgress(all), false)).toBe(false)
  })
})

const MIN = 60_000
const idle = (sessionId: string, extra: Partial<AgentStatusView> = {}): AgentStatusView => ({ sessionId, state: 'idle', estimated: false, children: [], source: 'hook:Stop', ...extra })
const snap = (o: Partial<HibernationSnapshot> = {}): HibernationSnapshot => ({
  enabled: true,
  idleMs: 30 * MIN,
  now: 100 * MIN,
  tabs: [{ sessionId: 'a', exited: false }],
  statusById: { a: idle('a') },
  viewing: null,
  doneAt: { a: 10 * MIN },
  leftAt: {},
  inputAt: {},
  ...o
})

describe('잠재우기 후보(Orca agent-hibernation-planner)', () => {
  it('꺼져 있거나 보고 있으면 없음', () => {
    expect(planHibernation(snap({ enabled: false }))).toEqual([])
    expect(planHibernation(snap({ viewing: 'a' }))).toEqual([])
  })
  it('끝남(idle)만 — 일함·막힘·모름·셸만 남음은 아님', () => {
    expect(planHibernation(snap()).map((c) => c.id)).toEqual(['a'])
    expect(planHibernation(snap({ statusById: { a: idle('a', { state: 'working' }) } }))).toEqual([])
    expect(planHibernation(snap({ statusById: { a: idle('a', { state: 'blocked' }) } }))).toEqual([])
    expect(planHibernation(snap({ statusById: { a: idle('a', { state: null }) } }))).toEqual([])
    expect(planHibernation(snap({ statusById: { a: idle('a', { agentExited: true }) } }))).toEqual([])
  })
  it('하위 에이전트가 남아 있으면 아님', () => {
    expect(planHibernation(snap({ statusById: { a: idle('a', { children: [{ id: 'c', state: 'working', startedAt: 0 }] }) } }))).toEqual([])
  })
  it('기다림이 덜 찼으면 아님, 떠난 시각이 더 늦으면 그때부터 잰다', () => {
    expect(planHibernation(snap({ now: 39 * MIN }))).toEqual([])
    expect(planHibernation(snap({ now: 40 * MIN })).length).toBe(1)
    expect(planHibernation(snap({ now: 40 * MIN, leftAt: { a: 20 * MIN } }))).toEqual([])
  })
  it('끝난 뒤 입력이 있으면 아님(끝나기 전 입력은 괜찮다)', () => {
    expect(planHibernation(snap({ inputAt: { a: 11 * MIN } }))).toEqual([])
    expect(planHibernation(snap({ inputAt: { a: 9 * MIN } })).length).toBe(1)
  })
  it('원격·끝난·이미 잠든 탭은 아님', () => {
    expect(planHibernation(snap({ tabs: [{ sessionId: 'a', exited: false, host: 'srv' }] }))).toEqual([])
    expect(planHibernation(snap({ tabs: [{ sessionId: 'a', exited: true }] }))).toEqual([])
    expect(planHibernation(snap({ tabs: [{ sessionId: 'a', exited: false, slept: { resume: 'x', minutes: 30 } }] }))).toEqual([])
  })
  it('서명에 기준 시각·입력이 든다', () => {
    const [a] = planHibernation(snap())
    const [b] = planHibernation(snap({ inputAt: { a: 5 * MIN } }))
    expect(a.signature).not.toBe(b.signature)
  })
})

describe('잠재우기 확인(Orca agent-hibernation-confirmation)', () => {
  it('두 번 연속 같은 서명이어야 하고, 빠지거나 바뀌면 처음부터', () => {
    const c = { id: 'a', signature: 's1', idleStart: 0 }
    const first = confirmHibernation({}, [c])
    expect(first.confirmed).toEqual([])
    expect(confirmHibernation(first.state, [c]).confirmed).toEqual([c])
    const absent = confirmHibernation(first.state, [])
    expect(absent.state).toEqual({})
    expect(confirmHibernation(absent.state, [c]).confirmed).toEqual([])
    expect(confirmHibernation(first.state, [{ ...c, signature: 's2' }]).confirmed).toEqual([])
  })
})

describe('잠재우기 설정', () => {
  it('기본 꺼짐 · 30분, 범위 밖은 기본값(Orca getEffectiveAgentHibernationIdleMs)', () => {
    expect([defaultAgentSettings().hibernate, defaultAgentSettings().hibernateMinutes]).toEqual([false, 30])
    expect(hibernateMinutesOf(1)).toBe(1)
    expect(hibernateMinutesOf(1440)).toBe(1440)
    expect(hibernateMinutesOf(0)).toBe(30)
    expect(hibernateMinutesOf(1441)).toBe(30)
    expect(hibernateMinutesOf('abc')).toBe(30)
    expect(agentSettingsOf({ hibernate: true, hibernateMinutes: '5' })).toMatchObject({ hibernate: true, hibernateMinutes: 5 })
  })
})

describe('펫(Orca pet-agent-state · pet-image-formats)', () => {
  const st = (state: AgentStatusView['state'], extra: Partial<AgentStatusView> = {}): AgentStatusView => idle('x', { state, ...extra })
  it('막힘 > 일함 > 끝남 > 쉼', () => {
    expect(petMood([])).toBe('idle')
    expect(petMood([st('idle')])).toBe('review')
    expect(petMood([st('idle'), st('working')])).toBe('running')
    expect(petMood([st('working'), st('blocked')])).toBe('waiting')
    expect(petMood([st(null), st('idle', { agentExited: true })])).toBe('idle')
  })
  it('저장값: 기본 꺼짐·그림 없음, 모르는 크기·이름은 버린다', () => {
    expect(petOf(undefined)).toEqual(DEFAULT_PET)
    expect(petOf({ enabled: true, size: 180, image: 'pet.gif' })).toEqual({ enabled: true, size: 180, image: 'pet.gif' })
    expect(petOf({ size: 999, image: '../x.png' })).toEqual(DEFAULT_PET)
  })
  it('그림 이름은 pet.<알려진 확장자> 만', () => {
    expect(isPetImageName('pet.svg')).toBe(true)
    expect(isPetImageName('pet.exe')).toBe(false)
    expect(isPetImageName('..\\pet.png')).toBe(false)
  })
  it('자리는 창 안으로', () => {
    expect(clampPetPos({ right: -5, bottom: 9999 }, 120, { w: 800, h: 600 })).toEqual({ right: 0, bottom: 480 })
  })
})
