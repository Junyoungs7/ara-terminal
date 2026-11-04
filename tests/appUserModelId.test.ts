// Windows 토스트는 AUMID 가 바로가기(electron-builder appId)와 같아야 뜬다 — 둘이 어긋나면 알림이 조용히 사라진다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('main 의 setAppUserModelId 값 = electron-builder.yml appId', () => {
  const root = join(__dirname, '..')
  const appId = /^appId:\s*(\S+)/m.exec(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))?.[1]
  const main = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')
  expect(appId).toBeTruthy()
  expect(main).toMatch(/app\.setAppUserModelId\(ARA_APP_ID\)/)
  expect(main).toContain(`ARA_APP_ID = '${appId}'`)
})

// 같은 tag 로 두 번째 알림이 오면 Windows 는 renotify 없이는 토스트를 안 띄운다(2.2.12 실측: 첫 알림만 뜨고 목록만 바뀜).
it('에이전트 OS 알림은 renotify 를 켠다', () => {
  const src = readFileSync(join(__dirname, '..', 'src/renderer/features/aiws/agentStore.ts'), 'utf8')
  expect(src).toMatch(/tag: `ara-agent-\$\{sessionId\}-\$\{kind\}`, renotify: true/)
})
