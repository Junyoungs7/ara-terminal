// SessionBackend — pty와 ssh2 shell 채널을 동일 파이프라인(배칭/pause·resume)에 태우기 위한 좁은 어댑터.
// 계획서 §C F3: 로컬과 동일한 세션 파이프라인에 SSH를 태운다(별도 경로 금지).
export interface SessionBackend {
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (exitCode: number, signal?: number) => void): void
  /**
   * 셸 출력이 아닌 경로로 알아낸 작업 디렉토리(SSH 전용 — SshBackend 의 /proc 추적).
   * 로컬 pty 는 셸 통합이 OSC7 을 방출하므로 구현하지 않는다.
   */
  onCwd?(cb: (cwd: string) => void): void
}
