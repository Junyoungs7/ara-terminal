// RDCleanPath PDU 인코딩/디코딩 (ASN.1 DER) — IronRDP WASM 클라이언트가 프록시와 주고받는 형식.
// 참조: electerm/ironrdp-wasm 의 example/lib/rdp-proxy.js (MIT). 순수 함수만 두어 단위 테스트한다
// — 네트워크·TLS 는 RdpRelay.ts 가 맡는다(같은 파일에 섞으면 프로토콜을 테스트할 수 없다).

export const RDCLEANPATH_VERSION = 3390 // 3389 + 1

const TAG_SEQUENCE = 0x30
const TAG_INTEGER = 0x02
const TAG_OCTET_STRING = 0x04
const TAG_UTF8STRING = 0x0c
const ctxTag = (n: number): number => 0xa0 + n

// 길이가 0x80 이상이면 "긴 형식"(첫 바이트에 길이 바이트 수) — DER 규칙.
function derEncodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let temp = length
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derWrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derEncodeLength(content.length), content])
}

function derEncodeInteger(value: number): Buffer {
  if (value === 0) return derWrap(TAG_INTEGER, Buffer.from([0]))
  const bytes: number[] = []
  let temp = value
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp >>= 8
  }
  // 최상위 비트가 서면 부호 없는 수임을 나타내려 0 을 앞에 붙인다(DER INTEGER 는 부호 있는 표현).
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0)
  return derWrap(TAG_INTEGER, Buffer.from(bytes))
}

const derEncodeUtf8String = (s: string): Buffer => derWrap(TAG_UTF8STRING, Buffer.from(s, 'utf-8'))
const derEncodeOctetString = (b: Buffer): Buffer => derWrap(TAG_OCTET_STRING, b)
const derWrapContext = (n: number, content: Buffer): Buffer => derWrap(ctxTag(n), content)

type Tlv = { tag: number; value: Buffer; end: number }

function derDecodeLength(buf: Buffer, offset: number): { length: number; next: number } {
  const first = buf[offset]
  if (first === undefined) throw new Error('DER: 길이 바이트가 없습니다')
  if (first < 0x80) return { length: first, next: offset + 1 }
  const count = first & 0x7f
  if (count === 0 || count > 4) throw new Error('DER: 지원하지 않는 길이 형식')
  let length = 0
  for (let i = 0; i < count; i += 1) {
    const b = buf[offset + 1 + i]
    if (b === undefined) throw new Error('DER: 길이 바이트가 잘렸습니다')
    length = (length << 8) | b
  }
  return { length, next: offset + 1 + count }
}

function derDecodeTLV(buf: Buffer, offset: number): Tlv {
  const tag = buf[offset]
  if (tag === undefined) throw new Error('DER: 태그가 없습니다')
  const { length, next } = derDecodeLength(buf, offset + 1)
  const end = next + length
  if (end > buf.length) throw new Error('DER: 값이 잘렸습니다')
  return { tag, value: buf.subarray(next, end), end }
}

function derDecodeChildren(buf: Buffer): Tlv[] {
  const out: Tlv[] = []
  let offset = 0
  while (offset < buf.length) {
    const tlv = derDecodeTLV(buf, offset)
    out.push(tlv)
    offset = tlv.end
  }
  return out
}

function derDecodeInteger(buf: Buffer): number {
  let value = 0
  for (const b of buf) value = (value << 8) | b
  return value
}

export type CleanPathRequest = {
  destination: string
  /** [3] proxy_auth — 릴레이가 발급한 1회용 토큰. URL 경로 검사와 이중으로 확인한다. */
  proxyAuth: string | null
  x224ConnectionRequest: Buffer
}

// 클라이언트(WASM)가 처음 보내는 PDU. 우리는 destination 을 **신뢰하지 않고** 참고만 한다 —
// 실제 접속 대상은 main 이 프로필에서 정한다(RdpRelay 주석 참고).
export function parseCleanPathRequest(data: Buffer): CleanPathRequest {
  const outer = derDecodeTLV(data, 0)
  if (outer.tag !== TAG_SEQUENCE) throw new Error(`RDCleanPath: SEQUENCE 가 아닙니다(0x${outer.tag.toString(16)})`)

  let version: number | null = null
  let destination: string | null = null
  let proxyAuth: string | null = null
  let x224ConnectionRequest: Buffer | null = null

  for (const child of derDecodeChildren(outer.value)) {
    const n = child.tag & 0x1f
    if (n === 0) version = derDecodeInteger(derDecodeTLV(child.value, 0).value)
    else if (n === 2) destination = derDecodeTLV(child.value, 0).value.toString('utf-8')
    else if (n === 3) proxyAuth = derDecodeTLV(child.value, 0).value.toString('utf-8')
    else if (n === 6) x224ConnectionRequest = derDecodeTLV(child.value, 0).value
  }

  if (version !== RDCLEANPATH_VERSION) throw new Error(`RDCleanPath: 버전 불일치(${version})`)
  if (!destination) throw new Error('RDCleanPath: destination 이 없습니다')
  if (!x224ConnectionRequest) throw new Error('RDCleanPath: x224_connection_pdu 가 없습니다')
  return { destination, proxyAuth, x224ConnectionRequest }
}

export function buildCleanPathResponse(serverAddr: string, x224Response: Buffer, certChain: Buffer[]): Buffer {
  const certSeq = derWrap(TAG_SEQUENCE, Buffer.concat(certChain.map(derEncodeOctetString)))
  return derWrap(
    TAG_SEQUENCE,
    Buffer.concat([
      derWrapContext(0, derEncodeInteger(RDCLEANPATH_VERSION)),
      derWrapContext(6, derEncodeOctetString(x224Response)),
      derWrapContext(7, certSeq),
      derWrapContext(9, derEncodeUtf8String(serverAddr))
    ])
  )
}

// errorCode: 1=일반, 2=협상 실패.
export function buildCleanPathError(errorCode: number): Buffer {
  const err = derWrap(TAG_SEQUENCE, derWrapContext(0, derEncodeInteger(errorCode)))
  return derWrap(
    TAG_SEQUENCE,
    Buffer.concat([derWrapContext(0, derEncodeInteger(RDCLEANPATH_VERSION)), derWrapContext(1, err)])
  )
}
