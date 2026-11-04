// M8 DM-02·03 관리형 서버 — 순수 판정(동의 상태·지원 판정·판 비교·업데이트 판정·제거 검증 목록). 원격 실증은 managedOrcad.test.ts.
import { describe, expect, it } from 'vitest'
import {
  MANAGED_DIR,
  MANAGED_MARK,
  UNINSTALL_SCRIPT,
  VERIFY_SCRIPT,
  adoptKindOf,
  consentOf,
  consentPlan,
  decideUpdate,
  hostKeyOf,
  parseProbe,
  remnantsOf,
  serverRowsOf,
  supportOf,
  versionCmp,
  type ManagedRecord
} from '../src/shared/managedServers'
import { ORCAD_PY } from '../src/main/managed/orcadScript'

const linux = 'os=Linux\narch=x86_64\nhome=/home/dev\npython=/usr/bin/python3\npyver=3.10\npymods=1\n'

describe('probe → 지원 판정', () => {
  it('Linux + python3 3.6 이상 + 모듈 = 지원', () => {
    const p = parseProbe(linux)
    expect(p).toMatchObject({ os: 'Linux', arch: 'x86_64', home: '/home/dev', pyver: '3.10', pymods: true, installed: null })
    expect(supportOf(p)).toEqual({ ok: true })
    expect(supportOf(parseProbe(linux.replace('3.10', '3.6')))).toEqual({ ok: true })
  })
  it('지원 안 함은 이유를 단다', () => {
    expect(supportOf(parseProbe(linux.replace('Linux', 'Darwin')))).toEqual({ ok: false, reason: 'os' })
    expect(supportOf(parseProbe('os=Linux\npython=\n'))).toEqual({ ok: false, reason: 'python' })
    expect(supportOf(parseProbe(linux.replace('3.10', '3.5')))).toEqual({ ok: false, reason: 'pythonOld' })
    expect(supportOf(parseProbe(linux.replace('3.10', '2.7')))).toEqual({ ok: false, reason: 'pythonOld' })
    expect(supportOf(parseProbe(linux.replace('pymods=1\n', '')))).toEqual({ ok: false, reason: 'pythonModules' })
    // 빈 출력(명령이 죽음)은 지원한다고 말하지 않는다.
    expect(supportOf(parseProbe(''))).toEqual({ ok: false, reason: 'os' })
  })
  it('설치된 판을 읽는다 · CRLF 도', () => {
    expect(parseProbe(linux.replace(/\n/g, '\r\n') + 'installed=2.11.0\r\n').installed).toBe('2.11.0')
  })
})

describe('판 비교·업데이트 판정', () => {
  it('versionCmp', () => {
    expect(versionCmp('2.11.0', '2.11.0')).toBe(0)
    expect(versionCmp('2.9.0', '2.11.0')).toBe(-1)
    expect(versionCmp('2.11.1', '2.11')).toBe(1)
    expect(versionCmp('3.0.0-beta.1', '3.0.0')).toBe(0)
  })
  it('없으면 설치, 같으면 그대로, 새 판은 낮추지 않음, 돌고 있으면 미룸, 아니면 교체', () => {
    expect(decideUpdate({ installed: null, app: '2.11.0', liveSessions: 0 })).toBe('install')
    expect(decideUpdate({ installed: '2.11.0', app: '2.11.0', liveSessions: 3 })).toBe('current')
    expect(decideUpdate({ installed: '2.12.0', app: '2.11.0', liveSessions: 0 })).toBe('keepNewer')
    expect(decideUpdate({ installed: '2.10.0', app: '2.11.0', liveSessions: 1 })).toBe('defer')
    expect(decideUpdate({ installed: '2.10.0', app: '2.11.0', liveSessions: 0 })).toBe('update')
  })
})

describe('제거 검증 목록', () => {
  it('흔적 0', () => {
    expect(remnantsOf('dir=no\nproc=0\ncron=0\nsystemd=0\n')).toEqual([])
  })
  it('남은 것을 이름으로', () => {
    expect(remnantsOf('dir=yes\nproc=2\ncron=1\nsystemd=0\n')).toEqual(['dir', 'proc:2', 'cron:1'])
  })
  it('못 잰 것은 "없다"가 아니라 unknown', () => {
    expect(remnantsOf('')).toEqual(['unknown:dir', 'unknown:proc', 'unknown:cron', 'unknown:systemd'])
    expect(remnantsOf('dir=no\nproc=\ncron=x\nsystemd=0')).toEqual(['unknown:proc', 'unknown:cron'])
  })
  it('검증·제거 명령이 설치 폴더와 표식을 본다(오타 한 글자면 0 이 거짓말이 된다)', () => {
    for (const s of [VERIFY_SCRIPT, UNINSTALL_SCRIPT]) {
      expect(s).toContain(`$HOME/${MANAGED_DIR}`)
      expect(s).toContain(`${MANAGED_MARK}=$D`)
    }
    expect(ORCAD_PY).toContain(`MARK = '${MANAGED_MARK}'`)
  })
})

describe('동의', () => {
  const rec: ManagedRecord = { hostKey: 'dev@10.0.0.5:22', consentedAt: '2026-11-01T00:00:00Z', version: '2.11.0', state: 'installed', checkedAt: '2026-11-01T00:00:00Z' }
  it('호스트·계정별', () => {
    expect(hostKeyOf({ username: 'dev', host: '10.0.0.5', port: 22 })).toBe('dev@10.0.0.5:22')
    expect(consentOf([rec], 'dev@10.0.0.5:22')).toBe('consented')
    expect(consentOf([rec], 'root@10.0.0.5:22')).toBe('none')
    expect(consentOf([], 'dev@10.0.0.5:22')).toBe('none')
  })
  it('동의 화면: 무엇을(경로·크기) · 어디에 · 상주 · 소켓 · 지우는 법', () => {
    const p = consentPlan('dev@h:22', parseProbe(linux), 12345, 64, 6)
    expect(p.dir).toBe('/home/dev/.ara-server')
    expect(p.files).toEqual([
      { path: '/home/dev/.ara-server/orcad.py', bytes: 12345 },
      { path: '/home/dev/.ara-server/token', bytes: 64 },
      { path: '/home/dev/.ara-server/version', bytes: 6 }
    ])
    expect(p.runtimeFiles.every((f) => f.startsWith(p.dir + '/'))).toBe(true)
    expect(p.socket).toBe('/home/dev/.ara-server/orcad.sock')
    expect(p.process).toContain('orcad.py serve')
    expect(p.manualRemove).toContain('rm -rf ~/.ara-server')
    expect(p.support).toEqual({ ok: true })
  })
})

describe('orcad.py 는 String.raw 안에 산다', () => {
  it('파이썬 글이 템플릿을 깨지 않았다(시작·끝이 온전)', () => {
    expect(ORCAD_PY.startsWith('#!/usr/bin/env python3\n')).toBe(true)
    expect(ORCAD_PY.trimEnd().endsWith('sys.exit(64)')).toBe(true)
    // 파이썬의 '\n' 이 진짜 줄바꿈으로 바뀌지 않았다(String.raw).
    expect(ORCAD_PY).toContain("+ '\\n').encode('utf-8')")
  })
})

// R1 다른 PC 에서 이어 보기 — 채택(이미 설치됨) 판 비교, 돌고 있나 읽기, 서버 세션 목록 줄.
describe('R1 채택·서버 세션 목록', () => {
  it('돌고 있나(소켓)를 읽는다 — 없으면 false(세려고 서버를 띄우지 않는다)', () => {
    expect(parseProbe(linux + 'running=1\ninstalled=2.2.11\n')).toMatchObject({ running: true, installed: '2.2.11' })
    expect(parseProbe(linux + 'installed=2.2.11\n').running).toBe(false)
  })
  it('채택 판 비교 — 같음·서버가 옛 판·서버가 새 판', () => {
    expect(adoptKindOf('2.2.11', '2.2.11')).toBe('same')
    expect(adoptKindOf('2.2.9', '2.2.11')).toBe('older')
    expect(adoptKindOf('2.3.0', '2.2.11')).toBe('newer')
    // 채택 뒤의 실제 처리는 decideUpdate — 옛 판 + 세션 있음 = 미룸(세션 보존), 없음 = 올림, 새 판 = 낮추지 않음.
    expect(decideUpdate({ installed: '2.2.9', app: '2.2.11', liveSessions: 2 })).toBe('defer')
    expect(decideUpdate({ installed: '2.2.9', app: '2.2.11', liveSessions: 0 })).toBe('update')
    expect(decideUpdate({ installed: '2.3.0', app: '2.2.11', liveSessions: 0 })).toBe('keepNewer')
  })
  it('채택 화면 내용에 이 PC 판·세션 수가 실린다', () => {
    const plan = consentPlan('dev@h:22', parseProbe(linux + 'installed=2.2.9\n'), 100, 64, 6, { app: '2.2.11', sessions: 3 })
    expect(plan).toMatchObject({ app: '2.2.11', sessions: 3, dir: '/home/dev/.ara-server' })
  })
  it('서버 list → 목록 줄: 제목 순서(이름 > 첫 지시 제목 > 실행 제목), 만든 PC, 보는 PC, 이 PC 에 열림, 최근 시작이 위', () => {
    const rows = serverRowsOf(
      'dev@h:22',
      [
        { id: 'a', cwd: '/w/a', meta: { agent: 'claude', title: 'Claude · a', pc: 'OFFICE', startedAt: 100 }, viewers: ['OFFICE'] },
        { id: 'b', cwd: '/w/b', meta: { agent: 'codex', title: 'Codex · b', genTitle: '쿠폰 반올림', startedAt: 300 }, viewers: [] },
        { id: 'c', cwd: '/w/c', meta: { title: 'x', genTitle: 'g', name: '정산 CSV', startedAt: 200 } }
      ],
      (id) => id === 'a'
    )
    expect(rows.map((r) => [r.id, r.title])).toEqual([
      ['b', '쿠폰 반올림'],
      ['c', '정산 CSV'],
      ['a', 'Claude · a']
    ])
    expect(rows[2]).toMatchObject({ hostKey: 'dev@h:22', agent: 'claude', pc: 'OFFICE', viewers: ['OFFICE'], here: true })
    expect(rows[0]).toMatchObject({ pc: null, viewers: [], here: false })
    expect(rows[1].viewers).toEqual([]) // 옛 서버(viewers 없음)
  })
  it('orcad 가 R1 요청(detach·meta)과 viewers 사건을 안다', () => {
    expect(ORCAD_PY).toContain("if t == 'detach':")
    expect(ORCAD_PY).toContain("if t == 'meta':")
    expect(ORCAD_PY).toContain("'type': 'viewers'")
  })
})
