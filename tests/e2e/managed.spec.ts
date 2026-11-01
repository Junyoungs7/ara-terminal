// M8 DM-03 관리형 서버 — 설치는 동의 화면의 [설치] 일 때만(터미널 접속은 서버에 아무것도 깔지 않는다).
// 하네스(127.0.0.1)의 exec 은 흉내만 낸다 — 이 시험은 "동의 전에는 원격에 아무것도 쓰지 않는다"를 본다. 실제 설치·제거·흔적 0 은 tests/managedOrcad.test.ts(WSL 원격 홈).
import type { ServerChannel } from 'ssh2'
import { test, expect, connectNewSshProfile, dialog, dialogCancel } from './fixtures'

const drawer = '.settings-page.open'
const LINUX = 'os=Linux\narch=x86_64\nhome=/home/tester\npython=/usr/bin/python3\npyver=3.10\npymods=1\n'

/** 원격 exec 흉내: 묻기(uname)에만 답하고 나머지는 기록만. */
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

async function openManaged(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .sp-nav [data-section="managed"]`)
  await expect(page.locator(`${drawer} [data-sec="managed"]`)).toBeVisible()
}

// MGD-1 동의 화면이 무엇을·어디에·상주·지우는 법을 보여 주고, [취소]하면 원격에 아무것도 쓰지 않는다.
test('MGD-1 설치 동의 화면 — 취소하면 서버에 아무것도 안 생긴다', async ({ ara, ssh }) => {
  const remote = fakeRemote(LINUX)
  const h = await ssh({ password: 'pw-mgd1', execHandler: remote.handler })
  await connectNewSshProfile(ara.page, { name: 'mgd-1', port: h.port, password: 'pw-mgd1' })
  // 접속만으로는 관리형 명령이 하나도 가지 않는다(터미널 공간 원칙). 셸 PID 질의(remoteCwd) 같은 접속 쪽 exec 은 따로 있다.
  const ours = (): string[] => remote.cmds.filter((c) => c.includes('ara-server') || c.includes('uname'))
  expect(ours()).toEqual([])
  await openManaged(ara.page)
  await ara.page.click(`${drawer} [data-managed="install"]`)
  const d = dialog(ara.page)
  await expect(d).toContainText('이 서버에 아라 데몬을 설치할까요?')
  await expect(d).toContainText('/home/tester/.ara-server/orcad.py')
  await expect(d).toContainText('python3 /home/tester/.ara-server/orcad.py serve')
  await expect(d).toContainText('rm -rf ~/.ara-server')
  await dialogCancel(ara.page)
  // 묻기 한 번뿐 — mkdir·sftp 쓰기 없음, 목록도 비어 있다.
  expect(ours().length).toBe(1)
  expect(remote.cmds.some((c) => c.includes('mkdir'))).toBe(false)
  await expect(ara.page.locator(`${drawer} [data-managed="remove"]`)).toHaveCount(0)
})

// MGD-2 Linux 가 아니면 "지원 안 함"만 알리고 설치 버튼이 없다.
test('MGD-2 지원하지 않는 서버는 이유를 알리고 설치하지 않는다', async ({ ara, ssh }) => {
  const remote = fakeRemote(LINUX.replace('Linux', 'Darwin'))
  const h = await ssh({ password: 'pw-mgd2', execHandler: remote.handler })
  await connectNewSshProfile(ara.page, { name: 'mgd-2', port: h.port, password: 'pw-mgd2' })
  await openManaged(ara.page)
  await ara.page.click(`${drawer} [data-managed="install"]`)
  await expect(dialog(ara.page)).toContainText('Linux 서버만')
  expect(remote.cmds.some((c) => c.includes('mkdir'))).toBe(false)
})
