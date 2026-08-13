// 로그 패널이 읽어 가는 쪽. 두 출처를 하나로 합친다:
//   · F12 기록 파일 — 세션 시작부터 전부. 단, 사용자가 [세션 기록]을 켜 뒀을 때만 존재한다(기본 off).
//   · 링버퍼 — 항상 있지만 최근 256KB 뿐(main 이 화면 재생용으로 들고 있는 그것).
//
// 긴 로그 대책(파일 분할 없이):
//   ① 뒤에서부터 창(window) 단위로 읽는다 — 20MB 파일이어도 한 번에 CHUNK 만 오간다.
//      renderer 는 start 를 들고 "이전 불러오기"로 앞쪽을 이어 붙인다(한 화면, 끊김 없음).
//   ② 줄 경계에서 자른다 — 창 경계가 글자 중간을 끊어 깨진 글자가 보이지 않게.
// 다운로드는 창이 아니라 파일 전체를 준다(뷰어는 창, 아카이브는 파일).
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { createMasker } from '@shared/maskSecrets'
import type { SessionLogReadResult } from '@shared/ipc'
import { newStripState, normalizeCr, stripAnsi } from './SessionLog'

/** 한 번에 읽어 보내는 크기. 링버퍼 상한과 같게 둔다 — 두 출처의 체감이 같아진다. */
export const LOG_CHUNK = 256 * 1024

/**
 * 파일의 [start, before) 구간을 읽는다. before 를 주지 않으면 끝에서부터.
 * start 는 줄 경계로 당겨진 실제 시작 위치 — 0 이면 앞이 더 없다는 뜻이다.
 */
export function readFileWindow(path: string, before?: number): SessionLogReadResult {
  let fd = -1
  try {
    const size = statSync(path).size
    const end = Math.max(0, Math.min(before ?? size, size))
    const from = Math.max(0, end - LOG_CHUNK)
    const len = end - from
    const buf = Buffer.alloc(len)
    fd = openSync(path, 'r')
    if (len > 0) readSync(fd, buf, 0, len, from)
    let text = buf.toString('utf8')
    let start = from
    // 앞을 잘랐으면 첫 줄은 반 토막이다 — 개행까지 버린다(멀티바이트 글자 깨짐도 같이 사라진다).
    if (from > 0) {
      const nl = text.indexOf('\n')
      if (nl >= 0) {
        start = from + Buffer.byteLength(text.slice(0, nl + 1), 'utf8')
        text = text.slice(nl + 1)
      }
    }
    return { ok: true, text, source: 'file', start, size }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        /* 이미 닫힘 */
      }
    }
  }
}

/**
 * 링버퍼(화면 재생용 원본) → 사람이 읽는 텍스트. 파일 경로와 같은 정제를 거친다:
 * ANSI 제거 → CR 정규화 → **마스킹**. 마스킹을 빼면 패널에서 내려받은 파일에 비밀번호가 남는다
 * (F12 의 "기록 전 마스킹" 불변식은 이쪽에도 그대로 적용된다).
 */
export function bufferToText(chunk: Uint8Array): string {
  const raw = Buffer.from(chunk).toString('utf8')
  return createMasker().mask(normalizeCr(stripAnsi(raw, newStripState())))
}
