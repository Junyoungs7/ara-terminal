// 🔴 **배선을 실제로 했는가** — 함수가 맞는 것과 **그 함수를 쓰는 것**은 다른 사실이다 (#201 A).
//
// `sftpOverwrite.test.ts` 가 증명한 부류다: 거기서는 `freeRemotePath` 만 시험했더니 **호출을
// 지워도 6건이 전부 통과했다.** 이 라운드의 결함도 같은 모양이다 — `MainArea` 의 재접속·복제는
// 처음부터 멀쩡했고, `SessionWindow` 가 그 prop 을 **안 넘긴 것**이 전부였다.
//
// ⚠️ 이 시험은 **화면을 안 띄운다.** 소스에 그 줄이 있는지만 본다 — 실제로 눌러 보는 것은
//    실기 확인 항목이다. 대신 이 라운드가 되돌아가는 것(prop 이 다시 빠지는 것 · 복구 분기가
//    Shell 에 다시 심기는 것)은 여기서 걸린다.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')
const sessionWindow = src('src/renderer/components/SessionWindow.tsx')
const shell = src('src/renderer/components/Shell.tsx')

describe('#201 A — 떼어낸 창이 MainArea 에 실제로 넘기는가', () => {
  it('★ sshRestore 를 넘긴다 — 없으면 [다시 접속] 이 토스트조차 없이 아무 일도 안 한다', () => {
    expect(sessionWindow).toMatch(/\bsshRestore=\{/)
  })

  it('★ onDuplicateSession 을 넘긴다 — 없으면 SSH 탭 [복제] 가 로컬 셸을 연다(다른 일을 한다)', () => {
    expect(sessionWindow).toMatch(/\bonDuplicateSession=\{/)
  })

  it('onOpenLog 를 넘긴다 — 이 창에 [서버 로그] 탭이 실재한다', () => {
    expect(sessionWindow).toMatch(/\bonOpenLog=\{/)
  })

  it('재접속이 winId 를 싣는다 — 없으면 되살린 세션이 **본창에** 뜬다', () => {
    expect(sessionWindow).toMatch(/winId: target\.winId/)
  })
})

describe('#201 A-1 — 되묻는 절차가 한 벌인가', () => {
  it('★ Shell.connectProfile 이 connectWithRecovery 를 지난다', () => {
    expect(shell).toMatch(/const res = await connectWithRecovery\(/)
  })

  it('★ 복구 분기가 Shell 에 **다시 심기지 않았다** — 두 벌이 되는 순간이 여기서 걸린다', () => {
    // 호스트키 승낙 창·비밀번호 창의 문구 키는 이제 store/sshConnect.ts 한 곳에만 있다.
    expect(shell).not.toMatch(/conn\.hostkey\.trustBtn/)
    expect(shell).not.toMatch(/conn\.pw\.connect/)
  })

  it('양성 대조 — 그 키들은 공용 모듈에 **있다**(0건이 "없다"가 아니라 "못 찾는다"가 아님을 가른다)', () => {
    const shared = src('src/renderer/store/sshConnect.ts')
    expect(shared).toMatch(/conn\.hostkey\.trustBtn/)
    expect(shared).toMatch(/conn\.pw\.connect/)
  })
})

describe('#201 A-2 — 떼어낸 창이 빈 함수를 넘기지 않는다', () => {
  // 빈 함수는 확인창 "예" 뒤에 아무 일도 안 하게 만든다. 없으면 표가 버튼을 안 그린다.
  it('★ SessionWindow 에 `={() => {}}` 가 없다', () => {
    expect(sessionWindow).not.toMatch(/=\{\(\) => \{\}\}/)
    expect(sessionWindow).not.toMatch(/\bonAskAi=\{/)
    expect(sessionWindow).not.toMatch(/\bonOpenExplorer=\{/)
  })

  it('★ 표들이 핸들러가 없으면 버튼을 안 그린다', () => {
    expect(src('src/renderer/components/ProcessTable.tsx')).toMatch(/AI_ENTRY && onAskAi && \(/)
    expect(src('src/renderer/components/ServiceTable.tsx')).toMatch(/AI_ENTRY && onAskAi && \(/)
    expect(src('src/renderer/components/DiskTable.tsx')).toMatch(/\{onOpenExplorer && \(/)
  })
})
