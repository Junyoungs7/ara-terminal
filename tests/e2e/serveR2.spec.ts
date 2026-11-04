// 원격 3차 R2 서버에서 상태 판정 — 설치 동의 화면에 훅 설정 파일 둘이 보이는지(무엇을 쓰는지 숨기지 않는다), [취소]면 아무것도 안 쓰는지.
// 훅 → orcad → 두 PC 가 같은 status · 늦게 붙은 PC 의 마지막 상태 · 서버 ~/.claude 그대로는 tests/managedOrcad.test.ts '서버 훅'(WSL 원격 홈)이 맡는다.
// 하네스 exec 은 흉내만이라 원격 탭의 글리프·카드·알림은 실서버 확인(USER-CHECKLIST).
import type { ServerChannel } from 'ssh2'
import { test, expect, connectNewSshProfile, dialog, dialogCancel } from './fixtures'

const drawer = '.settings-page.open'
const LINUX = 'os=Linux\narch=x86_64\nhome=/home/tester\npython=/usr/bin/python3\npyver=3.10\npymods=1\n'

test('SERVE-R2-1 설치 동의 화면에 훅 설정 파일(claude·gemini) — 취소하면 아무것도 안 쓴다', async ({ ara, ssh }) => {
  const cmds: string[] = []
  const handler = (command: string, stream: ServerChannel): void => {
    cmds.push(command)
    if (command.includes('uname -s')) stream.write(LINUX)
    stream.exit(0)
    stream.end()
  }
  const h = await ssh({ password: 'pw-serve-r2', execHandler: handler })
  await connectNewSshProfile(ara.page, { name: 'serve-r2', port: h.port, password: 'pw-serve-r2' })
  await ara.page.keyboard.press('Control+,')
  await ara.page.click(`${drawer} .sp-nav [data-section="managed"]`)
  await ara.page.click(`${drawer} [data-managed="install"]`)
  const d = dialog(ara.page)
  await expect(d).toContainText('/home/tester/.ara-server/claude-hooks.json')
  await expect(d).toContainText('/home/tester/.ara-server/gemini-hooks.json')
  // 서버 사용자 설정 폴더에는 쓰지 않는다.
  await expect(d).not.toContainText('.claude/settings.json')
  await dialogCancel(ara.page)
  expect(cmds.some((c) => c.includes('mkdir'))).toBe(false)
})
