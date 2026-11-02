// M15 R2 TM-04 macOS 로컬 네트워크 시험 결과(main/localNetwork/feature.ts ↔ 설정 › 터미널). 맥이 아니면 failure 'unsupported'.
export type LocalNetworkTestResult = {
  ok: boolean
  failure?: 'invalid-target' | 'unsupported' | 'timeout' | 'refused' | 'unreachable' | 'unresolved' | 'failed'
}
