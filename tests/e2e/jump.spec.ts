// M8 TM-01 점프 호스트 경유 접속 — 연결 관리자 [고급 연결] 칸 → 점프 지문 → 대상 지문 → 셸.
// 서버는 둘 다 로컬 ssh2 하네스(127.0.0.1)다. 점프 하네스가 direct-tcpip 를 받아 대상 포트로 잇는다.
// ⚠️ 이 라운드(M8 R2)에서는 작성만 했다 — 실행은 배포 전 전체 e2e 때.
import net from 'node:net'
import { test, expect, connModal, dialog, dialogConfirm, fillNewProfile, field, sessionIds, expectTermText } from './fixtures'

test('JUMP-1 점프 호스트를 거쳐 대상 서버에 붙는다(지문은 홉마다 따로 묻는다)', async ({ ara, ssh }) => {
  const { page } = ara
  let forwarded = 0
  const jump = await ssh({
    password: 'pw-jump',
    tcpipHandler: (info, ch) => {
      forwarded++
      const s = net.connect(info.destPort, info.destIP)
      ch.pipe(s).pipe(ch)
      s.on('error', () => ch.close())
      ch.on('close', () => s.destroy())
    }
  })
  const target = await ssh({ password: 'pw-target' })

  // ① 점프 서버를 프로필로 저장만 한다 — 그 비밀번호를 점프 홉이 빌려 쓴다.
  await page.keyboard.press('Control+Shift+M')
  await connModal(page).waitFor()
  await fillNewProfile(page, { name: 'bastion', port: jump.port, password: 'pw-jump' })
  await page.locator('.modal-ft .btn', { hasText: /^저장$/ }).click()

  // ② 대상 프로필: [고급 연결] 의 점프 호스트 칸에 ProxyJump 표기로 적고 [저장 후 접속].
  await fillNewProfile(page, { name: 'behind-bastion', port: target.port, password: 'pw-target' })
  await field(page, '점프 호스트').fill(`dev@127.0.0.1:${jump.port}`)
  const before = await sessionIds(page)
  await page.click('.modal-ft .btn.pri')

  // ③ 지문은 한 번에 하나 — 점프 먼저, 그다음 대상.
  for (const port of [jump.port, target.port]) {
    await dialog(page).waitFor({ timeout: 20_000 })
    await expect(dialog(page)).toContainText('처음 보는 호스트키')
    await expect(dialog(page)).toContainText(`127.0.0.1:${port}`)
    await dialogConfirm(page)
  }
  await expect.poll(async () => (await sessionIds(page)).length, { timeout: 30_000 }).toBe(before.length + 1)
  const id = (await sessionIds(page)).find((x) => !before.includes(x))!
  await expectTermText(page, id, /원격 셸 준비 완료/)
  expect(forwarded).toBeGreaterThanOrEqual(1) // 대상에는 점프 서버가 붙었다
})
