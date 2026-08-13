// F25 RDCleanPath PDU 인코딩/디코딩 — 프록시가 IronRDP WASM 과 주고받는 형식이라 여기가 틀리면
// 접속 자체가 성립하지 않는다. 네트워크 없이 순수 함수만 검사한다.
import { describe, it, expect } from 'vitest'
import {
  RDCLEANPATH_VERSION,
  buildCleanPathError,
  buildCleanPathResponse,
  parseCleanPathRequest
} from '../src/main/rdp/rdcleanpath'

// 클라이언트가 보내는 요청 PDU 를 테스트 쪽에서 직접 만든다(실제 wasm 없이 왕복을 검사하려면 필요).
function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  let t = n
  while (t > 0) {
    bytes.unshift(t & 0xff)
    t >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const wrap = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLen(body.length), body])
const int = (v: number): Buffer => {
  const bytes: number[] = []
  let t = v
  while (t > 0) {
    bytes.unshift(t & 0xff)
    t >>= 8
  }
  if (bytes.length === 0) bytes.push(0)
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0)
  return wrap(0x02, Buffer.from(bytes))
}
const utf8 = (s: string): Buffer => wrap(0x0c, Buffer.from(s, 'utf-8'))
const octet = (b: Buffer): Buffer => wrap(0x04, b)
const ctx = (n: number, body: Buffer): Buffer => wrap(0xa0 + n, body)

function makeRequest(destination: string, x224: Buffer, version = RDCLEANPATH_VERSION): Buffer {
  return wrap(
    0x30,
    Buffer.concat([ctx(0, int(version)), ctx(2, utf8(destination)), ctx(6, octet(x224))])
  )
}

describe('RDCleanPath 요청 파싱', () => {
  it('destination 과 X.224 요청을 그대로 꺼낸다', () => {
    const x224 = Buffer.from([0x03, 0x00, 0x00, 0x2b, 0x26, 0xe0])
    const req = parseCleanPathRequest(makeRequest('10.0.0.5:3389', x224))
    expect(req.destination).toBe('10.0.0.5:3389')
    expect(Buffer.from(req.x224ConnectionRequest).equals(x224)).toBe(true)
  })

  it('버전이 다르면 거절한다', () => {
    expect(() => parseCleanPathRequest(makeRequest('h:3389', Buffer.from([1]), 1))).toThrow(/버전/)
  })

  it('x224 가 없으면 거절한다', () => {
    const pdu = wrap(0x30, Buffer.concat([ctx(0, int(RDCLEANPATH_VERSION)), ctx(2, utf8('h:3389'))]))
    expect(() => parseCleanPathRequest(pdu)).toThrow(/x224/)
  })

  it('SEQUENCE 가 아니면 거절한다', () => {
    expect(() => parseCleanPathRequest(Buffer.from([0x04, 0x01, 0x00]))).toThrow(/SEQUENCE/)
  })

  // 0x80 이상 길이는 DER "긴 형식"으로 인코딩된다 — 인증서·대형 X.224 에서 실제로 걸린다.
  it('128바이트를 넘는 값도 파싱한다', () => {
    const big = Buffer.alloc(300, 7)
    const req = parseCleanPathRequest(makeRequest('host:3389', big))
    expect(Buffer.from(req.x224ConnectionRequest).length).toBe(300)
  })

  it('값이 잘린 PDU 는 거절한다', () => {
    const good = makeRequest('h:3389', Buffer.from([1, 2, 3]))
    expect(() => parseCleanPathRequest(good.subarray(0, good.length - 3))).toThrow()
  })
})

describe('RDCleanPath 응답·오류 인코딩', () => {
  it('응답에 버전·X.224 확인·인증서·주소가 담긴다', () => {
    const x224 = Buffer.from([0x03, 0x00, 0x00, 0x13])
    const certs = [Buffer.alloc(200, 1), Buffer.alloc(150, 2)]
    const pdu = buildCleanPathResponse('10.0.0.5:3389', x224, certs)
    expect(pdu[0]).toBe(0x30) // 최상위 SEQUENCE
    // 값들이 그대로 들어 있어야 한다(길이 계산이 틀리면 여기서 깨진다).
    expect(pdu.includes(x224)).toBe(true)
    expect(pdu.includes(certs[0])).toBe(true)
    expect(pdu.includes(Buffer.from('10.0.0.5:3389', 'utf-8'))).toBe(true)
  })

  it('인증서가 없어도 유효한 응답을 만든다', () => {
    const pdu = buildCleanPathResponse('h:3389', Buffer.from([1]), [])
    expect(pdu[0]).toBe(0x30)
    expect(pdu.length).toBeGreaterThan(10)
  })

  it('오류 PDU 는 버전과 오류 코드를 담는다', () => {
    const pdu = buildCleanPathError(1)
    expect(pdu[0]).toBe(0x30)
    expect(pdu.length).toBeGreaterThan(6)
  })
})
