// p3-M21 [내 그림 올리기] — 설정 › 펫과 펫 자리(그림이 없을 때)가 같은 길. 실패는 알림 한 줄(Orca pet-import-failure-text).
import type { PetPrefs } from '@shared/pet'
import { pushNote } from '../../store/notify'
import { t } from '../../i18n'

export async function importPet(pet: PetPrefs, onChange: (p: PetPrefs) => void): Promise<void> {
  const r = await window.ev.pet.import().catch(() => ({ ok: false, error: 'read' }) as const)
  if (!r) return
  if (r.ok) onChange({ ...pet, enabled: true, image: r.image })
  else pushNote({ kind: 'error', space: 'term', title: t('pet.import.failed'), body: t('pet.import.err.' + r.error) })
}
