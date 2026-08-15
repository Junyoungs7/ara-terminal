// SFTP 사이드바 (스펙 AC #4 / F7 · R7) — 원격 트리 · cd 연동 · 업/다운로드 · 진행률 · 취소 · 원격 조작
// 전송은 전부 루프백(127.0.0.1) 하네스와 OS 임시 디렉토리 사이에서만 한다(DLP: 실서버·실데이터 금지).
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, connectNewSshProfile, dialog, dialogConfirm, downloadsOf, openFileTab, sendInput } from './fixtures'

function makeRemote(): string {
  const root = mkdtempSync(join(tmpdir(), 'ara-remote-'))
  mkdirSync(join(root, '배포스크립트'))
  mkdirSync(join(root, '로그'))
  writeFileSync(join(root, '배포스크립트', 'deploy_운영.sh'), '#!/bin/sh\necho 배포\n')
  writeFileSync(join(root, 'README_한글.md'), '# 한글 문서\n서비스 안내\n')
  writeFileSync(join(root, '로그', 'error_20260731.log'), '오류 로그 한글\n')
  return root
}

// 저장/업로드 파일 선택은 OS 네이티브 다이얼로그다 — 테스트에서는 main 의 핸들러만 고정 경로로 바꾼다.
async function stubPickers(
  app: ElectronApplication,
  paths: { savePath: string; saveDir: string; uploadPaths: string[] }
): Promise<void> {
  await app.evaluate(({ ipcMain }, p) => {
    ipcMain.removeHandler('sftp:pickSavePath')
    ipcMain.handle('sftp:pickSavePath', () => ({ path: p.savePath }))
    ipcMain.removeHandler('sftp:pickSaveDir')
    ipcMain.handle('sftp:pickSaveDir', () => ({ path: p.saveDir }))
    ipcMain.removeHandler('sftp:pickUploadPaths')
    ipcMain.handle('sftp:pickUploadPaths', () => ({ paths: p.uploadPaths }))
  }, paths)
}

const row = (page: Page, name: string) => page.locator(`.ftree .frow:has(.fn:text-is("${name}"))`)

// SSH 접속 → [파일] 탭 = 원격(SFTP) 트리.
async function openRemoteTree(page: Page, port: number, password: string): Promise<string> {
  const id = await connectNewSshProfile(page, { name: 'sftp-remote', port, password })
  // Ctrl+Shift+E 는 **토글**이라 여기서 쓰면 안 된다: SSH 접속 직후에는 이미 [파일] 탭이 열려 있어
  // 오히려 닫아 버린다(증상이 "행은 찾았는데 hidden"). 상태를 보고 맞추는 헬퍼를 쓴다.
  await openFileTab(page)
  await expect(row(page, 'README_한글.md')).toBeVisible({ timeout: 25_000 })
  return id
}

// SFTP-1 원격 트리에 한글 파일명이 정상 렌더된다
test('SFTP-1 SSH 세션의 [파일] 탭이 원격 파일을 보여 준다', async ({ ara, ssh }) => {
  const remote = makeRemote()
  const h = await ssh({ password: 'pw-sftp1', sftpRoot: remote })
  await openRemoteTree(ara.page, h.port, 'pw-sftp1')
  const shown = await ara.page.locator('.ftree .frow .fn').allTextContents()
  expect(shown).toContain('배포스크립트/')
  expect(shown).toContain('README_한글.md')
  // 폴더 진입도 원격 경로로 동작한다.
  await row(ara.page, '로그/').dblclick()
  await expect(row(ara.page, 'error_20260731.log')).toBeVisible({ timeout: 15_000 })
})

// SFTP-2 원격 셸 cd → 트리 자동 이동(OSC7)
test('SFTP-2 원격 터미널 cd 에 트리가 따라간다', async ({ ara, ssh }) => {
  const remote = makeRemote()
  const h = await ssh({ password: 'pw-sftp2', sftpRoot: remote, emitOsc7OnCd: true })
  const id = await openRemoteTree(ara.page, h.port, 'pw-sftp2')
  await sendInput(ara.page, id, 'cd /로그\n')
  await expect(row(ara.page, 'error_20260731.log')).toBeVisible({ timeout: 25_000 })
})

// SFTP-3 업로드(파일 선택 다이얼로그 → 원격에 생성)
test('SFTP-3 파일을 원격으로 업로드한다', async ({ ara, ssh }) => {
  const remote = makeRemote()
  const localDir = mkdtempSync(join(tmpdir(), 'ara-local-'))
  const upload = join(localDir, '업로드_확인.txt')
  writeFileSync(upload, '업로드 확인 한글\n')
  const h = await ssh({ password: 'pw-sftp3', sftpRoot: remote })
  await stubPickers(ara.app, { savePath: join(localDir, 'dl.bin'), saveDir: localDir, uploadPaths: [upload] })
  await openRemoteTree(ara.page, h.port, 'pw-sftp3')

  await ara.page.click('.sftp-path-bar .sb-act[title="파일 업로드"], .sftp-path-bar .sb-act[data-tip="파일 업로드"]')
  await expect(row(ara.page, '업로드_확인.txt')).toBeVisible({ timeout: 25_000 })
  expect(existsSync(join(remote, '업로드_확인.txt'))).toBe(true)
  expect(readFileSync(join(remote, '업로드_확인.txt'), 'utf8')).toContain('업로드 확인 한글')
})

// SFTP-4 다운로드(파일 더블클릭 → **묻지 않고** 받는 곳으로 → 어디 갔는지 알려 준다)
// #92(2026-08-16): 예전에는 더블클릭이 저장 위치 대화상자를 열었다. 2026-08-09 에 그렇게 정한 이유는
// "붙여넣기가 조용히 떨어져 어디 갔는지 모른다"였는데 — 막아야 했던 것은 **조용히**지 빠른 것이 아니다.
// 이제 정해진 곳에 받고 경로를 줄로 알려 준다. 위치를 고르는 길은 [다른 위치에 받기]로 남아 있다(SFTP-4b).
test('SFTP-4 파일을 더블클릭하면 대화상자 없이 받고 어디 갔는지 알려 준다', async ({ ara, ssh }) => {
  const remote = makeRemote()
  const h = await ssh({ password: 'pw-sftp4', sftpRoot: remote })
  await openRemoteTree(ara.page, h.port, 'pw-sftp4')

  await row(ara.page, 'README_한글.md').dblclick()
  // 파일은 전송 시작과 함께 만들어진다 — 내용이 다 들어올 때까지 기다린다.
  const got = join(downloadsOf(ara), 'README_한글.md')
  await expect
    .poll(() => (existsSync(got) ? readFileSync(got, 'utf8') : ''), { timeout: 30_000 })
    .toContain('한글 문서')
  // 받는 곳을 묻지 않는 대신 이 줄이 어디로 갔는지 말한다(경로 전문은 title).
  const line = ara.page.locator('.sftp-got')
  await expect(line).toBeVisible({ timeout: 15_000 })
  await expect(line.locator('.g-txt')).toContainText('README_한글.md')
  await expect(line.locator('.g-txt')).toHaveAttribute('title', got)
})

// SFTP-4b ★ 같은 파일을 또 받으면 덮어쓰지 않는다 — 조용한 덮어쓰기는 조용한 삭제와 같다.
test('SFTP-4b 같은 파일을 두 번 받으면 (2) 가 붙는다', async ({ ara, ssh }) => {
  const remote = makeRemote()
  const h = await ssh({ password: 'pw-sftp4b', sftpRoot: remote })
  await openRemoteTree(ara.page, h.port, 'pw-sftp4b')
  const dir = downloadsOf(ara)

  await row(ara.page, 'README_한글.md').dblclick()
  await expect.poll(() => existsSync(join(dir, 'README_한글.md')), { timeout: 30_000 }).toBe(true)
  await row(ara.page, 'README_한글.md').dblclick()
  await expect.poll(() => existsSync(join(dir, 'README_한글 (2).md')), { timeout: 30_000 }).toBe(true)
  // 첫 파일은 그대로 남아 있다(덮어쓰지 않았다).
  expect(readFileSync(join(dir, 'README_한글.md'), 'utf8')).toContain('한글 문서')
})

// SFTP-5 전송 진행률 표시 + 취소 시 부분 파일 정리
test('SFTP-5 큰 파일 전송을 취소하면 부분 파일이 정리된다', async ({ ara, ssh }) => {
  const remote = makeRemote()
  // 취소를 누를 시간을 벌 만큼만 크게(48MB). 무해한 반복 바이트.
  writeFileSync(join(remote, 'access_big.log'), Buffer.alloc(48 * 1024 * 1024, 0x41))
  const h = await ssh({ password: 'pw-sftp5', sftpRoot: remote })
  await openRemoteTree(ara.page, h.port, 'pw-sftp5')
  // #92: 받는 곳을 묻지 않으므로 저장 경로는 받는 폴더 안 원본 이름이다.
  const savePath = join(downloadsOf(ara), 'access_big.log')

  await row(ara.page, 'access_big.log').dblclick()
  const xfer = ara.page.locator('.sftp-xfer .xfer-item')
  await expect(xfer).toHaveCount(1, { timeout: 20_000 })
  await expect(xfer.locator('.xfer-label')).toContainText('다운로드 중')
  await expect(xfer.locator('.xfer-cancel')).toBeVisible()
  await xfer.locator('.xfer-cancel').click()
  await expect(ara.page.locator('.sftp-xfer')).toHaveCount(0, { timeout: 20_000 })
  // 취소된 다운로드의 부분 파일은 남지 않는다.
  await expect.poll(() => existsSync(savePath), { timeout: 15_000 }).toBe(false)
})

// SFTP-6 원격 파일 조작(새 폴더 · 이름 변경 · 삭제)
test('SFTP-6 원격에서 새 폴더·이름 변경·삭제를 한다', async ({ ara, ssh }) => {
  const remote = makeRemote()
  const h = await ssh({ password: 'pw-sftp6', sftpRoot: remote })
  await openRemoteTree(ara.page, h.port, 'pw-sftp6')

  // 새 폴더
  await ara.page.click('.ftree', { button: 'right', position: { x: 10, y: 4 } })
  await ara.page.click('.ctx-menu .ctx-item[data-action="file.mkdir"]')
  await ara.page.fill('.dlg-input', '원격_새폴더')
  await dialogConfirm(ara.page)
  await expect(row(ara.page, '원격_새폴더/')).toBeVisible({ timeout: 20_000 })
  expect(existsSync(join(remote, '원격_새폴더'))).toBe(true)

  // 이름 변경
  await row(ara.page, 'README_한글.md').click()
  await row(ara.page, 'README_한글.md').click({ button: 'right' })
  await ara.page.click('.ctx-menu .ctx-item[data-action="file.rename"]')
  await ara.page.fill('.ftree .fedit', 'README_수정.md')
  await ara.page.keyboard.press('Enter')
  await expect(row(ara.page, 'README_수정.md')).toBeVisible({ timeout: 20_000 })
  expect(existsSync(join(remote, 'README_수정.md'))).toBe(true)

  // 삭제(폴더 포함 — 하위까지 지운다는 문구 확인)
  await row(ara.page, '배포스크립트/').click()
  await row(ara.page, '배포스크립트/').click({ button: 'right' })
  await ara.page.click('.ctx-menu .ctx-item[data-action="file.delete"]')
  await expect(dialog(ara.page)).toContainText('폴더와 그 안의 모든 내용을 삭제')
  await dialogConfirm(ara.page)
  await expect(row(ara.page, '배포스크립트/')).toHaveCount(0, { timeout: 25_000 })
  expect(existsSync(join(remote, '배포스크립트'))).toBe(false)
})
