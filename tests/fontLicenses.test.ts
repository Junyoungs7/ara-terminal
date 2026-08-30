import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { LICENSES } from '../src/renderer/fonts/licenses'

/**
 * FINISH-M6(2026-08-30) — 설정 [정보]의 **번들 폰트 라이선스 고지**가 실제 배포물과 맞는가.
 *
 * 처음 벌어진 자리: FINISH-M4 가 심볼 폰트(Symbols Nerd Font Mono)를 번들에 실었는데
 * `LICENSES` 는 넷에 멈춰 있었다. 화면에는 여전히 "모두 SIL Open Font License 1.1 이고 원문은
 * resources/fonts/OFL-*.txt 에 있습니다"라고 적혀 있었으니, **다섯 번째 폰트는 고지 없이 나갈
 * 뻔했다.** 이 표는 장식이 아니라 재배포 조건이라 눈으로 지킬 것이 아니다.
 *
 * 기준을 `OFL-*.txt` 로 잡은 이유: 그 파일이 있다는 것은 우리가 그 폰트를 **재배포한다**는 뜻이다
 * (없으면 애초에 실을 수 없다). 폰트를 더할 때 라이선스 원문만 넣고 표를 잊는 것이 정확히 이번에
 * 일어난 일이라, 그 둘을 묶어 둔다.
 */
const FONT_DIR = 'resources/fonts'

/** `OFL-JetBrainsMono.txt` → `JetBrainsMono`. 표의 이름과 붙여 비교할 열쇠다. */
const oflNames = (): string[] =>
  readdirSync(FONT_DIR)
    .filter((f) => f.startsWith('OFL-') && f.endsWith('.txt'))
    .map((f) => f.slice(4, -4))

/** 공백·괄호를 지운 소문자 — 표는 사람이 읽는 이름("나눔고딕코딩 (Nanum Gothic Coding)")이다. */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

describe('번들 폰트 라이선스 고지 — 설정 [정보]', () => {
  it('★ 재배포하는 OFL 폰트가 전부 고지 표에 있다', () => {
    const listed = LICENSES.map((l) => squash(l.name))
    for (const font of oflNames()) {
      expect(listed.some((n) => n.includes(squash(font))), `${font} 가 LICENSES 에 없다`).toBe(true)
    }
  })

  it('표에만 있고 실제로는 안 싣는 폰트가 없다 — 있지도 않은 것을 고지하지 않는다', () => {
    const shipped = oflNames().map(squash)
    for (const l of LICENSES) {
      expect(shipped.some((f) => squash(l.name).includes(f)), `${l.name} 의 OFL 원문이 없다`).toBe(true)
    }
  })

  it('저작권 문구가 원문 라이선스 안에 실제로 있다 — 표에 지어내지 않는다', () => {
    for (const font of oflNames()) {
      const text = readFileSync(`${FONT_DIR}/OFL-${font}.txt`, 'utf8')
      const row = LICENSES.find((l) => squash(l.name).includes(squash(font)))
      expect(row, font).toBeTruthy()
      // 표는 "Copyright (c) 2010, NHN Corporation" 처럼 원문의 앞부분만 잘라 담는다.
      expect(text.includes(row!.copyright), `${font}: "${row!.copyright}"`).toBe(true)
    }
  })

  it('★ 스캔이 공허하지 않다 — OFL 원문을 하나도 못 찾으면 위 검사가 전부 무의미하다', () => {
    expect(oflNames().length).toBeGreaterThanOrEqual(4)
  })
})
