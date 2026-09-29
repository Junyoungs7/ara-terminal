// R15 RDP 파일 클립보드 — 원격→로컬 자동 받기와 되먹임 고리.
//
// 여기가 왜 중요한가: 원격에서 받은 파일을 로컬 클립보드에 올리면, 다음 포커스·Ctrl+V 가 그걸 "로컬에서
// 새로 복사한 파일"로 보고 원격에 **도로 알린다**(되먹임). 자동이 된 뒤로는 원격 안에서 Ctrl+C 만 해도
// 이 고리가 돈다. 🔴 실제 클립보드를 건드리지 않는다 — 판정은 전부 순수 함수다.
import { describe, it, expect } from 'vitest'
import {
  RDP_AUTO_RECV_MAX,
  afterRemoteCopy,
  autoReceivePlan,
  clipboardSignature,
  ownFilesSig,
  shouldAnnounceClipboard,
  shouldUploadPasted
} from '../src/renderer/components/rdpInput'

// clipPut 이 돌려주는 모양(임시 폴더의 경로들).
const PUT = ['C:\\Users\\u\\AppData\\Roaming\\ara\\rdp-clip\\ab12\\사진.png', 'C:\\Users\\u\\AppData\\Roaming\\ara\\rdp-clip\\ab12\\b.txt']
const OLD_LOCAL = ['D:\\work\\처음 복사한 그림.png']
const idle = { locked: null, fromRemote: null, receiving: false, uploading: false }

describe('자동 받기 판정(autoReceivePlan)', () => {
  it('상한과 같으면 자동, 1바이트라도 넘으면 수동', () => {
    expect(autoReceivePlan([{ size: RDP_AUTO_RECV_MAX }])).toBe('auto')
    expect(autoReceivePlan([{ size: RDP_AUTO_RECV_MAX - 1 }, { size: 1 }])).toBe('auto')
    expect(autoReceivePlan([{ size: RDP_AUTO_RECV_MAX }, { size: 1 }])).toBe('tooBig')
  })
  it('상한은 100MB 다(로컬→원격 LOCAL_TO_REMOTE_MAX 와 같은 값)', () => {
    expect(RDP_AUTO_RECV_MAX).toBe(100 * 1024 * 1024)
  })
  it('폴더가 하나라도 섞이면 통째로 수동 — 폴더 항목이든 폴더 안 파일이든', () => {
    expect(autoReceivePlan([{ size: 1 }, { size: 0, isDirectory: true }])).toBe('folder')
    expect(autoReceivePlan([{ size: 1 }, { size: 1, path: 'docs' }])).toBe('folder')
  })
  it('폴더가 크기보다 먼저다 — 큰 폴더는 [폴더에 저장] 으로 안내한다', () => {
    expect(autoReceivePlan([{ size: RDP_AUTO_RECV_MAX + 1 }, { size: 0, isDirectory: true }])).toBe('folder')
  })
  it('빈 목록은 아무것도 안 한다', () => {
    expect(autoReceivePlan([])).toBe('none')
  })
})

describe('되먹임 — 포커스 동기화', () => {
  // syncClipboardToRemote 는 Electron 의 싼 검사로 **첫 경로 하나**를 읽어 지문을 만든다.
  const focusSig = (paths: string[]): string | null => clipboardSignature({ paths: paths.slice(0, 1) })

  it('우리가 올린 파일은 포커스 때 원격에 되돌아가지 않는다', () => {
    const fromRemote = ownFilesSig(PUT)
    expect(shouldAnnounceClipboard(focusSig(PUT), null, fromRemote)).toBe(false)
  })
  it('그 뒤 로컬에서 새로 복사하면 알린다(고리를 막느라 정상 흐름을 막지 않는다)', () => {
    expect(shouldAnnounceClipboard(focusSig(OLD_LOCAL), null, ownFilesSig(PUT))).toBe(true)
  })
  it('받는 중에는 옛 로컬 파일을 알리지 않는다 — 원격의 복사를 빼앗는다', () => {
    expect(shouldAnnounceClipboard(focusSig(OLD_LOCAL), null, null, true)).toBe(false)
    expect(shouldAnnounceClipboard(focusSig(OLD_LOCAL), null, null, false)).toBe(true)
  })
})

describe('되먹임 — 캔버스 Ctrl+V 의 paste 이벤트(shouldUploadPasted)', () => {
  it('우리가 올린 파일이면 알리지 않는다(원격 안에서 붙여넣을 때 이 이벤트가 로컬에서도 난다)', () => {
    expect(shouldUploadPasted(PUT, { ...idle, fromRemote: ownFilesSig(PUT) })).toBe(false)
  })
  it('받는 중이면 알리지 않는다', () => {
    expect(shouldUploadPasted(OLD_LOCAL, { ...idle, receiving: true })).toBe(false)
  })
  it('알린 묶음을 원격이 가져가는 중이면 알리지 않는다 — 다시 알리면 전송이 supersede 로 끊긴다', () => {
    expect(shouldUploadPasted(OLD_LOCAL, { ...idle, uploading: true })).toBe(false)
  })
  it('이미 알린 묶음은 순서가 달라도 다시 알리지 않는다', () => {
    const locked = clipboardSignature({ paths: ['a', 'b'] })
    expect(shouldUploadPasted(['b', 'a'], { ...idle, locked })).toBe(false)
  })
  it('새 로컬 파일이면 알린다', () => {
    expect(shouldUploadPasted(OLD_LOCAL, { ...idle, fromRemote: ownFilesSig(PUT) })).toBe(true)
  })
  it('경로 없는 항목(캡처 도구의 비트맵)은 막지 않는다 — fromRemote 가 비었을 때 null === null 로 걸리면 안 된다', () => {
    expect(shouldUploadPasted([], idle)).toBe(true)
  })
})

describe('원격 복사 뒤 옛 로컬 파일이 원격 복사를 빼앗지 않는다(afterRemoteCopy)', () => {
  // 자동으로 못 받은 경우(상한 초과·폴더·실패) — 로컬 클립보드엔 옛 로컬 파일이 그대로 있다.
  const oldSig = clipboardSignature({ paths: OLD_LOCAL })
  const rec = afterRemoteCopy(oldSig)

  it('포커스를 여러 번 오가도 옛 로컬 파일을 다시 알리지 않는다', () => {
    for (let i = 0; i < 3; i++) expect(shouldAnnounceClipboard(oldSig, rec.announced, null)).toBe(false)
  })
  it('원격 안에서 Ctrl+V 해도(paste 이벤트) 옛 로컬 파일을 끼워 넣지 않는다', () => {
    expect(shouldUploadPasted(OLD_LOCAL, { ...idle, seen: rec.seen })).toBe(false)
  })
  it('양성 대조 — 로컬에서 새로 복사하면 포커스·paste 모두 알린다', () => {
    const NEW = ['D:\\work\\새로 복사.png']
    expect(shouldAnnounceClipboard(clipboardSignature({ paths: NEW }), rec.announced, null)).toBe(true)
    expect(shouldUploadPasted(NEW, { ...idle, seen: rec.seen })).toBe(true)
  })
  it('로컬이 텍스트였어도 같다 — 새 텍스트를 복사해야 알린다', () => {
    const t = afterRemoteCopy(clipboardSignature({ text: '옛 글' }))
    expect(shouldAnnounceClipboard(clipboardSignature({ text: '옛 글' }), t.announced, null)).toBe(false)
    expect(shouldAnnounceClipboard(clipboardSignature({ text: '새 글' }), t.announced, null)).toBe(true)
  })
})
