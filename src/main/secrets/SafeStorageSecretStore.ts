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

  private flush(): void {
    writeJsonAtomic(this.vaultPath, this.vault)
  }
}
