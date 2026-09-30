// R14 탐색기 주소창 `아라` — 어느 작업 폴더에서 셸을 열고, 언제 여나(src/main/windows/openHere.ts).
//
// ⚠️ 이 시험은 설치본을 안 깐다. App Paths 가 실제로 걸리고 탐색기가 그 폴더를 작업 폴더로 주는지는
//    실기 확인이다. 여기서 무는 것은 "아이콘을 누를 때마다 셸이 쌓이는" 사고와 부팅 순서다.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenHere, folderToOpen } from '../src/main/windows/openHere'

// 실제로 있는 폴더가 필요하다 — 이 저장소의 tests 폴더를 쓴다(임시 폴더는 tmpDir 규칙에 걸린다).
const here = __dirname
const exeDir = join(dirname(here), 'fake-install')

describe('folderToOpen — 어느 폴더에서 셸을 여나', () => {
  it('있는 절대경로 폴더면 연다', () => {
    expect(folderToOpen(here, { exeDir })).toBe(here)
  })

  it('★ 설치 폴더(바로가기의 작업 폴더)는 안 연다 — 대소문자가 달라도', () => {
    expect(folderToOpen(here, { exeDir: here })).toBeNull()
    expect(folderToOpen(here.toUpperCase(), { exeDir: here.toLowerCase() })).toBeNull()
  })

  it('Windows 폴더·임시 폴더 아래는 안 연다', () => {
    expect(folderToOpen(here, { exeDir, winDir: dirname(here) })).toBeNull()
    expect(folderToOpen(here, { exeDir, tmpDir: here })).toBeNull()
    // 이름만 비슷한 옆 폴더는 "아래"가 아니다
    expect(folderToOpen(here, { exeDir, winDir: here + '2' })).toBe(here)
  })

  it('상대경로·빈 값·없는 폴더·파일은 안 연다', () => {
    expect(folderToOpen('tests', { exeDir })).toBeNull()
    expect(folderToOpen(undefined, { exeDir })).toBeNull()
    expect(folderToOpen('', { exeDir })).toBeNull()
    expect(folderToOpen(join(here, '없는-폴더-r14'), { exeDir })).toBeNull()
    const tmp = mkdtempSync(join(tmpdir(), 'r14-'))
    const file = join(tmp, 'f.txt')
    writeFileSync(file, 'x')
    try {
      expect(folderToOpen(file, { exeDir })).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('createOpenHere — 언제 여나', () => {
  it('★ 복원 전에 온 폴더는 들고 있다가 ready 에서 한 번만 연다', () => {
    const opened: string[] = []
    const o = createOpenHere((d) => opened.push(d))
    o.arrive('C:\\a')
    expect(opened).toEqual([])
    expect(o.ready()).toBe(true)
    expect(opened).toEqual(['C:\\a'])
    // 본창이 다시 복원을 알려도(재마운트) 또 열지 않는다
    expect(o.ready()).toBe(false)
    expect(opened).toEqual(['C:\\a'])
  })

  it('ready 뒤에 온 폴더(second-instance)는 바로 연다 · null 은 무시', () => {
    const opened: string[] = []
    const o = createOpenHere((d) => opened.push(d))
    o.arrive(null)
    expect(o.ready()).toBe(false)
    o.arrive('C:\\b')
    o.arrive(null)
    expect(opened).toEqual(['C:\\b'])
  })
})

describe('배선 — 설치 스크립트와 second-instance', () => {
  const read = (p: string): string => readFileSync(join(dirname(here), p), 'utf8')

  it('★ installer.nsh 가 두 이름을 걸고 **같은 두 이름을** 지운다 · BOM 이 있다', () => {
    const nsh = read('resources/installer.nsh')
    expect(nsh.charCodeAt(0)).toBe(0xfeff)
    for (const name of ['아라.exe', 'ara.exe']) {
      expect(nsh).toContain('WriteRegStr SHELL_CONTEXT "${ARA_APP_PATHS}\\' + name + '"')
      expect(nsh).toContain('DeleteRegKey SHELL_CONTEXT "${ARA_APP_PATHS}\\' + name + '"')
    }
    // Path 값을 걸면 설치 폴더가 아라가 여는 모든 셸의 PATH 에 붙는다(머리주석)
    expect(nsh).not.toMatch(/"Path"/)
    expect(read('electron-builder.yml')).toMatch(/include: resources\/installer\.nsh/)
  })

  // 신고 #4·#5: 주소창은 App Paths 보다 **바탕화면 항목**을 먼저 본다. 바로가기 이름이 App Paths 이름과
  // 같으면(대소문자 무관) 바로가기가 설치 폴더를 작업 폴더로 띄워 셸이 안 열린다.
  const clashes = (yml: string): boolean => {
    const name = (yml.match(/^\s*shortcutName:\s*(.+?)\s*$/m)?.[1] ?? yml.match(/^productName:\s*(.+?)\s*$/m)?.[1] ?? '').toLowerCase()
    return ['ara', '아라'].includes(name)
  }
  it('★ 바탕화면 바로가기 이름이 `ara`·`아라` 와 겹치지 않는다', () => {
    const yml = read('electron-builder.yml')
    expect(clashes(yml)).toBe(false)
    expect(clashes(yml.replace(/^\s*shortcutName:.*$/m, ''))).toBe(true) // 빼면 productName ARA 로 돌아가 문다
    expect(clashes(yml.replace(/shortcutName:.*$/m, 'shortcutName: ARA'))).toBe(true)
  })

  it('second-instance 가 workingDirectory 를 검증해서 본창일 때만 넘긴다 · 잠금은 그대로', () => {
    const main = read('src/main/index.ts')
    expect(main).toMatch(/app\.on\('second-instance', \(_e, _argv, workingDirectory\)/)
    expect(main).toMatch(/if \(win === mainWindow\) openHere\?\.arrive\(folderToOpen\(workingDirectory, skip\)\)/)
    expect(main).toMatch(/primary = app\.requestSingleInstanceLock\(\)/)
  })
})
