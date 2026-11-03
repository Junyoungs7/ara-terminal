// P3 R2-A TM-11 Ghostty·Warp 설정 가져오기 — **읽기만** 한다(그 프로그램의 설정 파일·테마 폴더). 쓰는 곳은 아라 설정(ui.termExtra)뿐이고
// 그것도 사람이 [가져오기]를 누를 때 렌더러가 한다. 여기서는 미리 보기를 만든다.
//  · Ghostty: Orca src/main/ghostty(discovery·parser·theme-resolution 그대로, orcaRef ec112c6b01). 매퍼는 아라 범위로 줄였다 —
//    색(background·foreground·cursor-color·cursor-text·selection-*·palette)·글꼴(font-family·font-size)·커서(cursor-style·cursor-style-blink).
//    나머지 키(창 불투명도·분할 색·패딩·마우스 등)는 '안 옮김'으로 돌려준다(Orca 의 unsupportedKeys 와 같은 자리).
//  · Warp: Orca src/main/warp-themes(discovery 의 폴더 규칙 + parser 의 색 규칙). Orca 는 YAML 을 worker 에서 1초 상한으로 푼다 —
//    여기서는 파일 1MB·개수 100 상한으로 main 에서 푼다(테마 파일은 수 KB, 사람이 누를 때 한 번). 파일·폴더 고르기 창은 뺐다(자동 탐색만).
import { readdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir, platform as osPlatform } from 'node:os'
import path from 'node:path'
import { load } from 'js-yaml'
import { themeColorsOf, type ImportedTheme, type ImportResult, type ThemeColors } from '@shared/termExtra'

const MAX_CONFIG_BYTES = 1_000_000
const MAX_THEME_BYTES = 262_144
const MAX_WARP_FILE_BYTES = 1_000_000
const MAX_WARP_FILES = 100

type Parsed = Record<string, string | string[]>

// ── Ghostty parser(Orca parser.ts 그대로) ──
function stripInlineComment(value: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    const prev = i > 0 ? value[i - 1] : ''
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble && (prev === ' ' || prev === '\t')) return value.slice(0, i).trim()
  }
  return value.trim()
}

export function parseGhosttyConfig(content: string): Parsed {
  const result: Parsed = {}
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = stripInlineComment(line.slice(eq + 1).trim())
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!key) continue
    const existing = result[key]
    if (existing === undefined) result[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else result[key] = [existing, value]
  }
  return result
}

// ── Ghostty discovery·theme-resolution(Orca 그대로 — 경로 규칙) ──
function xdg(home: string, ...rest: string[]): string {
  return process.env['XDG_CONFIG_HOME'] ? path.posix.join(process.env['XDG_CONFIG_HOME'], 'ghostty', ...rest) : path.posix.join(home, '.config', 'ghostty', ...rest)
}

export function ghosttyConfigPaths(plat: NodeJS.Platform = osPlatform(), home = homedir()): string[] {
  const names = (dir: string, p = path.posix) => [p.join(dir, 'config.ghostty'), p.join(dir, 'config')]
  if (plat === 'darwin') return [...names(xdg(home)), ...names(path.posix.join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty'))]
  if (plat === 'linux') return names(xdg(home))
  if (plat === 'win32') return names(path.win32.join(process.env['APPDATA'] || home, 'ghostty'), path.win32)
  return []
}

function ghosttyThemeDirs(plat: NodeJS.Platform = osPlatform(), home = homedir()): string[] {
  if (plat !== 'darwin' && plat !== 'linux') return []
  const res = process.env['GHOSTTY_RESOURCES_DIR']
    ? [path.posix.join(process.env['GHOSTTY_RESOURCES_DIR'], 'themes')]
    : plat === 'darwin'
      ? ['/Applications/Ghostty.app/Contents/Resources/ghostty/themes']
      : ['/usr/share/ghostty/themes', '/usr/local/share/ghostty/themes']
  return [xdg(home, 'themes'), ...res]
}

const THEME_COLOR_KEYS = new Set(['palette', 'background', 'foreground', 'cursor-color', 'cursor-text', 'selection-background', 'selection-foreground', 'bold-color', 'split-divider-color'])

async function readSmall(p: string, max: number): Promise<string | null> {
  try {
    const s = await stat(p)
    if (!s.isFile() || s.size > max) return null
    return await readFile(p, 'utf8')
  } catch {
    return null
  }
}

async function resolveGhosttyTheme(name: string): Promise<Parsed | null> {
  const fromContent = (c: string): Parsed => Object.fromEntries(Object.entries(parseGhosttyConfig(c)).filter(([k]) => THEME_COLOR_KEYS.has(k)))
  if (path.isAbsolute(name)) {
    const c = await readSmall(name, MAX_THEME_BYTES)
    return c === null ? null : fromContent(c)
  }
  // 상대 이름은 경로 구분자 없이만(Orca isRelativeThemeName).
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return null
  for (const dir of ghosttyThemeDirs()) {
    const c = await readSmall(path.posix.join(dir, name), MAX_THEME_BYTES)
    if (c !== null) return fromContent(c)
  }
  return null
}

// ── 색 정규화(Orca normalizeTerminalHexColor) ──
export function hexOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
  return '#' + h.toLowerCase()
}

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
const PALETTE = [...ANSI, ...ANSI.map((n) => 'bright' + n[0].toUpperCase() + n.slice(1))]

/** Orca mapGhosttyToOrca 의 아라 판 — 색·글꼴·커서만. */
export function mapGhostty(parsed: Parsed, label: string): ImportedTheme {
  const colors: ThemeColors = {}
  const unsupported: string[] = []
  const last = (v: string | string[]): string => (Array.isArray(v) ? (v.at(-1) ?? '') : v)
  const out: ImportedTheme = { name: label, colors, unsupported, source: 'ghostty' }
  const color: Record<string, string> = { background: 'background', foreground: 'foreground', 'cursor-color': 'cursor', 'cursor-text': 'cursorAccent', 'selection-background': 'selectionBackground', 'selection-foreground': 'selectionForeground' }
  for (const [key, raw] of Object.entries(parsed)) {
    const v = last(raw).trim()
    if (color[key]) {
      const h = hexOf(v)
      if (h) colors[color[key]] = h
      else unsupported.push(key)
    } else if (key === 'palette') {
      for (const entry of Array.isArray(raw) ? raw : [raw]) {
        const eq = entry.indexOf('=')
        const idx = Number.parseInt(entry.slice(0, eq), 10)
        const h = eq > 0 ? hexOf(entry.slice(eq + 1)) : null
        if (h && idx >= 0 && idx < PALETTE.length) colors[PALETTE[idx]] = h
      }
    } else if (key === 'font-family') {
      if (v) out.font = { ...out.font, family: v }
    } else if (key === 'font-size') {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) out.font = { ...out.font, sizePx: Math.round(n) }
    } else if (key === 'cursor-style') {
      // Ghostty block|bar|underline|block_hollow — 아라는 셋.
      const s = v === 'block_hollow' ? 'block' : v
      if (s === 'block' || s === 'bar' || s === 'underline') out.cursor = { ...out.cursor, style: s }
      else unsupported.push(key)
    } else if (key === 'cursor-style-blink') {
      if (v === 'true' || v === 'false') out.cursor = { ...out.cursor, blink: v === 'true' }
    } else if (key !== 'bold-color') {
      unsupported.push(key)
    }
  }
  return out
}

export async function previewGhostty(): Promise<ImportResult> {
  const parsed: Parsed = {}
  const paths: string[] = []
  for (const p of ghosttyConfigPaths()) {
    const c = await readSmall(p, MAX_CONFIG_BYTES)
    if (c === null) continue
    // 뒤 파일이 앞을 덮는다 — palette 만 이어 붙인다(Orca mergeParsedConfig).
    for (const [k, v] of Object.entries(parseGhosttyConfig(c))) {
      const arr = (x: string | string[] | undefined): string[] => (x === undefined ? [] : Array.isArray(x) ? x : [x])
      parsed[k] = k === 'palette' ? [...arr(parsed[k]), ...arr(v)] : v
    }
    paths.push(p)
  }
  if (paths.length === 0) return { found: false, items: [], paths }
  const extra: string[] = []
  const rawTheme = parsed['theme']
  if (rawTheme !== undefined) {
    delete parsed['theme']
    const name = (Array.isArray(rawTheme) ? (rawTheme.at(-1) ?? '') : rawTheme).trim()
    // 테마 색은 기본값 — 설정에 적은 색·palette 가 이긴다(Orca applyThemeReference).
    const theme = name.split(',').some((x) => /^\s*(light|dark):/.test(x)) ? null : await resolveGhosttyTheme(name)
    if (!theme) extra.push('theme')
    else
      for (const [k, v] of Object.entries(theme)) {
        if (k === 'palette') parsed[k] = [...(Array.isArray(v) ? v : [v]), ...(parsed[k] === undefined ? [] : Array.isArray(parsed[k]) ? (parsed[k] as string[]) : [parsed[k] as string])]
        else if (parsed[k] === undefined) parsed[k] = v
      }
  }
  const item = mapGhostty(parsed, 'Ghostty')
  item.unsupported.push(...extra)
  return { found: true, items: [item], paths }
}

// ── Warp(Orca warp-themes discovery·parser) ──
const WARP_CHANNELS = [
  { mac: '.warp', linux: 'warp-terminal', win: 'Warp' },
  { mac: '.warp-preview', linux: 'warp-terminal-preview', win: 'WarpPreview' },
  { mac: '.warp-oss', linux: 'warp-oss', win: 'WarpOss' }
]

function subdirs(dir: string, keep: (name: string) => boolean): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && keep(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

export function warpThemeDirs(plat: NodeJS.Platform = osPlatform(), home = homedir()): string[] {
  const set = new Set<string>()
  if (plat === 'darwin') {
    for (const c of WARP_CHANNELS) set.add(path.posix.join(home, c.mac, 'themes'))
    for (const n of subdirs(home, (n) => n.startsWith('.warp'))) set.add(path.posix.join(home, n, 'themes'))
  } else if (plat === 'linux') {
    const x = process.env['XDG_DATA_HOME']
    const data = x && path.posix.isAbsolute(x) ? x : path.posix.join(home, '.local', 'share')
    for (const c of WARP_CHANNELS) set.add(path.posix.join(data, c.linux, 'themes'))
    for (const n of subdirs(data, (n) => n === 'warp-terminal' || n.startsWith('warp-'))) set.add(path.posix.join(data, n, 'themes'))
  } else if (plat === 'win32') {
    const base = path.win32.join(process.env['APPDATA'] || home, 'warp')
    for (const c of WARP_CHANNELS) set.add(path.win32.join(base, c.win, 'data', 'themes'))
    for (const n of subdirs(base, () => true)) set.add(path.win32.join(base, n, 'data', 'themes'))
  }
  return [...set]
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
// Warp 는 그라디언트를 {top, bottom, left, right} 로 적는다 — 한 색만 쓴다(Orca readColorValue).
const warpColor = (v: unknown): string | null => hexOf(v) ?? (isRecord(v) ? (hexOf(v['top']) ?? hexOf(v['bottom']) ?? hexOf(v['left']) ?? hexOf(v['right'])) : null)

export function parseWarpTheme(content: string, fileLabel: string): ImportedTheme | { error: string } {
  let v: unknown
  try {
    v = load(content, { filename: fileLabel })
  } catch (e) {
    return { error: e instanceof Error ? e.message.split('\n')[0] : 'YAML 오류' }
  }
  if (!isRecord(v)) return { error: 'YAML 객체가 아님' }
  const colors: ThemeColors = {}
  const bg = warpColor(v['background'])
  const fg = warpColor(v['foreground'])
  const cursor = warpColor(v['cursor']) ?? warpColor(v['accent'])
  if (bg) colors['background'] = bg
  if (fg) colors['foreground'] = fg
  if (cursor) colors['cursor'] = cursor
  const tc = isRecord(v['terminal_colors']) ? v['terminal_colors'] : {}
  for (const [group, prefix] of [['normal', ''], ['bright', 'bright']] as const) {
    const pal = tc[group]
    if (!isRecord(pal)) continue
    for (const n of ANSI) {
      const h = hexOf(pal[n])
      if (h) colors[prefix ? prefix + n[0].toUpperCase() + n.slice(1) : n] = h
    }
  }
  if (!themeColorsOf(colors) || !ANSI.some((n) => colors[n] || colors['bright' + n[0].toUpperCase() + n.slice(1)])) return { error: '배경·글자색·ANSI 색이 모자람' }
  const unsupported: string[] = []
  if ('background_image' in v) unsupported.push('background_image')
  if (isRecord(v['background']) || isRecord(v['accent'])) unsupported.push('gradient')
  const name = typeof v['name'] === 'string' && v['name'].trim() ? v['name'].trim().slice(0, 80) : path.basename(fileLabel, path.extname(fileLabel))
  return { name, colors, unsupported, source: 'warp' }
}

export async function previewWarp(): Promise<ImportResult> {
  const items: ImportedTheme[] = []
  const paths: string[] = []
  const skipped: string[] = []
  for (const dir of warpThemeDirs()) {
    let names: string[]
    try {
      names = readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort()
    } catch {
      continue
    }
    paths.push(dir)
    for (const n of names) {
      if (items.length + skipped.length >= MAX_WARP_FILES) break
      const c = await readSmall(path.join(dir, n), MAX_WARP_FILE_BYTES)
      if (c === null) {
        skipped.push(n)
        continue
      }
      const r = parseWarpTheme(c, n)
      if ('error' in r) skipped.push(`${n}: ${r.error}`)
      else items.push(r)
    }
  }
  return { found: paths.length > 0, items, paths, ...(skipped.length ? { skipped } : {}) }
}
