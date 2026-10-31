// 출처: stablyai/orca src/renderer/src/components/error-boundaries/RecoverableRenderErrorBoundary.tsx@7a7f46f8a3 (MIT)
// M0 FD-04 렌더러 마무리 — 화면 한 영역이 그리다 던져도 그 영역만 대체 화면으로 바꾸고 나머지는 산다.
// 앱 전체 경계(main.tsx) + 큰 영역(사이드바·메인·아라 패널·설정) 경계. 오류는 main-error.log 로 간다.
//
// Orca 와 다른 점: 지연 청크 실패 구분·크래시 보고 서버 전송을 뺐다(아라는 로컬 파일 기록뿐).
// [다시 시도]는 경계 상태만 지워 자식을 새로 그린다 — 같은 원인이면 다시 잡힌다(무한 루프가 아니라 같은 대체 화면).
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../i18n'

type Props = {
  /** main-error.log 의 `renderer <area>` — 어느 영역이 죽었나. */
  area: string
  children: ReactNode
  /** 대체 화면이 영역의 자리(폭·flex)를 그대로 차지하게 — 예: 'sidebar', 'main'. */
  className?: string
  /** 이 값이 바뀌면 오류를 지우고 다시 그린다(예: 설정을 다시 열 때). */
  resetKey?: unknown
  /** 덮개 영역(설정)처럼 대체 화면에서 빠져나갈 길이 따로 필요할 때. */
  onDismiss?: () => void
}

type State = { error: Error | null; resetKey: unknown }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 기록 실패(IPC 없음 — 시험 환경 등)로 대체 화면까지 깨지면 안 된다.
    void window.ev?.app
      ?.logRendererError?.(this.props.area, error.message, `${error.stack ?? ''}\n${info.componentStack ?? ''}`)
      ?.catch(() => {})
  }

  private reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className={'eb-fallback' + (this.props.className ? ' ' + this.props.className : '')} role="alert" data-area={this.props.area}>
        <div className="eb-title">{t('errorBoundary.title')}</div>
        <div className="eb-desc">{t('errorBoundary.desc')}</div>
        <div className="eb-actions">
          <button type="button" className="btn sec" data-action="errorBoundary.retry" onClick={this.reset}>
            {t('errorBoundary.retry')}
          </button>
          {this.props.onDismiss && (
            <button type="button" className="btn sec" data-action="errorBoundary.dismiss" onClick={this.props.onDismiss}>
              {t('errorBoundary.dismiss')}
            </button>
          )}
        </div>
      </div>
    )
  }
}
