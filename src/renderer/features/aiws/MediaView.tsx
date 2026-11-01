// M12 CV-02 — 가운데 파일 탭의 뷰어(PDF·이미지·오디오/비디오). AgentPane 이 lazy 로 부른다 — 뷰어 탭을 처음 볼 때만 이 청크가 불린다.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/renderer/src/components/editor/MediaViewer.tsx(오디오·비디오 = 브라우저 <audio>/<video> controls,
// 재생 실패 문구, [기본 앱으로 열기])·ImageViewer.tsx(가운데 맞춤). 바이트는 main 이 작업 단위 폴더 안에서만 읽어 준다(로컬 디스크·원격 SFTP).
// 뺀 것: 이미지 확대·축소·끌기, PDF 의 pdf.js(찾기·쪽 이동·배율 기억 — Orca 는 pdfjs-dist. 새 의존성이라 보고만) → Chromium 내장 PDF 보기,
// Range 스트리밍(orca-media: 프로토콜) → 상한(MEDIA_MAX_BYTES)까지 통째로.
import { useEffect, useState, type JSX } from 'react'
import { MEDIA_MAX_BYTES, mediaOf } from '@shared/media'
import { t } from '../../i18n'
import type { CodeFile } from './codeStore'

type State = { url: string } | { error: string } | null

const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)

export default function MediaView({ file }: { file: CodeFile }): JSX.Element {
  const m = mediaOf(file.path)
  const [state, setState] = useState<State>(null)
  const [failed, setFailed] = useState(false)
  const name = file.path.split(/[\\/]/).pop() ?? file.path

  useEffect(() => {
    if (!m) return
    let live = true
    let url: string | null = null
    setState(null)
    setFailed(false)
    void window.ev.code.readBytes(file.root, file.path, file.host).then((r) => {
      if (!live) return
      if (r.ok) {
        url = URL.createObjectURL(new Blob([r.data as BlobPart], { type: m.mime }))
        return setState({ url })
      }
      setState({
        error: r.tooBig ? t('media.tooBig').replace('{size}', mb(r.size ?? 0)).replace('{limit}', mb(MEDIA_MAX_BYTES[m.kind])) : r.message
      })
    })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.root, file.path, file.host])

  // 이 창에서 PDF 를 그릴 수 없으면(Chromium 내장 보기 꺼짐) 빈 틀 대신 그렇다고 말한다.
  const pdfOff = m?.kind === 'pdf' && navigator.pdfViewerEnabled === false
  const note = !m ? t('media.unsupported') : state === null ? t('code.loading') : 'error' in state ? state.error : failed ? t('media.failed') : pdfOff ? t('media.pdfOff') : null

  return (
    <div className="media-view" data-media={m?.kind}>
      <div className="media-stage">
        {note ? (
          <p className="media-note" role={state && 'error' in state ? 'alert' : undefined}>
            {note}
          </p>
        ) : state && 'url' in state && m ? (
          m.kind === 'image' ? (
            <img src={state.url} alt={name} onError={() => setFailed(true)} />
          ) : m.kind === 'pdf' ? (
            <iframe src={state.url} title={name} />
          ) : m.kind === 'audio' ? (
            <audio src={state.url} controls preload="metadata" aria-label={name} onError={() => setFailed(true)} />
          ) : (
            <video src={state.url} controls preload="metadata" aria-label={name} onError={() => setFailed(true)} />
          )
        ) : null}
      </div>
      <div className="media-foot">
        <span>{file.path}</span>
        {/* 원격 파일은 이 PC 에 실체가 없어 OS 가 열 수 없다. */}
        {!file.host && (
          <button type="button" className="btn sec" data-media="open-external" onClick={() => void window.ev.fs.openPath(file.path)}>
            {t('media.openExternal')}
          </button>
        )}
      </div>
    </div>
  )
}
