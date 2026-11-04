// P3 R2-A 설정 › 터미널 3차 줄들(셸·테마·대비·가져오기·인라인 이미지·OSC 52) + 설정 › 업데이트 [릴리스 채널].
// SettingsPage 의 터미널 섹션이 끝에 붙인다. 테마 카탈로그·셸 목록은 이 줄들이 처음 그려질 때만 부른다(지연).
import { useEffect, useState } from 'react'
import type { FontConfig, UiPrefs } from '@shared/types'
import {
  CUSTOM_THEME_PREFIX,
  MAX_CONTRAST,
  MIN_CONTRAST,
  LIGHT_BG_MIN_CONTRAST,
  formatShellArgs,
  parseShellArgs,
  type ImportResult,
  type ImportSource,
  type ImportedTheme,
  type ShellChoice,
  type TermExtraPrefs,
  type UpdateChannel
} from '@shared/termExtra'
import { loadThemeCatalog } from '../terminal/termTheme'
import { Row, Toggle } from './SettingsPage'
import { Dropdown } from './Dropdown'
import { t } from '../i18n'

type Props = {
  prefs: UiPrefs
  onPrefsChange: (patch: Partial<UiPrefs>) => void
  onFont: (patch: Partial<FontConfig>) => void
}

const CUSTOM_SHELL = '__custom__'
const CONTRAST_STEP = 0.5
const SWATCH_KEYS = ['background', 'foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const

export function TermExtraRows({ prefs, onPrefsChange, onFont }: Props) {
  const x = prefs.termExtra
  const set = (patch: Partial<TermExtraPrefs>): void => onPrefsChange({ termExtra: { ...x, ...patch } })
  const [shells, setShells] = useState<ShellChoice[]>([])
  const [themes, setThemes] = useState<string[]>([])
  const [customPath, setCustomPath] = useState(false)
  const [preview, setPreview] = useState<{ source: ImportSource; r: ImportResult } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.ev?.termExtra
      ?.shells()
      .then(setShells)
      .catch(() => {})
    void loadThemeCatalog()
      .then((c) => setThemes(Object.keys(c)))
      .catch(() => {})
  }, [])

  const known = x.shell === '' || shells.some((s) => s.id === x.shell)
  const selectValue = customPath || !known ? CUSTOM_SHELL : x.shell
  const argsLine = x.shellArgs[x.shell] ? formatShellArgs(x.shellArgs[x.shell]) : ''
  const setArgs = (line: string): void => {
    const next = { ...x.shellArgs }
    if (line.trim()) next[x.shell] = parseShellArgs(line)
    else delete next[x.shell]
    set({ shellArgs: next })
  }

  // 디자인 시스템 Dropdown 은 라벨이 곧 값이다 — id ↔ 라벨을 여기서 잇는다.
  const shellLabelOf = (c: ShellChoice): string => c.label + (c.path ? '' : ` (${t('settings.term.shell.missing')})`)
  const shellOptions = [t('settings.term.shell.auto'), ...shells.map(shellLabelOf), t('settings.term.shell.custom')]
  const shellLabel = (id: string): string =>
    id === '' ? t('settings.term.shell.auto') : id === CUSTOM_SHELL ? t('settings.term.shell.custom') : (shells.find((c) => c.id === id) ?? { label: id, path: id }).label
  const shellFromLabel = (label: string): string =>
    label === t('settings.term.shell.auto') ? '' : (shells.find((c) => shellLabelOf(c) === label)?.id ?? CUSTOM_SHELL)

  const contrastMode = x.minimumContrastRatio === null ? 'auto' : x.minimumContrastRatio === MIN_CONTRAST ? 'off' : 'custom'
  const customNames = Object.keys(x.customThemes)
  const themeOptions = [t('settings.term.theme.ara'), ...customNames, ...themes.filter((n) => !customNames.includes(n))]
  const themeLabel = (id: string): string => (id === '' ? t('settings.term.theme.ara') : id.startsWith(CUSTOM_THEME_PREFIX) ? id.slice(CUSTOM_THEME_PREFIX.length) : id)
  const themeFromLabel = (label: string): string =>
    label === t('settings.term.theme.ara') ? '' : customNames.includes(label) ? CUSTOM_THEME_PREFIX + label : label

  const runImport = async (source: ImportSource): Promise<void> => {
    setBusy(true)
    try {
      const r = (await window.ev?.termExtra?.importPreview(source)) ?? { found: false, items: [], paths: [] }
      setPreview({ source, r })
    } catch (e) {
      setPreview({ source, r: { found: false, items: [], paths: [], error: e instanceof Error ? e.message : String(e) } })
    } finally {
      setBusy(false)
    }
  }
  const take = (it: ImportedTheme): void => {
    // 같은 이름이 이미 있으면 덮는다(같은 파일을 다시 가져온 것).
    const name = `${it.source === 'ghostty' ? 'Ghostty' : 'Warp'} · ${it.name}`.slice(0, 80)
    onPrefsChange({
      termExtra: { ...x, customThemes: { ...x.customThemes, [name]: it.colors }, theme: CUSTOM_THEME_PREFIX + name },
      ...(it.cursor?.style ? { cursorStyle: it.cursor.style } : {}),
      ...(it.cursor?.blink !== undefined ? { cursorBlink: it.cursor.blink } : {})
    })
    if (it.font?.family || it.font?.sizePx) onFont({ ...(it.font.family ? { term: it.font.family } : {}), ...(it.font.sizePx ? { sizePx: it.font.sizePx } : {}) })
  }
  const removeCustom = (name: string): void => {
    const next = { ...x.customThemes }
    delete next[name]
    set({ customThemes: next, ...(x.theme === CUSTOM_THEME_PREFIX + name ? { theme: '' } : {}) })
  }

  return (
    <>
      <Row label={t('settings.term.shell')} desc={t('settings.term.shell.desc')} item="term.shell">
        <div className="row">
          <div data-field="term.shell">
          <Dropdown
            value={shellLabel(selectValue)}
            options={shellOptions}
            ariaLabel={t('settings.term.shell')}
            onChange={(label) => {
              const v = shellFromLabel(label)
              setCustomPath(v === CUSTOM_SHELL)
              if (v !== CUSTOM_SHELL) set({ shell: v })
            }}
          />
          </div>
          {selectValue === CUSTOM_SHELL && (
            <input
              type="text"
              data-field="term.shell.path"
              defaultValue={known ? '' : x.shell}
              placeholder={t('settings.term.shell.pathHint')}
              aria-label={t('settings.term.shell.custom')}
              onBlur={(e) => set({ shell: e.target.value.trim() })}
            />
          )}
        </div>
      </Row>
      <Row label={t('settings.term.shellArgs')} desc={t('settings.term.shellArgs.desc')} item="term.shellArgs">
        <input
          key={x.shell}
          type="text"
          data-field="term.shellArgs"
          defaultValue={argsLine}
          placeholder={t('settings.term.shellArgs.hint')}
          aria-label={t('settings.term.shellArgs')}
          onBlur={(e) => setArgs(e.target.value)}
        />
      </Row>
      <Row label={t('settings.term.theme')} desc={t('settings.term.theme.desc')} item="term.theme">
        <div className="row">
          <div data-field="term.theme">
            <Dropdown value={themeLabel(x.theme)} options={themeOptions} ariaLabel={t('settings.term.theme')} onChange={(label) => set({ theme: themeFromLabel(label) })} />
          </div>
          {x.theme.startsWith(CUSTOM_THEME_PREFIX) && (
            <button type="button" className="btn sec" data-action="term.theme.remove" onClick={() => removeCustom(x.theme.slice(CUSTOM_THEME_PREFIX.length))}>
              {t('settings.term.theme.remove')}
            </button>
          )}
        </div>
      </Row>
      <Row label={t('settings.term.contrast')} desc={t('settings.term.contrast.' + contrastMode)} item="term.contrast">
        <div className="seg-ctl" data-field="term.contrast">
          {(['auto', 'off', 'custom'] as const).map((m) => (
            <button
              type="button"
              key={m}
              className={contrastMode === m ? 'on' : ''}
              data-value={m}
              onClick={() => set({ minimumContrastRatio: m === 'auto' ? null : m === 'off' ? MIN_CONTRAST : LIGHT_BG_MIN_CONTRAST })}
            >
              {t('settings.term.contrast.mode.' + m)}
            </button>
          ))}
        </div>
        {contrastMode === 'custom' && x.minimumContrastRatio !== null && (
          <div className="row">
            <input
              type="range"
              min={MIN_CONTRAST}
              max={MAX_CONTRAST}
              step={CONTRAST_STEP}
              value={x.minimumContrastRatio}
              aria-label={t('settings.term.contrast')}
              onChange={(e) => set({ minimumContrastRatio: Number(e.target.value) })}
            />
            <span className="v">{x.minimumContrastRatio.toFixed(1)}</span>
          </div>
        )}
      </Row>
      <Row label={t('settings.term.import')} desc={t('settings.term.import.desc')} item="term.import">
        <div className="row">
          <button type="button" className="btn sec" data-action="term.import.ghostty" disabled={busy} onClick={() => void runImport('ghostty')}>
            Ghostty
          </button>
          <button type="button" className="btn sec" data-action="term.import.warp" disabled={busy} onClick={() => void runImport('warp')}>
            Warp
          </button>
        </div>
        {preview && (
          <div className="set-import" data-import={preview.source}>
            {preview.r.error && <div className="set-note">{preview.r.error}</div>}
            {!preview.r.found && !preview.r.error && <div className="set-note">{t('settings.term.import.none')}</div>}
            {preview.r.found && preview.r.items.length === 0 && <div className="set-note">{t('settings.term.import.empty')}</div>}
            {preview.r.items.map((it) => (
              <div className="set-import-item" key={it.source + it.name}>
                <span className="set-swatches" aria-hidden>
                  {SWATCH_KEYS.map((k) => (it.colors[k] ? <i key={k} style={{ background: it.colors[k] }} /> : null))}
                </span>
                <span className="set-import-nm">{it.name}</span>
                {(it.font?.family || it.font?.sizePx) && <span className="set-note">{[it.font.family, it.font.sizePx].filter(Boolean).join(' · ')}</span>}
                {it.unsupported.length > 0 && (
                  <span className="set-note" title={it.unsupported.join(', ')}>
                    {t('settings.term.import.skipped').replace('{n}', String(it.unsupported.length))}
                  </span>
                )}
                <button type="button" className="btn sec" data-action="term.import.take" onClick={() => take(it)}>
                  {t('settings.term.import.take')}
                </button>
              </div>
            ))}
            {(preview.r.skipped?.length ?? 0) > 0 && (
              <div className="set-note" title={preview.r.skipped?.join('\n')}>
                {t('settings.term.import.badFiles').replace('{n}', String(preview.r.skipped?.length ?? 0))}
              </div>
            )}
          </div>
        )}
      </Row>
      <Row label={t('settings.term.inlineImages')} desc={t('settings.term.inlineImages.desc')} item="term.inlineImages">
        <Toggle on={x.inlineImages} label={t('settings.term.inlineImages')} onChange={(inlineImages) => set({ inlineImages })} />
      </Row>
      <Row label={t('settings.term.osc52')} desc={t('settings.term.osc52.desc')} item="term.osc52">
        <Toggle on={x.osc52} label={t('settings.term.osc52')} onChange={(osc52) => set({ osc52 })} />
      </Row>
    </>
  )
}

/** TM-15 설정 › 업데이트 [릴리스 채널]. 바꾸면 다음 확인부터 그 피드(beta.yml)를 본다 — 받기·설치는 지금처럼 사람이 누른다. */
export function UpdateChannelRow({ prefs, onPrefsChange }: Pick<Props, 'prefs' | 'onPrefsChange'>) {
  return (
    <Row label={t('settings.update.channel')} desc={t('settings.update.channel.desc')} item="update.channel">
      <div className="seg-ctl" data-field="update.channel">
        {(['stable', 'beta'] as UpdateChannel[]).map((c) => (
          <button type="button" key={c} className={prefs.updateChannel === c ? 'on' : ''} data-value={c} onClick={() => onPrefsChange({ updateChannel: c })}>
            {t('settings.update.channel.' + c)}
          </button>
        ))}
      </div>
    </Row>
  )
}
