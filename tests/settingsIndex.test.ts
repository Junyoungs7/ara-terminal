import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS_GROUPS, SETTINGS_INDEX, SETTINGS_SECTIONS, searchSettings, sectionOfItem } from '../src/shared/settingsIndex'

// M1 1-A 설정 검색 색인 — 설정 페이지 목록·검색·딥링크가 이 표 하나를 읽는다.
const ko = JSON.parse(readFileSync(join(__dirname, '../src/renderer/i18n/ko.json'), 'utf8')) as Record<string, string>
const tr = (k: string): string => ko[k] ?? k

describe('설정 색인', () => {
  it('묶음 순서: AI 작업 공간 → 앱 → 전역 → 터미널 → 보안·연동 → 고급 → 정보, 묶음은 이어져 있다', () => {
    const seen: string[] = []
    for (const d of SETTINGS_INDEX) if (seen[seen.length - 1] !== d.group) seen.push(d.group)
    expect(seen).toEqual([...SETTINGS_GROUPS])
    expect(SETTINGS_GROUPS.map((g) => tr(`settings.group.${g}`))).toEqual(['AI 작업 공간', '앱', '전역 (아라)', '터미널', '보안·연동', '고급', '정보'])
  })

  it('섹션 목록 = SETTINGS_SECTIONS 순서 그대로, 중복 없음', () => {
    expect(SETTINGS_INDEX.map((d) => d.id)).toEqual([...SETTINGS_SECTIONS])
  })

  it('모든 라벨·설명 키가 ko.json 에 있다(없으면 화면·검색에 키 문자열이 나간다)', () => {
    const keys = SETTINGS_INDEX.flatMap((d) => [
      `settings.nav.${d.id}`,
      ...d.items.flatMap((x) => [x.label, ...(x.desc ? [x.desc] : [])])
    ])
    expect(keys.filter((k) => !(k in ko))).toEqual([])
  })

  it('항목 id 는 전체에서 하나뿐이다(딥링크가 항목 id 로 섹션을 찾는다)', () => {
    const ids = SETTINGS_INDEX.flatMap((d) => d.items.map((x) => x.id))
    expect(ids.length).toBe(new Set(ids).size)
    expect(sectionOfItem('ai.key')).toBe('ai')
    expect(sectionOfItem('ai.cliFlags')).toBe('agents')
    expect(sectionOfItem('probe')).toBe('advanced')
    expect(sectionOfItem('sec.mcp')).toBe('mcp')
  })

  it('대응표 4-3 의 옮긴 자리', () => {
    expect(sectionOfItem('copyOnSelect')).toBe('terminal')
    expect(sectionOfItem('scrollback')).toBe('terminal')
    expect(sectionOfItem('update')).toBe('update')
    expect(sectionOfItem('dir.app')).toBe('advanced')
    expect(sectionOfItem('gpu')).toBe('advanced')
    expect(sectionOfItem('dir.session')).toBe('log')
  })
})

describe('searchSettings', () => {
  it('빈 검색어 = 빈 결과', () => {
    expect(searchSettings('  ', tr)).toEqual([])
  })

  it('항목 라벨로 걸러 그 항목만 남긴다', () => {
    const r = searchSettings('스크롤백', tr)
    expect(r.map((h) => h.section.id)).toEqual(['terminal'])
    expect(r[0].items.map((x) => x.id)).toEqual(['scrollback'])
  })

  it('설명에만 있는 낱말도 찾는다(대소문자 무시)', () => {
    const r = searchSettings('NDJSON', tr)
    expect(r.flatMap((h) => h.items.map((x) => x.id))).toContain('probe')
  })

  it('섹션 이름이 맞으면 그 섹션 항목 전부', () => {
    const r = searchSettings('세션 로그', tr)
    const log = r.find((h) => h.section.id === 'log')
    expect(log?.items.length).toBe(SETTINGS_INDEX.find((d) => d.id === 'log')?.items.length)
  })

  it('결과는 묶음 순서다', () => {
    const order = SETTINGS_SECTIONS as readonly string[]
    const ids = searchSettings('키', tr).map((h) => h.section.id)
    expect(ids.length).toBeGreaterThan(1)
    expect([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(ids)
  })

  it('없는 낱말 = 빈 결과', () => {
    expect(searchSettings('없는낱말zzz', tr)).toEqual([])
  })
})
