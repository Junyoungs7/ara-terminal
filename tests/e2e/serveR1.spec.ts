// 원격 3차 R1 다른 PC 에서 이어 보기 — 이미 설치된 서버 채택 동의(목업 2-adopt A)·서버 세션 화면(1-sessions A)·F1 "서버 세션"(B).
// managed.spec(M8)처럼 하네스(127.0.0.1)의 exec 은 흉내만 낸다 — "다른 PC 가 깐 서버"를 묻기 출력(installed=)으로 흉내 내고,
// 채택 화면이 뜨는지와 [취소]면 서버에 아무것도 안 쓰는지를 본다. 실제 PC 둘(목록·붙기·replay·양쪽 입력·끊김·이 PC 에서만 닫기·서버에서 끝내기)은
// tests/managedOrcad.test.ts 의 'PC 둘' 시험(WSL 원격 홈). 실서버 확인은 USER-CHECKLIST.
import type { ServerChannel } from 'ssh2'
import { test, expect, connectNewSshProfile, dialog, dialogCancel } from './fixtures'

const drawer = '.settings-page.open'
const LINUX = 'os=Linux\narch=x86_64\nhome=/home/tester\npython=/usr/bin/python3\npyver=3.10\npymods=1\n'

function fakeRemote(probeOut: string): { cmds: string[]; handler: (command: string, stream: ServerChannel) => void } {
  const cmds: string[] = []
  return {
    cmds,
    handler: (command, stream) => {
      cmds.push(command)
      if (command.includes('uname -s')) stream.write(probeOut)
      stream.exit(0)
      stream.end()
    }
  }
}

// SERVE-1 다른 PC 가 깐 서버(같은 버전) — [설치] 대신 채택 화면: "이미 있습니다" · 서버에 쓰는 것 없음 · [이 PC 에서도 쓰기]. 취소면 아무것도 안 쓴다.
test('SERVE-1 이미 설치된 서버는 채택 동의 화면 — 취소하면 서버에 아무것도 안 쓴다', async ({ ara, ssh }) => {
  const version = await ara.app.evaluate(({ app }) => app.getVersion())
  const remote = fakeRemote(`${LINUX}installed=${version}\n`)
  const h = await ssh({ password: 'pw-serve1', execHandler: remote.handler })
  await connectNewSshProfile(ara.page, { name: 'serve-1', port: h.port, password: 'pw-serve1' })
  await ara.page.keyboard.press('Control+,')
  await ara.page.click(`${drawer} .sp-nav [data-section="managed"]`)
  await ara.page.click(`${drawer} [data-managed="install"]`)
  const d = dialog(ara.page)
  await expect(d).toContainText('이 서버에 아라 서버가 이미 있습니다')
  await expect(d).toContainText('이 PC 와 같음')
  await expect(d).toContainText('없음 — 이 PC 에 동의 기록만 남깁니다')
  await expect(d).toContainText('둘 다 입력')
  await expect(d.locator('.modal-ft .btn.pri')).toHaveText('이 PC 에서도 쓰기')
  // 쉬운 말 — 이 화면에 데몬·orcad 라는 말이 없다.
  await expect(d).not.toContainText('데몬')
  await expect(d).not.toContainText('orcad')
  await dialogCancel(ara.page)
  expect(remote.cmds.some((c) => c.includes('mkdir'))).toBe(false)
  await expect(ara.page.locator(`${drawer} [data-managed="remove"]`)).toHaveCount(0)
})

// SERVE-2 서버가 옛 버전 — 판을 비교해 알린다(세션이 없으면 올린다는 것). 판을 낮추는 문구는 없다.
test('SERVE-2 옛 버전 서버 채택 — 올린다고 알린다', async ({ ara, ssh }) => {
  const remote = fakeRemote(`${LINUX}installed=0.0.1\n`)
  const h = await ssh({ password: 'pw-serve2', execHandler: remote.handler })
  await connectNewSshProfile(ara.page, { name: 'serve-2', port: h.port, password: 'pw-serve2' })
  await ara.page.keyboard.press('Control+,')
  await ara.page.click(`${drawer} .sp-nav [data-section="managed"]`)
  await ara.page.click(`${drawer} [data-managed="install"]`)
  const d = dialog(ara.page)
  await expect(d).toContainText('0.0.1')
  await expect(d).toContainText('으로 올립니다')
  await dialogCancel(ara.page)
  expect(remote.cmds.some((c) => c.includes('mkdir'))).toBe(false)
})

// SERVE-3 AI 공간 › 서버 — 쓰는 서버가 없으면 할 일 한 줄. F1 에는 서버 세션 묶음이 없다(빈 목록을 그리지 않는다).
test('SERVE-3 서버 세션 화면 — 쓰는 서버가 없으면 안내, F1 에 빈 묶음 없음', async ({ ara }) => {
  const { page } = ara
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await page.click('.ai-rail [data-aiws="servers"]')
  const view = page.locator('[data-aiws="servers"][role="region"]')
  await expect(view).toBeVisible()
  await expect(view).toContainText('아직 쓰는 서버가 없습니다')
  await page.keyboard.press('F1')
  await expect(page.locator('.cp-drop')).toBeVisible()
  await expect(page.locator('.cp-drop .cp-group', { hasText: '서버 세션' })).toHaveCount(0)
  await page.keyboard.press('Escape')
})
