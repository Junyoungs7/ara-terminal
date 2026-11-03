// P3 R2-A 터미널 3차 IPC — 셸 목록(TM-09)·Ghostty/Warp 미리 보기(TM-11). 둘 다 사람이 설정 화면을 열거나 누를 때만 돈다(상시 일 없음).
import { handle } from './ipc/handle'
import { detectShells } from './sessions/shellProfiles'
import { previewGhostty, previewWarp } from './termImport'

export function registerTermExtraIpc(): void {
  handle('term:shells', () => detectShells())
  handle('term:importPreview', ({ source }) => (source === 'warp' ? previewWarp() : previewGhostty()))
}
