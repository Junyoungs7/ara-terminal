// p3-M21 펫 — Orca main/ipc/pet.ts(pet:import — 고른 그림을 userData 로 복사, pet-image-formats.ts·pet-import-size-limits.ts)의 아라판.
// 사람이 [내 그림 올리기]를 눌렀을 때만 파일 고르기 창이 뜬다. 그림은 userData/pet/pet.<ext> 하나로만 둔다(이름은 main 이 정한다 —
// 렌더러가 주는 이름은 isPetImageName 을 통과한 고정 꼴뿐이라 경로 밖을 못 읽는다).
// 뺀 것: 스프라이트 묶음(pet.json)·여러 펫 목록·심볼릭 링크 안전 복사(파일 하나를 읽어 쓰기만 한다).
import { app, BrowserWindow, dialog } from 'electron'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { handle } from '../ipc/handle'
import { isPetImageName, PET_IMAGE_TYPES, PET_MAX_BYTES } from '@shared/pet'

const petDir = (): string => join(app.getPath('userData'), 'pet')

export function registerPetFeature(): void {
  handle('pet:import', async (_req, e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'Image', extensions: Object.keys(PET_IMAGE_TYPES) }] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    const src = r.filePaths[0]
    const ext = extname(src).slice(1).toLowerCase()
    if (!(ext in PET_IMAGE_TYPES)) return { ok: false, error: 'type' }
    try {
      const st = await stat(src)
      if (!st.isFile()) return { ok: false, error: 'read' }
      if (st.size > PET_MAX_BYTES) return { ok: false, error: 'size' }
      const bytes = await readFile(src)
      await mkdir(petDir(), { recursive: true })
      // 옛 그림(다른 확장자)은 지운다 — 하나만 둔다.
      for (const f of await readdir(petDir())) if (isPetImageName(f)) await rm(join(petDir(), f), { force: true })
      const image = `pet.${ext}`
      await writeFile(join(petDir(), image), bytes)
      return { ok: true, image }
    } catch {
      return { ok: false, error: 'read' }
    }
  })
  handle('pet:image', async ({ image }) => {
    if (!isPetImageName(image)) return null
    try {
      const bytes = await readFile(join(petDir(), image))
      return `data:${PET_IMAGE_TYPES[image.slice(4)]};base64,${bytes.toString('base64')}`
    } catch {
      return null
    }
  })
}
