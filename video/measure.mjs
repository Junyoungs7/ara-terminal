/**
 * 만들어진 나레이션 음성의 **실제 길이**를 재서 씬 길이 표를 만든다 — `npm run measure`.
 *
 * 왜 재는가: 초를 손으로 적으면 음성이 문장보다 길거나 짧아 화면과 어긋난다. 대본을 한 글자
 * 고칠 때마다 초를 다시 맞추는 일도 사람이 할 일이 아니다. **음성이 기준이고 화면이 따라간다.**
 *
 * wav 헤더만 읽는다(디코딩하지 않는다): data 청크 크기 ÷ 초당 바이트 = 초.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VO = join(process.cwd(), 'public', 'vo')
const FPS = 30
/** 문장이 끝나고 다음 장면으로 넘어가기 전의 숨. 없으면 낭독이 숨 가쁘게 들린다. */
const TAIL_SEC = 0.55

/** RIFF/WAVE 헤더에서 초를 뽑는다. SAPI 출력은 PCM 이라 청크 구조가 단순하다. */
function wavSeconds(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('wav 가 아니다')
  }
  let pos = 12
  let byteRate = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') byteRate = buf.readUInt32LE(pos + 16)
    if (id === 'data') {
      if (!byteRate) throw new Error('fmt 청크가 data 보다 늦게 나왔다')
      // data 크기가 0xFFFFFFFF 로 남는 스트리밍 출력도 있어 파일 실크기로 한 번 더 자른다.
      return Math.min(size, buf.length - pos - 8) / byteRate
    }
    pos += 8 + size + (size % 2) // 청크는 짝수 바이트 경계에 붙는다
  }
  throw new Error('data 청크를 못 찾았다')
}

const out = {}
for (const name of readdirSync(VO)) {
  if (!name.endsWith('.wav')) continue
  const sec = wavSeconds(readFileSync(join(VO, name))) + TAIL_SEC
  out[name.replace(/\.wav$/, '')] = Math.max(30, Math.round(sec * FPS)) // 프레임 수(최소 1초)
}

writeFileSync(join(process.cwd(), 'src', 'durations.json'), JSON.stringify(out, null, 2) + '\n', 'utf8')
const total = Object.values(out).reduce((a, b) => a + b, 0)
console.log(`${Object.keys(out).length}개 씬 · 합계 ${(total / FPS).toFixed(1)}초 → src/durations.json`)
