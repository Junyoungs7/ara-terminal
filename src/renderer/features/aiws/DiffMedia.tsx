// 3차 R2-B 그림·HTML 비교 — DiffView(변경 비교 탭) 오른쪽에서 글 비교 대신 그린다. DiffView 청크 안(비교 탭을 열 때만 불린다).
// 출처: stablyai/orca @ec112c6b01 (MIT) src/renderer/src/components/editor/ImageDiffViewer.tsx(원래/바뀐 두 칸 — 나란히면 2열, 한 줄 보기면 위아래,
// 없는 쪽은 "미리 보기 없음")·docs review/diff-viewer.mdx(Image diffs — side-by-side, swipe, onion-skin · HTML preview).
// 아라 판:
//  · 겹쳐 보기 = 문서의 onion-skin(Orca 코드에는 아직 없다) — 두 그림을 한 자리에 겹치고 막대로 바뀐 쪽의 불투명도를 옮긴다. 스와이프는 뺐다.
//  · HTML = Orca 는 작업 트리 HTML 을 옆 브라우저로 미리 보기만 한다. 아라는 R1-B ara-doc 샌드박스를 그대로 두 번 띄워 원래/바뀐 쪽을 나란히 그린다
//    (원래 쪽 문서 글은 git 에서, 옆 파일 css·그림은 작업 폴더 디스크에서 — 비교라도 옆 파일은 지금 것). 보안 규칙은 main/code/docPreview.ts 그대로.
import { useEffect, useState, type JSX } from 'react'
import type { GitDiffArgs } from '@shared/gitDiff'
import { mediaOf } from '@shared/media'
import { t } from '../../i18n'
import './diffMedia.css'

type Pane = { label: string; url: string | null }

function Panes({ panes, inline, kind }: { panes: Pane[]; inline: boolean; kind: 'image' | 'html' }): JSX.Element {
  return (
    <div className={'diffm-grid' + (inline ? ' stack' : '')} data-diffm={kind}>
      {panes.map((p, i) => (
        <section key={i} className="diffm-pane" data-side={i === 0 ? 'original' : 'modified'}>
          <div className="diffm-label">{p.label}</div>
          {!p.url ? (
            <div className="diffm-empty">{t('diffm.noPreview')}</div>
          ) : kind === 'image' ? (
            <div className="diffm-stage">
              <img src={p.url} alt={p.label} />
            </div>
          ) : (
            // allow-same-origin 을 주지 않는다(HtmlPreview 와 같다) — 문서 스크립트는 앱·저장소·IPC 에 못 닿는다.
            <iframe className="diffm-frame" data-diffm="html-frame" src={p.url} sandbox="allow-scripts" title={p.label} referrerPolicy="no-referrer" />
          )}
        </section>
      ))}
    </div>
  )
}

/** 그림 비교 — 양쪽 바이트를 main 에 한 번 묻고 blob URL 로. */
export function ImageDiff({ args, inline }: { args: GitDiffArgs; inline: boolean }): JSX.Element {
  const [state, setState] = useState<{ original: string | null; modified: string | null } | { error: string } | null>(null)
  const [onion, setOnion] = useState(false)
  const [opacity, setOpacity] = useState(50)
  useEffect(() => {
    let live = true
    const urls: string[] = []
    setState(null)
    const mime = mediaOf(args.filePath)?.mime ?? 'application/octet-stream'
    const url = (b: Uint8Array | null): string | null => {
      if (!b) return null
      const u = URL.createObjectURL(new Blob([b as BlobPart], { type: mime }))
      urls.push(u)
      return u
    }
    void window.ev.gitInspect.diffImage(args).then((r) => {
      if (!live) return
      if (!r.ok) return setState({ error: r.tooLarge ? t('diff.tooLarge') : r.message })
      setState({ original: url(r.original), modified: url(r.modified) })
    })
    return () => {
      live = false
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [args])
  if (state === null) return <p className="aiws-note">{t('diff.loading')}</p>
  if ('error' in state)
    return (
      <p className="aiws-note aiws-err" role="alert">
        {state.error}
      </p>
    )
  const both = !!state.original && !!state.modified
  return (
    <div className="diffm" data-diffm="image-view">
      {both && (
        <div className="code-bar diffm-bar">
          <label className="diffm-toggle">
            <input type="checkbox" data-diffm="onion" checked={onion} onChange={(e) => setOnion(e.target.checked)} />
            {t('diffm.onion')}
          </label>
          {onion && (
            <input
              type="range"
              className="diffm-range"
              data-diffm="opacity"
              min={0}
              max={100}
              value={opacity}
              aria-label={t('diffm.opacity')}
              title={t('diffm.opacity')}
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          )}
        </div>
      )}
      {onion && both ? (
        <div className="diffm-onion" data-diffm="onion-stage">
          <img src={state.original!} alt={t('diffm.original')} />
          <img src={state.modified!} alt={t('diffm.modified')} style={{ opacity: opacity / 100 }} />
        </div>
      ) : (
        <Panes
          kind="image"
          inline={inline}
          panes={[
            { label: t('diffm.original'), url: state.original },
            { label: t('diffm.modified'), url: state.modified }
          ]}
        />
      )}
    </div>
  )
}

/**
 * HTML 렌더 비교 — 원래 쪽은 git 글을 문서로 실은 허가, 바뀐 쪽은 작업 중(디스크) 비교면 디스크 그대로, 스테이지·분기 비교면 그 글.
 * 웹 링크는 main 이 막고 알려 준다 → 묻고 Oriel 로(HtmlPreview 와 같은 길).
 */
export function HtmlDiff({ args, original, modified, inline }: { args: GitDiffArgs; original: string; modified: string; inline: boolean }): JSX.Element {
  const [urls, setUrls] = useState<[string | null, string | null] | { error: string } | null>(null)
  useEffect(() => {
    let live = true
    setUrls(null)
    const sep = args.host || !/^[a-zA-Z]:/.test(args.worktreePath) ? '/' : '\\'
    const abs = args.worktreePath.replace(/[\\/]+$/, '') + sep + args.filePath.split('/').join(sep)
    const grant = (text: string | undefined) => window.ev.code.docPreview(args.worktreePath, abs, args.host, false, text)
    void Promise.all([original ? grant(original) : null, modified ? grant(args.mode === 'unstaged' ? undefined : modified) : null]).then(([a, b]) => {
      if (!live) return
      const bad = [a, b].find((r) => r && !r.ok)
      if (bad && !bad.ok) return setUrls({ error: bad.message })
      setUrls([a?.ok ? a.url : null, b?.ok ? b.url : null])
    })
    return () => {
      live = false
    }
  }, [args, original, modified])
  const grants = urls && !('error' in urls) ? urls.filter((u): u is string => !!u).map((u) => new URL(u).hostname) : []
  const key = grants.join(',')
  useEffect(() => {
    if (!key) return
    const mine = new Set(key.split(','))
    return window.ev.code.onDocLink(({ url, grant }) => {
      if (mine.has(grant) && window.confirm(t('doc.html.linkConfirm').replace('{url}', url))) void window.ev.oriel.open(url)
    })
  }, [key])
  if (urls === null) return <p className="aiws-note">{t('diff.loading')}</p>
  if ('error' in urls)
    return (
      <p className="aiws-note aiws-err" role="alert">
        {urls.error}
      </p>
    )
  return (
    <div className="diffm" data-diffm="html-view">
      <div className="code-bar diffm-bar">
        <span className="diffm-note">{t('diffm.htmlNote')}</span>
      </div>
      <Panes
        kind="html"
        inline={inline}
        panes={[
          { label: t('diffm.original'), url: urls[0] },
          { label: t('diffm.modified'), url: urls[1] }
        ]}
      />
    </div>
  )
}
