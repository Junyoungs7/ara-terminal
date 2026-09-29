import { describe, it, expect } from 'vitest'
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import type { SessionSink, SessionSpec } from '../src/main/sessions/ISessionManager'
import { isSafeExternal } from '../src/main/util/safeExternal'
import { applyUiPrefs, prefsFrom, termPrefs } from '../src/renderer/terminal/termPrefs'
import {
  DEFAULT_COPY_ON_SELECT,
  DEFAULT_SCROLLBACK,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  UI_SCALE_FACTOR,
  UI_SCALES,
  uiScaleOf,
  type UiState
} from '../src/shared/types'

const isWin = process.platform === 'win32'
const spec = (title: string, manualTitle?: boolean): SessionSpec => ({
  type: 'local',
  serverKey: 'localhost',
  title,
  profileId: null,
  cwd: undefined,
  manualTitle,
  shell: isWin ? 'cmd.exe' : '/bin/sh'
})

const silentSink: SessionSink = { data() {}, exit() {}, cwd() {} }

// ── R3.6 OSC 0/2 탭 제목 ──
// 셸이 보낸 제목은 받아들이되, 사용자가 직접 바꾼 이름은 절대 덮어쓰지 않는다.
describe('R3.6 자동 탭 제목 (OSC 0/2)', () => {
  it('사용자가 rename 하지 않은 세션은 셸 제목을 받아들인다', async () => {
    const mgr = new MainSessionManager(silentSink)
    const id = await mgr.create(spec('셸 1'))
    expect(mgr.autoTitle(id, 'deploy@web-01: ~/서비스')).toBe('deploy@web-01: ~/서비스')
    expect(mgr.snapshot().find((s) => s.id === id)?.title).toBe('deploy@web-01: ~/서비스')
    mgr.destroyAll()
  })

  it('rename 한 세션에는 적용하지 않는다(사용자 이름 우선)', async () => {
    const mgr = new MainSessionManager(silentSink)
    const id = await mgr.create(spec('셸 1'))
    mgr.rename(id, '결제 배포')
    expect(mgr.autoTitle(id, 'bash')).toBeNull()
    expect(mgr.snapshot().find((s) => s.id === id)?.title).toBe('결제 배포')
    mgr.destroyAll()
  })

  it('복원된 세션도 manualTitle 을 이어받는다(재시작 후에도 이름이 지켜진다)', async () => {
    const mgr = new MainSessionManager(silentSink)
    const id = await mgr.create(spec('결제 배포', true))
    expect(mgr.autoTitle(id, 'bash')).toBeNull()
    expect(mgr.snapshot().find((s) => s.id === id)?.manualTitle).toBe(true)
    mgr.destroyAll()
  })

  // conpty 가 세션 시작 즉시 보내는 셸 경로 제목. 그대로 받으면 로컬 탭이 전부 같은 이름이 된다.
  it('셸 실행 파일 경로 제목은 무시한다(conpty 시작 제목)', async () => {
    const mgr = new MainSessionManager(silentSink)
    const id = await mgr.create(spec('셸 1'))
    expect(mgr.autoTitle(id, 'C:\\WINDOWS\\SYSTEM32\\cmd.exe')).toBeNull()
    expect(mgr.autoTitle(id, 'powershell.exe')).toBeNull()
    expect(mgr.snapshot().find((s) => s.id === id)?.title).toBe('셸 1')
    // 셸이 의도적으로 세운 제목은 그대로 통과한다.
    expect(mgr.autoTitle(id, 'deploy@web-01: ~/서비스')).toBe('deploy@web-01: ~/서비스')
    mgr.destroyAll()
  })

  it('빈 제목·없는 세션은 무시한다', async () => {
    const mgr = new MainSessionManager(silentSink)
    const id = await mgr.create(spec('셸 1'))
    expect(mgr.autoTitle(id, '')).toBeNull()
    expect(mgr.autoTitle('없는-세션', 'x')).toBeNull()
    mgr.destroyAll()
  })
})

// ── R3.3 URL 열기 스킴 화이트리스트 ──
// 셸 출력은 원격 서버가 찍는 신뢰할 수 없는 입력이다. http/https 외에는 openExternal 에 넘기지 않는다.
describe('R3.3 openExternal 스킴 검증', () => {
  it('http/https 만 통과한다', () => {
    expect(isSafeExternal('https://verygoodtour.com/배포')).toBe(true)
    expect(isSafeExternal('http://10.20.30.40:8080/health')).toBe(true)
  })

  it('임의 프로그램 실행으로 이어질 수 있는 스킴은 막는다', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-msdt:/id',
      'smb://attacker/share',
      'data:text/html,<script>',
      'not a url'
    ]) {
      expect(isSafeExternal(url)).toBe(false)
    }
  })
})

// ── R3.1/R3.4 터미널 동작 설정 + R5 커서·벨 ──
// prefsFrom 이 옵셔널 스냅샷 필드에 기본값을 채우고, applyUiPrefs 가 그 확정값을 캐시에 싣는다.
const uiOf = (patch: Partial<UiState> = {}) => prefsFrom({ ...patch } as UiState)

describe('터미널 설정 기본값', () => {
  it('스냅샷에 값이 없으면 스크롤백 10000 · 선택 자동복사 on · 블록 커서 깜빡임 · 벨 끄기', () => {
    applyUiPrefs(uiOf())
    expect(termPrefs.scrollback).toBe(DEFAULT_SCROLLBACK)
    expect(termPrefs.scrollback).toBe(10000)
    expect(termPrefs.copyOnSelect).toBe(DEFAULT_COPY_ON_SELECT)
    expect(termPrefs.copyOnSelect).toBe(true)
    expect(termPrefs.cursorStyle).toBe('block')
    expect(termPrefs.cursorBlink).toBe(true)
    expect(termPrefs.bell).toBe('off')
  })

  it('저장된 값이 있으면 그 값을 쓴다(끄기 포함)', () => {
    applyUiPrefs(uiOf({ scrollback: 2000, copyOnSelect: false, cursorStyle: 'bar', cursorBlink: false, bell: 'visual' }))
    expect(termPrefs.scrollback).toBe(2000)
    expect(termPrefs.copyOnSelect).toBe(false)
    expect(termPrefs.cursorStyle).toBe('bar')
    expect(termPrefs.cursorBlink).toBe(false)
    expect(termPrefs.bell).toBe('visual')
    applyUiPrefs(uiOf()) // 다른 테스트에 새는 것 방지 — 기본값으로 되돌린다.
  })

  /**
   * #194 ④ 자동완성 스위치. 검사가 두 줄인 이유는 **필드가 없는 파일**과 **false 로 저장한 파일**이
   * 다르기 때문이다: 선택 필드라 옛 스냅샷에는 아예 없고(= 지금까지 쓰던 사람), 그 사람의 터미널이
   * 업데이트 한 번에 조용해지면 그것도 하자다. `?? true` 가 아니라 `!== false` 인 이유가 이것이다.
   */
  it('자동완성은 미지정이면 켬, 명시적 false 만 끈다', () => {
    applyUiPrefs(uiOf())
    expect(termPrefs.termCompletion).toBe(true)
    applyUiPrefs(uiOf({ termCompletion: false }))
    expect(termPrefs.termCompletion).toBe(false)
    applyUiPrefs(uiOf()) // 다른 테스트로 새지 않게 되돌린다.
  })

  it('스크롤백 슬라이더 범위는 1k–100k', () => {
    expect(SCROLLBACK_MIN).toBe(1000)
    expect(SCROLLBACK_MAX).toBe(100000)
  })

  // UI-font5: UI 배율. 저장값은 숫자가 아니라 이름이라, 나중에 배율 수치를 다시 손봐도
  // 사용자가 고른 값이 그대로 산다(숫자로 저장했으면 그때 스냅샷 마이그레이션이 필요하다).
  describe('UI 배율(UI-font5)', () => {
    it('미지정·손상·목록 밖 값은 전부 normal 로 클램프된다', () => {
      expect(prefsFrom({} as UiState).uiScale).toBe('normal')
      expect(uiScaleOf(undefined)).toBe('normal')
      expect(uiScaleOf('huge')).toBe('normal') // 목록에 없는 이름
      expect(uiScaleOf(1.3)).toBe('normal') // 옛 숫자 저장값이 들어와도 안전하게 떨어진다
      expect(uiScaleOf(null)).toBe('normal')
    })

    it('목록 안의 이름은 그대로 살아남는다', () => {
      for (const s of UI_SCALES) expect(uiOf({ uiScale: s }).uiScale).toBe(s)
    })

    it('배율 계수는 normal 이 1 이고 단계마다 커진다', () => {
      expect(UI_SCALE_FACTOR.normal).toBe(1)
      const order = UI_SCALES.map((s) => UI_SCALE_FACTOR[s])
      expect(order).toEqual([...order].sort((a, b) => a - b)) // small < normal < large < xlarge
      expect(UI_SCALE_FACTOR.small).toBeLessThan(1)
      // 하한 규칙: 가장 작은 배율에서도 가장 작은 단계(11px)가 10px 아래로 떨어지면 안 된다.
      // 옛 9·9.5·10px 이 "가독성이 떨어진다"의 실체였고, 배율로 그 자리로 되돌아가면 안 된다.
      expect(11 * UI_SCALE_FACTOR.small).toBeGreaterThanOrEqual(10)
    })
  })
})
