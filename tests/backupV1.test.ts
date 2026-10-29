// 2.0 첫 실행 백업(src/main/workspace/backupV1.ts) — 임시 폴더를 userData 로 쓴다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupV1Data, V1_BACKUP_MARK } from '../src/main/workspace/backupV1'

let ud: string
const errs: unknown[] = []
const onError = (e: unknown): void => void errs.push(e)
const NOW = new Date(2026, 9, 29, 9, 5, 7)
const backups = (): string[] => readdirSync(ud).filter((n) => n.startsWith('backup-1.x-'))

beforeEach(() => {
  ud = mkdtempSync(join(tmpdir(), 'ara-bk-'))
  errs.length = 0
})
afterEach(() => rmSync(ud, { recursive: true, force: true }))

describe('backupV1Data', () => {
  it('1.x 데이터 파일만 복사하고 원본은 그대로, 폴더·모르는 파일은 안 뜬다', () => {
    for (const f of ['workspace.json', 'workspace.json.bak', 'secrets.vault', 'device-id', 'history.json']) writeFileSync(join(ud, f), f)
    writeFileSync(join(ud, 'Local State'), 'chromium')
    mkdirSync(join(ud, 'logs'))
    writeFileSync(join(ud, 'logs', 'x.log'), 'big')

    const dir = backupV1Data(ud, onError, NOW)
    expect(dir).toBe(join(ud, 'backup-1.x-20261029-090507'))
    expect(readdirSync(dir!).sort()).toEqual(['device-id', 'history.json', 'secrets.vault', 'workspace.json', 'workspace.json.bak'])
    expect(readFileSync(join(dir!, 'secrets.vault'), 'utf8')).toBe('secrets.vault')
    expect(existsSync(join(ud, 'workspace.json'))).toBe(true) // 이동 아님
    expect(existsSync(join(ud, V1_BACKUP_MARK))).toBe(true)
    expect(errs).toEqual([])
  })

  it('두 번째 실행은 아무것도 안 한다', () => {
    writeFileSync(join(ud, 'workspace.json'), '{}')
    expect(backupV1Data(ud, onError, NOW)).not.toBeNull()
    expect(backupV1Data(ud, onError, new Date(2026, 9, 30))).toBeNull()
    expect(backups()).toHaveLength(1)
  })

  it('새 설치(1.x 데이터 없음)는 뜨지 않고, 다음 실행에 2.0 파일을 1.x 로 착각하지 않는다', () => {
    expect(backupV1Data(ud, onError, NOW)).toBeNull()
    writeFileSync(join(ud, 'workspace.json'), '{}') // 2.0 이 만든 것
    expect(backupV1Data(ud, onError, NOW)).toBeNull()
    expect(backups()).toEqual([])
    expect(errs).toEqual([])
  })

  it('vault 만 있어도 1.x 로 본다', () => {
    writeFileSync(join(ud, 'secrets.vault'), 'v')
    expect(backupV1Data(ud, onError, NOW)).not.toBeNull()
  })

  it('실패는 던지지 않고 onError 로만 — 표식도 안 남긴다', () => {
    writeFileSync(join(ud, 'workspace.json'), '{}')
    writeFileSync(join(ud, 'backup-1.x-20261029-090507'), 'file blocks mkdir')
    expect(backupV1Data(ud, onError, NOW)).toBeNull()
    expect(errs).toHaveLength(1)
    expect(existsSync(join(ud, V1_BACKUP_MARK))).toBe(false)
  })
})
