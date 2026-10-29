// SafeStorageSecretStore — SecretStore의 첫 구현체 (계획서 §B.4).
// safeStorage(Win=DPAPI/mac=Keychain)로 값을 암호화해 userData/secrets.vault(base64 map)에 저장.
// isEncryptionAvailable()===false면 저장 거부(평문 폴백 금지). vault 쓰기는 atomic + .bak 복구.
import { safeStorage } from 'electron'
import type { SecretStore } from './SecretStore'
import { writeJsonAtomic, readJsonWithBackup, cleanupTemp } from '../util/atomicJson'

type Vault = Record<string, string> // key → base64(encryptString 결과)

export class SafeStorageSecretStore implements SecretStore {
  private vault: Vault

  constructor(private readonly vaultPath: string) {
    cleanupTemp(vaultPath)
    this.vault = readJsonWithBackup<Vault>(vaultPath, {})
  }

  get(key: string): string | null {
    const enc = this.vault[key]
    if (enc === undefined) return null
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }

  set(key: string, value: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage 암호화를 사용할 수 없습니다 — 평문 저장은 금지됩니다.')
    }
    this.vault[key] = safeStorage.encryptString(value).toString('base64')
    this.flush()
  }

  delete(key: string): void {
    if (key in this.vault) {
      delete this.vault[key]
      this.flush()
    }
  }

  has(key: string): boolean {
    return key in this.vault
  }

  keys(): string[] {
    return Object.keys(this.vault)
  }

  /**
   * 앱 잠금(2.0)의 일괄 바꾸기 — 켜기·끄기·분실 초기화. 값 null = 지운다.
   *
   * **전부 아니면 아무것도**: 새 맵을 따로 만들어 파일에 쓴 **뒤에야** 메모리를 바꾼다. 암호화가 중간에
   * 던지면 디스크·메모리 둘 다 그대로다(writeJsonAtomic = temp+rename).
   * **두 번 쓴다**: writeJsonAtomic 은 옛 파일을 `.bak` 으로 밀어 두는데, 잠금을 켠 직후의 `.bak` 은
   * safeStorage 만 걸린 옛 값이다 — 그대로 두면 잠금이 파일 하나만큼 헛것이 된다. 한 번 더 쓰면 `.bak` 도 새 값이다.
   */
  setMany(next: Record<string, string | null>): void {
    const entries = Object.entries(next)
    if (entries.some(([, v]) => v !== null) && !safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage 암호화를 사용할 수 없습니다 — 평문 저장은 금지됩니다.')
    }
    const vault: Vault = { ...this.vault }
    for (const [k, v] of entries) {
      if (v === null) delete vault[k]
      else vault[k] = safeStorage.encryptString(v).toString('base64')
    }
    writeJsonAtomic(this.vaultPath, vault)
    this.vault = vault
    writeJsonAtomic(this.vaultPath, vault)
  }

  private flush(): void {
    writeJsonAtomic(this.vaultPath, this.vault)
  }
}
