// 호스트키 TOFU (RC-6, 계획서 §C F3). 최초 접속 시 지문을 knownHosts에 저장,
// 이후 접속 시 지문 불일치면 연결 차단(MITM 방지). 순수 로직 — 단위 테스트 대상.
import { createHash } from 'node:crypto'
import type { KnownHost, HostKeyVerdict } from '@shared/types'

// ssh2 hostVerifier가 넘기는 호스트키(DER 바이트)의 SHA256 지문. OpenSSH와 동일한 표기(base64, '=' 제거).
export function fingerprintSha256(keyDer: Buffer): string {
  const b64 = createHash('sha256').update(keyDer).digest('base64').replace(/=+$/, '')
  return 'SHA256:' + b64
}

// knownHosts 키: "host:port" (계획서 §B.3 스키마).
export function hostId(host: string, port: number): string {
  return `${host}:${port}`
}

// TOFU 판정: 저장된 지문과 비교해 known/new/mismatch를 반환한다(부수효과 없음).
export function verifyHostKey(
  knownHosts: Record<string, KnownHost>,
  id: string,
  algorithm: string,
  fingerprint: string
): HostKeyVerdict {
  const known = knownHosts[id]
  if (!known) return { kind: 'new', hostId: id, algorithm, fingerprint }
  if (known.fingerprint === fingerprint) return { kind: 'known' }
  return { kind: 'mismatch', hostId: id, algorithm, fingerprint, known }
}
