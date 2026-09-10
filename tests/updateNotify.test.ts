// #98 업데이트를 **알린다** — 판정과 문구만 본다(상태 기계는 tests/autoUpdate.test.ts 의 몫).
//
// 여기서 지키는 것 둘:
//  ① 창을 언제 띄우나 — 스누즈한 버전은 다시 안 묻고, 더 새 버전은 다시 묻는다.
//  ② 상태 표시줄 버전 칸이 상태마다 무엇이 되나 — 특히 `error`·`checking` 이 **조용해야** 한다
//     (사내망 밖 노트북이면 하루 네 번 확인마다 상태바가 빨개진다).
import { describe, it, expect } from 'vitest'
import { promptVersion, readyVersion, updateSeg } from '../src/renderer/store/updateNotify'
import type { UpdateState } from '../src/shared/ipc'

describe('창을 띄우나 (promptVersion)', () => {
  it('새 버전을 찾았고 아직 안 물어봤으면 띄운다', () => {
    expect(promptVersion({ status: 'available', version: '1.0.0' }, null)).toBe('1.0.0')
  })

  it('★ [나중에] 를 누른 버전은 다시 안 묻는다 — 이게 이 라운드의 약속이다', () => {
    expect(promptVersion({ status: 'available', version: '1.0.0' }, '1.0.0')).toBeNull()
  })

  it('★ 미룬 뒤에 더 새 버전이 올라오면 다시 묻는다 — 스누즈는 버전별이다', () => {
    expect(promptVersion({ status: 'available', version: '1.1.0' }, '1.0.0')).toBe('1.1.0')
  })

  it('available 이 아니면 안 띄운다 (ready·error·downloading·checking·idle·off)', () => {
    const others: UpdateState[] = [
      { status: 'ready', version: '1.0.0' },
      { status: 'error', message: 'getaddrinfo ENOTFOUND ara.local' },
      { status: 'downloading', version: '1.0.0', percent: 42 },
      { status: 'checking' },
      { status: 'idle' },
      { status: 'off' }
    ]
    for (const st of others) expect(promptVersion(st, null)).toBeNull()
    expect(promptVersion(null, null)).toBeNull()
  })

  it('버전 없는 available 은 안 띄운다 — 스누즈할 열쇠가 없어 매번 다시 뜬다', () => {
    expect(promptVersion({ status: 'available' }, null)).toBeNull()
  })
})

describe('다 받은 뒤 재시작을 묻나 (readyVersion)', () => {
  it('다 받았으면 그 버전으로 묻는다', () => {
    expect(readyVersion({ status: 'ready', version: '1.0.6' })).toBe('1.0.6')
  })

  it('★ ready 가 아니면 안 묻는다 — 받는 중에 재시작을 권하면 받던 것이 버려진다', () => {
    const others: UpdateState[] = [
      { status: 'idle' },
      { status: 'checking' },
      { status: 'available', version: '1.0.6' },
      { status: 'downloading', version: '1.0.6', percent: 99 },
      { status: 'error', message: 'x' },
      { status: 'off' }
    ]
    for (const st of others) expect(readyVersion(st)).toBeNull()
  })

  it('버전 없는 ready 는 안 묻는다 — 무엇을 설치하는지 못 적는다', () => {
    expect(readyVersion({ status: 'ready' } as UpdateState)).toBeNull()
  })

  it('★ 스누즈를 안 본다 — [받기]를 미뤘다가 나중에 받은 사람에게도 물어야 한다', () => {
    // promptVersion 은 스누즈를 보고 조용해지지만, 이쪽은 **이미 받아 둔 상태**라 규칙이 다르다.
    expect(promptVersion({ status: 'available', version: '1.0.6' }, '1.0.6')).toBeNull()
    expect(readyVersion({ status: 'ready', version: '1.0.6' })).toBe('1.0.6')
  })

  it('★ 같은 판을 두 번 묻는다 — 받을까요, 그다음 껐다 켤까요', () => {
    // 훅이 `상태:버전` 으로 기억하는 이유. 버전만으로 잡으면 둘째 물음이 사라진다.
    expect(promptVersion({ status: 'available', version: '1.0.6' }, null)).toBe('1.0.6')
    expect(readyVersion({ status: 'ready', version: '1.0.6' })).toBe('1.0.6')
  })
})

describe('상태 표시줄 버전 칸 (updateSeg)', () => {
  const plain = { text: 'v0.9.9', title: '', action: null, tone: null }

  it('★ 조용한 상태 넷은 예전 그대로 — 버전만 보이고 눌리지 않는다', () => {
    // error 가 여기 있는 것이 요점이다: 사내망 밖에서 상태바가 빨개지면 안 된다.
    expect(updateSeg(null, '0.9.9')).toEqual(plain)
    expect(updateSeg({ status: 'off' }, '0.9.9')).toEqual(plain)
    expect(updateSeg({ status: 'idle' }, '0.9.9')).toEqual(plain)
    expect(updateSeg({ status: 'checking' }, '0.9.9')).toEqual(plain)
    expect(updateSeg({ status: 'error', message: 'ENOTFOUND' }, '0.9.9')).toEqual(plain)
  })

  it('available — 새 버전을 짧게 말하고 누르면 받는다', () => {
    const s = updateSeg({ status: 'available', version: '1.0.0' }, '0.9.9')
    expect(s).toMatchObject({ text: '↑ 1.0.0 있음', action: 'download', tone: 'available' })
    expect(s.title).toContain('1.0.0')
  })

  it('downloading — 진행률만. 누를 것이 없다', () => {
    const s = updateSeg({ status: 'downloading', version: '1.0.0', percent: 42 }, '0.9.9')
    expect(s).toMatchObject({ text: '↓ 42%', action: null, tone: 'downloading' })
  })

  it('ready — 준비됐다고 말하고 누르면 설치한다(확인은 누른 뒤에 받는다)', () => {
    const s = updateSeg({ status: 'ready', version: '1.0.0' }, '0.9.9')
    expect(s).toMatchObject({ text: '✓ 1.0.0 준비됨', action: 'install', tone: 'ready' })
  })

  /**
   * ★ 색만으로 상태를 말하지 않는다(§6). 톤이 붙은 칸은 **글자로도** 다른 말을 해야 한다 —
   * CSS 를 못 읽는 사람(색각·고대비·흑백 캡처)에게 색은 없는 것과 같다.
   */
  it('★ 톤이 붙은 셋은 글자가 서로 다르다 — 색이 유일한 신호가 아니다', () => {
    const texts = (
      [
        { status: 'available', version: '1.0.0' },
        { status: 'downloading', version: '1.0.0', percent: 42 },
        { status: 'ready', version: '1.0.0' }
      ] as UpdateState[]
    ).map((st) => updateSeg(st, '0.9.9').text)
    expect(new Set(texts).size).toBe(3)
    for (const x of texts) expect(x).not.toBe(plain.text)
  })

  it('버전 없는 available·ready 는 조용히 넘어간다(설정 서랍이 말한다)', () => {
    expect(updateSeg({ status: 'available' }, '0.9.9')).toEqual(plain)
    expect(updateSeg({ status: 'ready' }, '0.9.9')).toEqual(plain)
  })

  it('진행률이 없어도 0% 로 그린다 — 누른 사람이 반응을 봐야 한다', () => {
    expect(updateSeg({ status: 'downloading' }, '0.9.9').text).toBe('↓ 0%')
  })
})
