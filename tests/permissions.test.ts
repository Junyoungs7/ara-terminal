import { describe, expect, it } from 'vitest'
import { allowPermission } from '../src/main/permissions'

const app = (u: string): boolean => u.startsWith('file:')

describe('allowPermission — 마이크(오디오만)·아라 화면 알림만', () => {
  it('아라 본 화면의 알림은 허용(창을 내려도 승인·완료 알림)', () => {
    expect(allowPermission({ permission: 'notifications', isMainFrame: true, requestingUrl: 'file:///C:/A/resources/app.asar/out/renderer/index.html' }, app)).toBe(true)
  })
  it('미리보기·iframe·바깥 주소의 알림은 거절', () => {
    expect(allowPermission({ permission: 'notifications', isMainFrame: false, requestingUrl: 'file:///x/index.html' }, app)).toBe(false)
    expect(allowPermission({ permission: 'notifications', isMainFrame: true, requestingUrl: 'ara-doc://doc/a.html' }, app)).toBe(false)
    expect(allowPermission({ permission: 'notifications', isMainFrame: true }, app)).toBe(false)
  })
  it('마이크는 오디오만, 그 밖은 전부 거절', () => {
    expect(allowPermission({ permission: 'media', mediaTypes: ['audio'] }, app)).toBe(true)
    expect(allowPermission({ permission: 'media', mediaTypes: ['audio', 'video'] }, app)).toBe(false)
    expect(allowPermission({ permission: 'media', mediaTypes: [] }, app)).toBe(false)
    for (const p of ['geolocation', 'clipboard-read', 'display-capture', 'midi']) expect(allowPermission({ permission: p, isMainFrame: true, requestingUrl: 'file:///x' }, app)).toBe(false)
  })
})
