import { describe, it, expect } from 'vitest'
import { buildBootstrapPrompt, BOOTSTRAP_FIELD_MAX, type BootstrapForm } from '../src/renderer/components/aiBootstrap'

const form = (patch: Partial<BootstrapForm> = {}): BootstrapForm => ({
  kind: 'web',
  runtime: 'Node.js',
  target: 'local',
  name: 'my-app',
  path: '/srv/app',
  ...patch
})

describe('buildBootstrapPrompt — 순수 함수', () => {
  it('종류·런타임·대상·이름·경로를 모두 담는다', () => {
    const p = buildBootstrapPrompt(form())
    expect(p).toContain('웹 프로젝트')
    expect(p).toContain('Node.js')
    expect(p).toContain('로컬 PC')
    expect(p).toContain('my-app')
    expect(p).toContain('/srv/app')
  })

  it('대상이 ssh 면 그 사실을 밝힌다(호스트명은 없다 — 폼에 그 필드가 없다)', () => {
    const p = buildBootstrapPrompt(form({ target: 'ssh' }))
    expect(p).toContain('현재 접속한 SSH 서버')
    expect(p).not.toContain('로컬 PC')
  })

  it('경로가 비면 그 줄을 싣지 않는다', () => {
    const p = buildBootstrapPrompt(form({ path: '' }))
    expect(p).not.toContain('경로:')
  })

  it('빈 런타임·이름은 "미지정"으로 표시한다', () => {
    const p = buildBootstrapPrompt(form({ runtime: '', name: '   ' }))
    expect(p).toContain('언어/런타임: 미지정')
    expect(p).toContain('프로젝트 이름: 미지정')
  })

  it('자유 입력 필드에 섞인 비밀은 마스킹된다', () => {
    const p = buildBootstrapPrompt(form({ path: '/srv/app?token=abc123&PASSWORD=hunter2' }))
    expect(p).not.toContain('hunter2')
    expect(p).toContain('****')
  })

  it('필드 길이가 상한을 넘으면 잘린다', () => {
    const long = 'x'.repeat(BOOTSTRAP_FIELD_MAX + 500)
    const p = buildBootstrapPrompt(form({ name: long }))
    const line = p.split('\n').find((l) => l.startsWith('- 프로젝트 이름:'))!
    expect(line.length).toBeLessThanOrEqual(BOOTSTRAP_FIELD_MAX + '- 프로젝트 이름: '.length)
  })

  it('CLI·스크립트 종류 라벨도 각각 반영한다', () => {
    expect(buildBootstrapPrompt(form({ kind: 'cli' }))).toContain('CLI 도구')
    expect(buildBootstrapPrompt(form({ kind: 'script' }))).toContain('스크립트')
  })
})
