// 3차 R1-B HTML 미리 보기 — 작업 단위의 .html 을 샌드박스 iframe(ara-doc: 프로토콜)에 그린다. DocSurface 가 lazy 로 부른다.
// 출처: stablyai/orca @ec112c6b01 (MIT) docs editing/viewers.mdx#html(샌드박스 탭·상대 리소스는 작업 단위 파일 연결로·외부 링크는 확인 후·
// 내려받기 없음·Preview options = 디스크에서 다시 읽기/원문 열기/경로 복사). 보안 규칙은 main/code/docPreview.ts 머리 주석.
// 미리 보기는 **디스크의 글**을 그린다(Orca 와 같다) — 저장하면(서명이 바뀌면) 다시 읽는다.
// 뺀 것: 옆에 나란히 열기(Open Preview to the Side — 아라는 같은 탭의 보기 전환), 다른 폴더 읽기 허가 묻기, 미리 보기 안 찾기.
import { useEffect, useState, type JSX } from 'react'
import { Copy, Globe, RotateCw } from 'lucide-react'
import { t } from '../../i18n'
import { writeClipboard } from '../../store/clipboardWrite'
import type { DocProps } from './DocSurface'

export default function HtmlPreview({ file }: DocProps): JSX.Element {
  const [remote, setRemote] = useState(false)
  const [reload, setReload] = useState(0)
  const [src, setSrc] = useState<{ url: string } | { error: string } | null>(null)
  useEffect(() => {
    let live = true
    void window.ev.code.docPreview(file.root, file.path, file.host, remote).then((r) => live && setSrc(r.ok ? { url: r.url } : { error: r.message }))
    return () => {
      live = false
    }
  }, [file.root, file.path, file.host, remote, reload, file.sig])
  // 미리 보기 안의 웹 링크 — main 이 이동을 막고 알려 준다. 묻고 Oriel 로(Orca: External HTTP(S) links require confirmation). 여는 곳은 Oriel(미설치·실패면 OS 기본 브라우저).
  const grant = src && 'url' in src ? new URL(src.url).hostname : null
  useEffect(() => {
    if (!grant) return
    return window.ev.code.onDocLink(({ url, grant: g }) => {
      if (g === grant && window.confirm(t('doc.html.linkConfirm').replace('{url}', url))) void window.ev.oriel.open(url)
    })
  }, [grant])
  const rel = file.path.slice(file.root.replace(/[\\/]+$/, '').length).replace(/\\/g, '/').replace(/^\/+/, '')
  return (
    <div className="html-view" data-doc="html">
      <div className="csv-bar">
        <span className="csv-count">{t('doc.html.sandboxed')}</span>
        <label className="html-remote" title={t('doc.html.remoteHint')}>
          <input type="checkbox" data-field="html-remote" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
          <Globe aria-hidden />
          {t('doc.html.remote')}
        </label>
        <button type="button" className="aiws-ic" data-doc="html-reload" title={t('doc.html.reload')} aria-label={t('doc.html.reload')} onClick={() => setReload((n) => n + 1)}>
          <RotateCw />
        </button>
        <button type="button" className="aiws-ic" title={t('doc.html.copyPath')} aria-label={t('doc.html.copyPath')} onClick={() => void writeClipboard(rel)}>
          <Copy />
        </button>
      </div>
      {src === null ? (
        <p className="doc-fallback">{t('code.loading')}</p>
      ) : 'error' in src ? (
        <p className="doc-fallback" role="alert">
          {src.error}
        </p>
      ) : (
        // allow-same-origin 을 주지 않는다 — 문서 스크립트는 불투명 출처라 앱·저장소·다른 탭에 못 닿는다(팝업·폼·최상위 이동·내려받기도 막힘).
        <iframe key={src.url} className="html-frame" data-doc="html-frame" src={src.url} sandbox="allow-scripts" title={rel} referrerPolicy="no-referrer" />
      )}
    </div>
  )
}
