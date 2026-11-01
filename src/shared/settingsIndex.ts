import { FEATURES } from './features'

/**
 * 설정 검색 색인 — 묶음 · 섹션 · 항목을 **한 곳**에 적는다(M1 1-A, menu-settings-done 3-4·4-3).
 *
 * 설정 페이지의 왼쪽 목록·검색과 딥링크(`openSettings(section, item)`)가 이 표를 읽는다. 명령 팔레트가
 * 설정 항목을 찾게 될 때도 이 표를 그대로 쓴다(그래서 renderer 가 아니라 shared 에 있다).
 * 문자열은 i18n 키로만 적는다 — 번역은 부르는 쪽이 `tr` 로 넘긴다(shared 는 i18n 을 모른다).
 *
 * 항목 id 는 화면의 `data-item` 과 같다. 딥링크가 그 줄로 스크롤하고 잠깐 밝힌다.
 * 섹션 이름 = `settings.nav.<id>`, 묶음 이름 = `settings.group.<group>`.
 */
export const SETTINGS_GROUPS = ['aiws', 'app', 'global', 'terminal', 'security', 'advanced', 'about'] as const
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

export const SETTINGS_SECTIONS = [
  'agents', 'usage', 'git', 'editor', 'sessionSearch', 'notify', 'browser', 'automations',
  'general', 'look', 'pet', 'font', 'keys', 'update',
  'ai', 'voice',
  'terminal', 'conn', 'features', 'log', 'history',
  'security', 'mcp', 'remote', 'mobile', 'slack', 'privacy',
  'advanced',
  'about'
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** label·desc 는 i18n 키. */
export type SettingsItem = { id: string; label: string; desc?: string }
/** soon = 아직 기능이 없는 이식 예정 섹션("곧 들어옵니다" 자리만). */
export type SettingsSectionDef = { id: SettingsSection; group: SettingsGroup; soon?: true; items: SettingsItem[] }

const i = (id: string, label: string, desc?: string): SettingsItem => ({ id, label, desc })
/** 라벨·설명 키가 `settings.<id>` · `settings.<id>.desc` 인 흔한 모양. */
const s = (id: string): SettingsItem => i(id, `settings.${id}`, `settings.${id}.desc`)
const soon = (id: SettingsSection, group: SettingsGroup): SettingsSectionDef => ({ id, group, soon: true, items: [] })

export const SETTINGS_INDEX: SettingsSectionDef[] = [
  {
    id: 'agents',
    group: 'aiws',
    items: [
      // M3 에이전트(features/aiws/AgentSettingsPanel.tsx)
      i('agents.detect', 'settings.agents.detect', 'settings.agents.redetect.desc'),
      i('agents.default', 'settings.agents.default'),
      i('agents.rc', 'settings.agents.rc', 'settings.agents.rc.desc'),
      i('agents.naming', 'settings.agents.naming', 'settings.agents.naming.desc'),
      i('agents.chatPermission', 'settings.agents.chatPermission', 'settings.agents.chatPermission.desc'),
      i('agents.lowPriority', 'settings.agents.lowPriority', 'settings.agents.lowPriority.desc'),
      i('agents.memoryCap', 'settings.agents.memoryCap', 'settings.agents.memoryCap.desc'),
      i('agents.launch', 'settings.agents.launch'),
      i('agents.view', 'settings.agents.view', 'settings.agents.view.desc'),
      i('agents.permission', 'settings.agents.permission', 'settings.agents.permission.desc'),
      i('agents.args', 'settings.agents.args', 'settings.agents.args.desc'),
      i('agents.env', 'settings.agents.env', 'settings.agents.env.desc'),
      i('agents.command', 'settings.agents.command', 'settings.agents.command.desc'),
      i('agents.preview', 'settings.agents.preview')
    ]
  },
  soon('usage', 'aiws'),
  soon('git', 'aiws'),
  soon('editor', 'aiws'),
  soon('sessionSearch', 'aiws'),
  // M1 라운드 3: 알림 센터 — 토스트 켜기/끄기 + 소리(3차) 자리.
  {
    id: 'notify',
    group: 'aiws',
    items: [
      i('notify.toast', 'settings.notify.toast', 'settings.notify.toast.desc'),
      i('notify.agents', 'settings.notify.agents', 'settings.notify.agents.desc'),
      i('notify.sound', 'settings.notify.sound', 'settings.notify.sound.desc')
    ]
  },
  soon('browser', 'aiws'),
  soon('automations', 'aiws'),

  { id: 'general', group: 'app', items: [s('uiScale'), s('bootSplash'), i('dir.download', 'settings.dir.download', 'settings.dir.download.desc')] },
  { id: 'look', group: 'app', items: [s('mouseCursor')] },
  soon('pet', 'app'),
  {
    id: 'font',
    group: 'app',
    items: [
      i('font.compare', 'settings.compare.title'),
      i('font.krFallback', 'settings.krFallback', 'settings.krFallback.desc'),
      i('font.term', 'settings.pick.title', 'settings.pick.desc'),
      i('font.size', 'settings.size'),
      i('font.lineHeight', 'settings.lineHeight'),
      i('font.preview', 'settings.preview.title')
    ]
  },
  {
    id: 'keys',
    group: 'app',
    items: [i('keys.tmux', 'settings.keys.tmux', 'settings.keys.tmux.desc'), i('keys.list', 'settings.keys.list', 'settings.keys.note')]
  },
  { id: 'update', group: 'app', items: [i('update', 'settings.update')] },

  {
    id: 'ai',
    group: 'global',
    items: [
      i('ai.callName', 'settings.ai.call', 'settings.ai.call.desc'),
      i('ai.provider', 'settings.ai.provider', 'settings.ai.provider.desc'),
      i('ai.baseUrl', 'settings.ai.baseUrl', 'settings.ai.baseUrl.desc'),
      i('ai.key', 'settings.ai.key', 'settings.ai.key.desc'),
      i('ai.model', 'settings.ai.model', 'settings.ai.model.desc'),
      i('ai.usage', 'settings.ai.usage', 'settings.ai.usage.desc')
    ]
  },
  {
    id: 'voice',
    group: 'global',
    items: [
      i('voice.enabled', 'settings.voice.enabled', 'settings.voice.enabled.desc'),
      i('voice.voice', 'settings.voice.voice'),
      i('voice.speed', 'settings.voice.speed'),
      i('voice.mic', 'settings.voice.mic'),
      i('voice.listen', 'settings.voice.listen', 'settings.voice.listen.desc'),
      i('voice.lines', 'settings.voice.lines'),
      i('voice.keep', 'settings.voice.keep', 'settings.voice.keep.desc'),
      i('voice.approve', 'settings.voice.approve', 'settings.voice.approve.desc'),
      i('voice.bypass', 'settings.voice.bypass', 'settings.voice.bypass.desc')
    ]
  },

  {
    id: 'terminal',
    group: 'terminal',
    items: [s('termCompletion'), s('cursorStyle'), s('cursorBlink'), s('bell'), s('copyOnSelect'), s('scrollback')]
  },
  soon('conn', 'terminal'),
  {
    id: 'features',
    group: 'terminal',
    items: FEATURES.map((f) => i(`feature.${f.id}`, `feature.${f.id}`, `feature.${f.id}.desc`))
  },
  {
    id: 'log',
    group: 'terminal',
    items: [s('sessionLog'), s('logRetention'), s('logFolder'), i('dir.session', 'settings.dir.session', 'settings.dir.session.desc')]
  },
  { id: 'history', group: 'terminal', items: [i('hist.clearAll', 'settings.hist.clearAll', 'settings.hist.clearAll.desc')] },

  {
    id: 'security',
    group: 'security',
    items: [
      i('sec.use', 'settings.sec.use', 'settings.sec.use.desc'),
      i('sec.pw', 'settings.sec.pw'),
      i('sec.key', 'settings.sec.key', 'settings.sec.key.desc'),
      i('sec.auto', 'settings.sec.auto', 'settings.sec.auto.desc'),
      i('sec.otp', 'settings.sec.otp', 'settings.sec.otp.note')
    ]
  },
  {
    id: 'mcp',
    group: 'security',
    items: [
      i('mcp.enable', 'settings.mcp.enable', 'settings.mcp.enable.desc'),
      i('mcp.port', 'settings.mcp.port', 'settings.mcp.port.desc'),
      i('mcp.token', 'settings.mcp.token', 'settings.mcp.token.desc'),
      i('mcp.connected', 'settings.mcp.connected', 'settings.mcp.connected.desc'),
      i('sec.mcp', 'settings.sec.mcp', 'settings.sec.mcp.desc')
    ]
  },
  soon('remote', 'security'),
  soon('mobile', 'security'),
  soon('slack', 'security'),
  soon('privacy', 'security'),

  {
    id: 'advanced',
    group: 'advanced',
    items: [
      i('gpu', 'settings.gpu.title'),
      i('probe', 'settings.probe.title', 'settings.probe.desc'),
      i('dir.app', 'settings.dir.app', 'settings.dir.app.desc')
    ]
  },
  // M1 라운드 2 의 실험 기능(AI 작업 공간 토글)은 M3 에서 기본 공개로 바뀌며 섹션째 지웠다.

  {
    id: 'about',
    group: 'about',
    items: [
      i('about.version', 'settings.about.version', 'about.msg'),
      i('manual', 'settings.manual.title', 'settings.manual.desc'),
      i('notes', 'settings.notes.title', 'settings.notes.desc'),
      i('license', 'settings.license.title'),
      i('notice', 'settings.notice.title')
    ]
  }
]

export const sectionDef = (id: SettingsSection): SettingsSectionDef =>
  SETTINGS_INDEX.find((d) => d.id === id) ?? SETTINGS_INDEX[0]

/** 이 항목이 사는 섹션(딥링크를 항목 id 하나로 부를 때). */
export const sectionOfItem = (item: string): SettingsSection | undefined =>
  SETTINGS_INDEX.find((d) => d.items.some((x) => x.id === item))?.id

export type SettingsHit = { section: SettingsSectionDef; items: SettingsItem[] }

/**
 * 항목 단위 검색 — 라벨·설명에 검색어가 들어간 항목만 남긴다. 섹션·묶음 이름이 맞으면 그 섹션 전부.
 * 결과는 묶음 순서 그대로다(목록과 같은 순서라 눈이 안 튄다). 빈 검색어 = 빈 결과.
 * ponytail: 부분 문자열 일치뿐(Orca 의 점수 순위·키워드는 없다) — 항목이 수백 개가 되면 점수를 더한다.
 */
export function searchSettings(query: string, tr: (key: string) => string): SettingsHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const has = (key?: string): boolean => !!key && tr(key).toLowerCase().includes(q)
  const out: SettingsHit[] = []
  for (const d of SETTINGS_INDEX) {
    const whole = has(`settings.nav.${d.id}`) || has(`settings.group.${d.group}`)
    const items = whole ? d.items : d.items.filter((x) => has(x.label) || has(x.desc))
    if (whole || items.length > 0) out.push({ section: d, items })
  }
  return out
}
