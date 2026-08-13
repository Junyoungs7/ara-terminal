// 편집기가 열어도 되는 파일인지 판정하는 규칙(순수 — 단위 테스트 대상).
// 메모장처럼 "열고 고치고 저장"하는 창이라, 열면 안 되는 것을 여는 쪽이 위험하다:
//   · 큰 파일 — 4GB 로그를 textarea 에 넣으면 렌더러가 그대로 멈춘다.
//   · 바이너리 — 텍스트로 읽었다가 저장하면 원본이 깨진다(되돌릴 수 없다).

/** 편집기로 열 수 있는 최대 크기. 넘으면 열지 않는다(자르면 저장 시 뒷부분이 날아간다). */
export const EDIT_MAX_BYTES = 2 * 1024 * 1024

/** 바이너리 판정용으로 들여다보는 앞부분 길이. */
const SNIFF = 8192

/**
 * NUL 바이트가 있으면 바이너리로 본다 — 텍스트 파일에는 사실상 안 나오고, 대부분의 실행파일·
 * 이미지·압축 파일에는 앞부분에 반드시 나온다. UTF-16 은 NUL 이 섞여 있어 바이너리로 걸리는데,
 * 그건 의도한 결과다(UTF-8 로 저장하면 깨지므로 열지 않는 편이 낫다).
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, SNIFF)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}
