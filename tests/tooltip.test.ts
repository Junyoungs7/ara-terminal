// 전역 툴팁 — 문구 쪼개기와 자리 잡기.
//
// 이 둘이 이 기능의 전부다. 나머지(네이티브 억제·지연)는 DOM 배선이라 실기동으로 본다.
// 자리 계산이 틀리면 툴팁이 화면 밖으로 나가 아무것도 안 보이고, 문구 쪼개기가 틀리면
// 문장 속 조합키를 뱃지로 떼어내 말이 부서진다.
import { describe, it, expect } from 'vitest'
import { pickCut, placeTip, splitTip } from '../src/renderer/store/tooltip'

describe('단축키 뱃지 분리', () => {
  it('끝에 괄호로 붙은 단축키는 뱃지로 뗀다', () => {
    expect(splitTip('탐색기 닫기 (Ctrl+Shift+O)')).toEqual({ text: '탐색기 닫기', key: 'Ctrl+Shift+O' })
    expect(splitTip('새 세션 (Ctrl+Shift+T)')).toEqual({ text: '새 세션', key: 'Ctrl+Shift+T' })
  })

  it('★ 문장 속 조합키는 건드리지 않는다 — 떼면 말이 부서진다', () => {
    const s = '원격에서 파일을 복사(Ctrl+C)하면 활성화됩니다 — 저장 위치를 골라 내려받습니다'
    expect(splitTip(s)).toEqual({ text: s, key: null })
  })

  it('단축키가 없는 괄호는 그대로 문장에 남는다', () => {
    expect(splitTip('탐색기 닫기 (실험 기능)')).toEqual({ text: '탐색기 닫기 (실험 기능)', key: null })
    expect(splitTip('GPU (nvidia 서버만)')).toEqual({ text: 'GPU (nvidia 서버만)', key: null })
  })

  it('기능키·맥 기호도 단축키로 본다', () => {
    expect(splitTip('치트시트 (F1)').key).toBe('F1')
    expect(splitTip('설정 (⌘+,)').key).toBe('⌘+,')
  })

  it('괄호가 없으면 통째로 문구', () => {
    expect(splitTip('다중 모니터')).toEqual({ text: '다중 모니터', key: null })
  })

  it('앞뒤 공백은 정리한다', () => {
    expect(splitTip('  다중 모니터  ')).toEqual({ text: '다중 모니터', key: null })
  })

  it('괄호가 중간에 있으면 뱃지가 아니다 — 끝에 있는 것만 본다', () => {
    expect(splitTip('세션 복제 (Ctrl+Shift+D) 후 이름 변경').key).toBeNull()
  })
})

const rect = (left: number, top: number, w: number, h: number) => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
  width: w,
  height: h
})

describe('툴팁 자리 — 좌우로 붙인다', () => {
  // 아래로 붙이면 세로로 늘어선 아이콘 바에서 바로 밑 아이콘을 덮는다(준영님 지적).
  // 좌우는 그 줄에 아무것도 없어 무엇도 가리지 않는다.

  it('기본은 요소 오른쪽, 세로 가운데 맞춤', () => {
    // 30px 요소의 가운데(65) 에 24px 툴팁의 가운데를 맞춘다 → top = 65 - 12 = 53
    expect(placeTip(rect(100, 50, 30, 30), 120, 24, 1000, 800)).toEqual({ x: 136, y: 53, side: 'right' })
  })

  it('★ 오른쪽이 좁으면 왼쪽으로 — 우측 아이콘 바가 이 경우다', () => {
    const p = placeTip(rect(950, 300, 30, 30), 200, 24, 1000, 800)
    expect(p.side).toBe('left')
    expect(p.x).toBe(950 - 6 - 200)
  })

  it('왼쪽 가장자리 요소는 오른쪽에 붙는다', () => {
    expect(placeTip(rect(4, 300, 30, 30), 200, 24, 1000, 800).side).toBe('right')
  })

  it('툴팁이 화면보다 넓어도 좌표가 음수로 새지 않는다', () => {
    expect(placeTip(rect(10, 300, 30, 30), 2000, 24, 400, 800).x).toBe(8)
  })

  it('★ 세로도 화면 안으로 민다 — 맨 위/맨 아래 아이콘에서 잘리면 안 된다', () => {
    expect(placeTip(rect(100, 0, 30, 30), 120, 60, 1000, 800).y).toBe(8)
    expect(placeTip(rect(100, 780, 30, 30), 120, 60, 1000, 800).y).toBe(800 - 60 - 8)
  })

  it('키 큰 요소(트리 행 등)에서도 가운데를 잡는다', () => {
    expect(placeTip(rect(100, 100, 200, 80), 120, 24, 1000, 800).y).toBe(100 + 40 - 12)
  })
})

describe('툴팁 자리 — 좌우가 둘 다 안 될 때만 위/아래', () => {
  // 준영님 제보(2026-09-05): 하단바 표에서 툴팁이 마우스가 아니라 **좌측 하단바 끝**에 떴다.
  // 앵커가 줄 전체라 좌우 여유가 둘 다 tipW 에 못 미쳤고, 그래서 x 가 EDGE(8) 까지 밀렸던 것이다.
  // 클램프는 제 일을 했다 — 좌우밖에 없던 게 문제였다.
  //
  // 하단바 표 한 줄: 화면 1400x900, 사이드바 300, 줄이 300~1390 을 채운다. 툴팁은 max-width 380.
  const wideRow = rect(300, 700, 1090, 26)

  it('★ 줄 전체처럼 넓은 앵커는 위로 붙는다 — 화면 왼쪽 끝으로 안 튄다', () => {
    const p = placeTip(wideRow, 380, 24, 1400, 900)
    expect(p.side).toBe('top')
    expect(p.y).toBe(700 - 6 - 24)
    // 예전엔 여기가 8(화면 왼쪽 끝)이었다. 이제 잘린 글자가 있는 줄의 시작점에 선다.
    expect(p.x).toBe(300)
  })

  it('위가 모자라면 아래 — 맨 윗줄이 이 경우다', () => {
    const p = placeTip(rect(300, 10, 1090, 26), 380, 24, 1400, 900)
    expect(p.side).toBe('bottom')
    expect(p.y).toBe(10 + 26 + 6)
  })

  it('아래로 갈 때도 화면 밖으로 안 나간다 — 화면을 거의 채운 앵커', () => {
    // 위도 아래도 모자라는 유일한 모양: 앵커가 세로로도 화면을 거의 다 먹는다.
    const p = placeTip(rect(300, 10, 1090, 860), 380, 24, 1400, 900)
    expect(p.side).toBe('bottom')
    expect(p.y).toBe(900 - 24 - 8)
  })

  it('앵커가 화면보다 넓어도 x 는 화면 안이다', () => {
    const p = placeTip(rect(-50, 400, 1500, 26), 380, 24, 1400, 900)
    expect(p.side).toBe('top')
    expect(p.x).toBe(8)
  })

  it('★ 회귀 가드: 좁은 앵커는 여전히 좌우다 — 위/아래로 가면 다음 아이콘을 덮는다', () => {
    // 세로 아이콘 바를 위에서 아래까지 훑는다. 어느 자리에서도 top/bottom 이 나오면 안 된다.
    for (let top = 0; top <= 770; top += 38) {
      expect(placeTip(rect(8, top, 30, 30), 200, 24, 1000, 800).side).toBe('right') // 좌측 레일
      expect(placeTip(rect(962, top, 30, 30), 200, 24, 1000, 800).side).toBe('left') // 우측 레일
    }
  })
})

describe('잘린 글자만 툴팁 — pickCut', () => {
  // 준영님 제보(2026-09-05): "텍스트가 전부 보이면 굳이 호버 안 하고 잘리는 글자만 호버하게."
  //
  // 후보는 실제 배선과 같은 순서다: el 자신이 0번, 그 뒤가 자손(문서 순).
  // 하단바 프로세스 표 한 줄 — title 은 <tr> 에, 글자는 <td class="ccmd"> 가 그린다.
  const cmd = '/usr/lib/systemd/systemd --switched-root --system --deserialize 31'
  const row = (cmdCell: { scrollW: number; clientW: number }) => [
    { text: `1234root0.112.3${cmd}`, scrollW: 1090, clientW: 1090 }, // <tr>
    { text: '1234', scrollW: 32, clientW: 74 },
    { text: 'root', scrollW: 28, clientW: 116 },
    { text: '0.1', scrollW: 22, clientW: 74 },
    { text: '12.3', scrollW: 90, clientW: 118 },
    { text: cmd, ...cmdCell } // <td class="ccmd">
  ]

  it('★ 잘린 셀이 있으면 그 셀이 앵커다 — 줄 전체가 아니라', () => {
    expect(pickCut(cmd, row({ scrollW: 620, clientW: 300 }))).toEqual({ kind: 'anchor', index: 5 })
  })

  it('★ 같은 글자가 다 보이면 안 띄운다 — 툴팁이 더 알려 줄 게 없다', () => {
    expect(pickCut(cmd, row({ scrollW: 300, clientW: 620 }))).toEqual({ kind: 'skip' })
  })

  it('★ 화면에 그 글자가 아예 없으면 지금처럼 띄운다 — 아이콘 버튼이 이 부류다', () => {
    // <button title="새로고침"><RefreshCw /></button> — 글자를 그리는 자식이 없다(svg 뿐).
    const iconBtn = [
      { text: '', scrollW: 26, clientW: 26 },
      { text: '', scrollW: 0, clientW: 0 }
    ]
    expect(pickCut('새로고침', iconBtn)).toEqual({ kind: 'asIs' })
  })

  it('★ 화면 글자와 다른 설명문도 그대로 띄운다 — 이게 title 대부분이다', () => {
    const btn = [
      { text: '내려받기', scrollW: 60, clientW: 90 },
      { text: '내려받기', scrollW: 60, clientW: 90 }
    ]
    const tip = '원격에서 파일을 복사(Ctrl+C)하면 활성화됩니다'
    expect(pickCut(tip, btn)).toEqual({ kind: 'asIs' })
  })

  it('1px 은 잘린 게 아니다 — 서브픽셀 반올림이다', () => {
    expect(pickCut('bash', [{ text: 'bash', scrollW: 301, clientW: 300 }])).toEqual({ kind: 'skip' })
    expect(pickCut('bash', [{ text: 'bash', scrollW: 302, clientW: 300 }])).toEqual({ kind: 'anchor', index: 0 })
  })

  it('앞뒤 공백은 같은 글자로 본다 — 셀 마크업의 줄바꿈이 여기 섞인다', () => {
    expect(pickCut('  bash  ', [{ text: '\n  bash\n', scrollW: 400, clientW: 300 }])).toEqual({
      kind: 'anchor',
      index: 0
    })
  })

  it('같은 글자가 여럿이면 처음 잘린 것 — 밖이 안 잘렸어도 안이 잘렸으면 안쪽이다', () => {
    const nested = [
      { text: '아주 긴 세션 이름', scrollW: 200, clientW: 200 }, // 감싼 div 는 안 잘림
      { text: '아주 긴 세션 이름', scrollW: 200, clientW: 120 } // 실제로 자르는 span
    ]
    expect(pickCut('아주 긴 세션 이름', nested)).toEqual({ kind: 'anchor', index: 1 })
  })

  it('★ 둘을 합치면: 셀을 앵커로 잡으면 좌우로 되돌아간다', () => {
    // ccmd 셀은 고정 열(382px) 뒤에서 시작한다 → 왼쪽에 380 이 들어간다.
    const p = placeTip(rect(682, 700, 708, 26), 380, 24, 1400, 900)
    expect(p.side).toBe('left')
    expect(p.x).toBe(682 - 6 - 380)
  })
})
