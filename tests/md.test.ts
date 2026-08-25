// #137 마크다운 조금 — **HTML 을 만들지 않는다**(md.tsx 주석 참고). 여기서는 블록·인라인 규칙만 본다.
// 화면은 이 결과를 React 엘리먼트로 옮기기만 한다.
import { describe, it, expect } from 'vitest'
import { mdBlocks, mdInline } from '../src/renderer/components/md'

describe('블록 가르기', () => {
  it('문단은 빈 줄까지 한 덩어리다 — 한 줄씩 끊으면 답변이 사다리처럼 보인다', () => {
    const b = mdBlocks('첫 줄\n이어진 줄\n\n다음 문단')
    expect(b).toEqual([
      { k: 'p', text: '첫 줄\n이어진 줄' },
      { k: 'p', text: '다음 문단' }
    ])
  })

  it('★ 코드블록은 닫히지 않아도 코드다 — 스트리밍 중에는 늘 열려 있다', () => {
    expect(mdBlocks('```bash\nls -al\n')).toEqual([{ k: 'code', lang: 'bash', text: 'ls -al' }])
    expect(mdBlocks('```\nplain\n```')).toEqual([{ k: 'code', lang: '', text: 'plain' }])
  })

  it('코드블록 안의 마크다운 문법은 **글자 그대로**다', () => {
    const b = mdBlocks('```\n# 제목이 아니다\n- 목록도 아니다\n```')
    expect(b).toEqual([{ k: 'code', lang: '', text: '# 제목이 아니다\n- 목록도 아니다' }])
  })

  it('제목·목록·인용·구분선', () => {
    expect(mdBlocks('## 둘')).toEqual([{ k: 'h', level: 2, text: '둘' }])
    expect(mdBlocks('- 가\n- 나')).toEqual([{ k: 'ul', items: ['가', '나'] }])
    expect(mdBlocks('1. 가\n2. 나')).toEqual([{ k: 'ol', items: ['가', '나'] }])
    expect(mdBlocks('> 인용\n> 둘째')).toEqual([{ k: 'quote', text: '인용\n둘째' }])
    expect(mdBlocks('---')).toEqual([{ k: 'hr' }])
  })

  it('★ 모르는 문법은 사라지지 않는다 — 글자 그대로 남는 것이 안전한 실패다', () => {
    const b = mdBlocks('| 표 | 는 |\n|---|---|\n| 아직 | 없다 |')
    // 표는 지원하지 않는다. 그래도 내용은 전부 남아 있어야 한다.
    const all = b.map((x) => ('text' in x ? x.text : '')).join('\n')
    expect(all).toContain('표')
    expect(all).toContain('아직')
  })

  it('빈 글은 빈 목록', () => {
    expect(mdBlocks('')).toEqual([])
    expect(mdBlocks('\n\n')).toEqual([])
  })
})

describe('인라인 강조', () => {
  it('코드·굵게·기울임', () => {
    expect(mdInline('앞 `code` 뒤')).toEqual(['앞 ', { k: 'code', text: 'code' }, ' 뒤'])
    expect(mdInline('**굵게**')).toEqual([{ k: 'b', text: '굵게' }])
    expect(mdInline('*기울임*')).toEqual([{ k: 'i', text: '기울임' }])
    expect(mdInline('__도 굵게__')).toEqual([{ k: 'b', text: '도 굵게' }])
  })

  it('★ 코드가 이긴다 — 코드 안의 별표는 글자다', () => {
    expect(mdInline('`a * b ** c`')).toEqual([{ k: 'code', text: 'a * b ** c' }])
  })

  it('짝이 안 맞으면 건드리지 않는다', () => {
    expect(mdInline('별 하나 * 만')).toEqual(['별 하나 * 만'])
    expect(mdInline('열린 `백틱')).toEqual(['열린 `백틱'])
  })
})
