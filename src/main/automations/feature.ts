// M14 R1 AU-01 예약 실행 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 저장은 userData/automations.json(atomicJson .bak).
// 예약은 앱 안의 타이머로만 본다(service.ts) — OS 작업 스케줄러·로그인 항목에 아무것도 등록하지 않는다.
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { AutomationsState } from '@shared/automations/automations-types'
import { handle } from '../ipc/handle'
import { cleanupTemp, readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import { pushSend } from '../util/windowPush'
import { runLocalPrecheck } from './precheck'
import { createAutomationService, validateAutomationInput, type AutomationService } from './service'

function stateOf(v: unknown): AutomationsState {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<AutomationsState>
  return { automations: Array.isArray(o.automations) ? o.automations : [], runs: Array.isArray(o.runs) ? o.runs : [] }
}

export function registerAutomationsFeature(deps: { userData: string; mainWc: () => WebContents | null }): AutomationService {
  const file = join(deps.userData, 'automations.json')
  cleanupTemp(file)
  const svc = createAutomationService({
    load: () => stateOf(readJsonWithBackup<unknown>(file, null)),
    save: (s) => writeJsonAtomic(file, s),
    changed: (s) => pushSend(deps.mainWc(), 'automations:changed', s),
    dispatch: (req) => {
      const wc = deps.mainWc()
      if (!wc || wc.isDestroyed()) return false
      pushSend(wc, 'automations:dispatch', req)
      return true
    },
    runPrecheck: runLocalPrecheck
  })

  handle('automations:list', () => svc.state())
  handle('automations:create', (input) => {
    const v = validateAutomationInput(input)
    return v.ok ? { ok: true, automation: svc.create(v.input) } : v
  })
  handle('automations:update', ({ id, input }) => {
    const v = validateAutomationInput(input)
    if (!v.ok) return v
    const a = svc.update(id, v.input)
    return a ? { ok: true, automation: a } : { ok: false, error: '없는 자동화입니다.' }
  })
  handle('automations:setEnabled', ({ id, enabled }) => svc.setEnabled(id, enabled === true) !== null)
  handle('automations:remove', ({ id }) => svc.remove(id))
  handle('automations:runNow', async ({ id }) => (await svc.runNow(id)) !== null)
  handle('automations:markDispatchResult', (r) => {
    svc.markDispatchResult(r)
  })
  // 본창 렌더러가 띄울 준비가 됐다(main.tsx) — 이때부터 타이머가 돈다. 창을 다시 띄우면 또 부른다(중복 타이머 없음).
  handle('automations:rendererReady', () => svc.start())
  return svc
}
