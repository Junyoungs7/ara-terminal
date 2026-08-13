// profile 도메인 IPC 핸들러 (계획서 §B.2/§C F3). 비밀은 vault로, workspace.json엔 secretRef만.
import { handle } from './handle'
import type { ProfileStore } from '../secrets/ProfileStore'

export function registerProfileIpc(profiles: ProfileStore): void {
  handle('profile:list', () => profiles.list())
  handle('profile:save', (input) => ({ profile: profiles.save(input) }))
  handle('profile:delete', ({ id }) => {
    profiles.delete(id)
    return { ok: true } as const
  })
}
