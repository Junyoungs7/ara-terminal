// M7 R2 WS-12·13 — 오른쪽 [소스 제어] 패널(시안 SW-final: 커밋 메시지 칸·[커밋]·[AI 로 쓰기](2차라 자리만)·변경 n 목록 M/U/D).
// Orca right-sidebar/SourceControl.tsx·source-control/(commit·listing·sync)·source-control-actions.ts(orcaRef fdfcfb3551)의 1차 판.
// 목록은 M7 R1 의 조회(gitInspect.status)를 쓰고, 쓰기는 scm:* — 쓰고 나면 다시 읽는다. 파일을 누르면 R1 의 diff 탭(창 이벤트 aiws:open-diff).
// 원격 작업(푸시·풀)은 **사용자가 누를 때만**(묶음 11). 결과는 알림 센터 토스트로.
// M12 R2: 머지 충돌 칸(Orca) — 충돌 파일은 에디터로 열고(3-way 색 구역), + 로 해결 표시, 진행 중인 병합·리베이스·체리픽은 [중단].
import { useCallback, useEffect, useState, type JSX } from 'react'
import { Minus, Plus, RefreshCw, Sparkles, Undo2 } from 'lucide-react'
import type { GitStatusEntry, GitStatusResult } from '@shared/gitDiff'
import { resolvePrimaryAction, type ScmConfirm, type ScmResult } from '@shared/scm'
import type { DialogResult, DialogSpec } from '../../components/Dialog'
import { pushNote } from '../../store/notify'
import { t } from '../../i18n'
import { hostOfWorktree, useAiwsStore } from './store'
import { openFile } from './codeStore'
import { useDiffStore } from './diffStore'

type AskFn = (spec: DialogSpec) => Promise<DialogResult>

const LETTER: Record<GitStatusEntry['status'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!' }
/** main 이 돌려주는 막힘 사유 코드 — 나머지는 git 의 말 그대로. */
const CODES = new Set(['detached', 'noRemote', 'badTarget', 'forceProtected', 'emptyMessage'])

export function ScmPanel({ ask, onOpened }: { ask: AskFn; onOpened?: () => void }): JSX.Element {
  const wt = useAiwsStore((s) => (s.activeWorktreeId ? Object.values(s.worktreesByRepo).flat().find((w) => w.id === s.activeWorktreeId) : undefined))
  // M8 R5 원격 작업 단위 — 같은 패널, git 은 그 서버에서(main 이 SSH exec 로 — 푸시 안전장치도 같다). host 만 실어 보낸다.
  const host = wt ? hostOfWorktree(wt.id) : undefined
  const root = wt?.path ?? null
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!root) return setStatus(null)
    setStatus(await window.ev.gitInspect.status(root, host))
  }, [root, host])
  useEffect(() => {
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const errText = (r: Extract<ScmResult, { ok: false }>): string => (CODES.has(r.message) ? t('scm.err.' + r.message) : r.message)

  /** 확인이 필요하면 묻고 confirmed 를 실어 한 번 더. 끝나면 목록을 다시 읽는다. */
  const run = async (label: string, op: (confirmed: ScmConfirm[]) => Promise<ScmResult>, note?: { done: string; fail: string }): Promise<boolean> => {
    if (!root || busy) return false
    setBusy(label)
    setErr(null)
    try {
      let r = await op([])
      if (!r.ok && r.need?.length) {
        const target = r.target ?? ''
        const yes = await ask({
          title: t('scm.confirm.title'),
          message: r.need.map((n) => t('scm.confirm.' + n).replace('{target}', target)).join('\n'),
          tone: 'danger',
          confirmLabel: t('scm.confirm.go')
        })
        if (yes !== 'confirm') return false
        r = await op(r.need)
      }
      if (note) pushNote({ kind: r.ok ? 'done' : 'error', space: 'ai', title: r.ok ? note.done : note.fail, body: r.ok ? r.message : errText(r), ctx: wt?.displayName })
      if (!r.ok) setErr(errText(r))
      return r.ok
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const entries = status?.ok ? status.entries : []
  const staged = entries.filter((e) => e.area === 'staged')
  // M12 R2 머지 충돌(Orca conflict-status-cards) — 충돌 파일은 [충돌] 칸으로 따로. + = 해결 표시(git add).
  const conflicts = entries.filter((e) => e.status === 'conflicted')
  const changes = entries.filter((e) => e.area !== 'staged' && e.status !== 'conflicted')
  const op = status?.ok && conflicts.length > 0 ? status.operation : undefined
  const upstream = status?.ok ? { hasUpstream: !!status.upstream, upstreamName: status.upstream ?? undefined, ahead: status.ahead, behind: status.behind } : null
  const primary = resolvePrimaryAction({
    stagedCount: staged.length,
    hasUnstaged: changes.length > 0,
    hasMessage: !!message.trim(),
    hasConflicts: conflicts.length > 0,
    busy: !!busy,
    hasBranch: status?.ok ? !!status.branch : false,
    upstream
  })

  const pushOp = (force: boolean) => (c: ScmConfirm[]) => window.ev.scm.push(root!, force, c.filter((x) => x !== 'pushed') as ('protected' | 'force')[], host)
  const pushNoteText = { done: t('scm.note.pushed'), fail: t('scm.note.pushFail') }
  const doPush = (force = false): Promise<boolean> => run('push', pushOp(force), pushNoteText)
  const doPrimary = async (): Promise<void> => {
    switch (primary.kind) {
      case 'commit':
        if (await run('commit', () => window.ev.scm.commit(root!, message, host))) setMessage('')
        return
      case 'stage':
        return void run('stage', () => window.ev.scm.stage(root!, changes.map((e) => e.path), host))
      case 'push':
      case 'publish':
        return void doPush()
      case 'pull':
        return void run('pull', () => window.ev.scm.pull(root!, false, host), { done: t('scm.note.pulled'), fail: t('scm.note.pullFail') })
      case 'sync':
        if (await run('pull', () => window.ev.scm.pull(root!, true, host), { done: t('scm.note.pulled'), fail: t('scm.note.pullFail') })) await doPush()
    }
  }
  const discard = async (e: GitStatusEntry): Promise<void> => {
    const yes = await ask({ title: t('scm.discard.title'), message: t('scm.discard.msg').replace('{path}', e.path), tone: 'danger', confirmLabel: t('scm.discard.go') })
    if (yes === 'confirm') await run('discard', () => window.ev.scm.discard(root!, e.path, host))
  }
  /** 충돌 파일은 비교가 아니라 에디터로 연다(Orca openConflictFile) — 표시 줄이 세 구역 색으로 갈리고 띠에서 위·아래 충돌로 간다. */
  const openConflict = async (e: GitStatusEntry): Promise<void> => {
    if (!wt) return
    const r = await openFile(e.path, undefined, { gitConflict: e.conflictKind })
    if (!r.ok) return void ask({ title: t('code.err.openTitle'), message: r.message + (e.conflictKind ? `
${t('scm.conflict.hint.' + e.conflictKind)}` : ''), cancelLabel: null })
    useDiffStore.getState().setShown(wt.id, false)
    onOpened?.()
  }
  const abortOp = async (): Promise<void> => {
    if (!op || op === 'unknown') return
    const yes = await ask({ title: t('scm.abort.title.' + op), message: t('scm.abort.msg'), tone: 'danger', confirmLabel: t('scm.abort.go') })
    if (yes === 'confirm') await run('abort', () => window.ev.scm.abort(root!, op, host), { done: t('scm.note.aborted'), fail: t('scm.note.abortFail') })
  }
  const openDiff = (e: GitStatusEntry): void => {
    window.dispatchEvent(new CustomEvent('aiws:open-diff', { detail: { filePath: e.path, mode: e.area === 'staged' ? 'staged' : 'unstaged' } }))
  }

  const row = (e: GitStatusEntry): JSX.Element => {
    const cut = e.path.lastIndexOf('/')
    return (
      <div key={e.area + ':' + e.path} className="scm-row" data-scm-file={e.path} data-scm-area={e.area}>
        <button
          type="button"
          className="scm-open"
          title={e.conflictKind ? `${e.path}
${t('scm.conflict.hint.' + e.conflictKind)}` : e.path}
          onClick={() => void (e.status === 'conflicted' ? openConflict(e) : openDiff(e))}
        >
          <span className="scm-name">{e.path.slice(cut + 1)}</span>
          {cut > 0 && <span className="scm-dir">{e.path.slice(0, cut)}</span>}
        </button>
        {e.conflictKind && <span className="scm-kind">{t('scm.conflict.kind.' + e.conflictKind)}</span>}
        {e.area !== 'staged' && (
          <button type="button" className="aiws-ic" data-scm="discard" title={t('scm.discard.go')} aria-label={t('scm.discard.go')} disabled={!!busy} onClick={() => void discard(e)}>
            <Undo2 />
          </button>
        )}
        {e.area === 'staged' ? (
          <button type="button" className="aiws-ic" data-scm="unstage" title={t('scm.unstage')} aria-label={t('scm.unstage')} disabled={!!busy} onClick={() => void run('unstage', () => window.ev.scm.unstage(root!, [e.path], host))}>
            <Minus />
          </button>
        ) : (
          <button type="button" className="aiws-ic" data-scm="stage" title={t('scm.stage')} aria-label={t('scm.stage')} disabled={!!busy} onClick={() => void run('stage', () => window.ev.scm.stage(root!, [e.path], host))}>
            <Plus />
          </button>
        )}
        <span className={'scm-st ' + e.status} title={t('scm.status.' + e.status)}>
          {LETTER[e.status]}
        </span>
      </div>
    )
  }

  return (
    <div className="aiws-scm" role="region" aria-label={t('rbar.scm')}>
      <div className="aiws-side-head">
        <span className="aiws-side-ttl">{t('rbar.scm')}</span>
        {status?.ok && <span className="scm-branch">{status.branch ?? t('scm.detached')}</span>}
        <button type="button" className="aiws-ic" data-scm="refresh" title={t('scm.refresh')} aria-label={t('scm.refresh')} onClick={() => void refresh()}>
          <RefreshCw />
        </button>
      </div>
      {!root ? (
        <div className="scm-msg">{t('code.err.noWorktree')}</div>
      ) : status && !status.ok ? (
        <div className="scm-msg err">{status.message}</div>
      ) : (
        <>
          <div className="scm-commit">
            <textarea
              className="aiws-input scm-message"
              data-field="scm.message"
              rows={3}
              spellCheck={false}
              placeholder={t('scm.message')}
              aria-label={t('scm.message')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.ctrlKey && primary.kind === 'commit' && !primary.disabled) void doPrimary()
              }}
            />
            <div className="scm-actions">
              <button type="button" className="scm-primary" data-scm="primary" data-kind={primary.kind} disabled={primary.disabled} title={t(primary.titleKey)} onClick={() => void doPrimary()}>
                {busy ? t('scm.busy.' + busy) : t('scm.kind.' + primary.kind) + (primary.count ? ` ${primary.count}` : '')}
              </button>
              {/* 2차(묶음 11) — 자리만. */}
              <button type="button" className="aiws-ic" data-scm="ai" disabled title={`${t('scm.aiWrite')} · ${t('aiws.soon')}`} aria-label={t('scm.aiWrite')}>
                <Sparkles />
              </button>
            </div>
            <div className="scm-more">
              <button type="button" data-scm="amend" disabled={!!busy || !status?.ok || !status.head} onClick={() => void run('amend', (c) => window.ev.scm.amend(root, message, c.includes('pushed'), host)).then((ok) => ok && setMessage(''))}>
                {t('scm.amend')}
              </button>
              <button type="button" data-scm="push" disabled={!!busy || !status?.ok || !status.branch} onClick={() => void doPush()}>
                {t('scm.kind.push')}
              </button>
              <button type="button" data-scm="forcePush" disabled={!!busy || !status?.ok || !status.branch} onClick={() => void doPush(true)}>
                {t('scm.forcePush')}
              </button>
            </div>
          </div>
          {err && (
            <div className="scm-msg err" data-scm="error">
              {err}
            </div>
          )}
          {op && (
            <div className="scm-op" role="status" data-scm="operation" data-op={op}>
              <span>{t('scm.op.' + op).replace('{n}', String(conflicts.length))}</span>
              {op !== 'unknown' && (
                <button type="button" className="btn sec" data-scm="abort" disabled={!!busy} onClick={() => void abortOp()}>
                  {t('scm.abort.go')}
                </button>
              )}
            </div>
          )}
          <div className="scm-list">
            {conflicts.length > 0 && (
              <>
                <div className="scm-sec" data-scm-sec="conflicts">
                  <span>{t('scm.conflicts').replace('{n}', String(conflicts.length))}</span>
                </div>
                {conflicts.map(row)}
              </>
            )}
            {staged.length > 0 && (
              <>
                <div className="scm-sec">
                  <span>{t('scm.staged').replace('{n}', String(staged.length))}</span>
                  <button type="button" className="aiws-ic" data-scm="unstageAll" title={t('scm.unstageAll')} aria-label={t('scm.unstageAll')} disabled={!!busy} onClick={() => void run('unstage', () => window.ev.scm.unstage(root, staged.map((e) => e.path), host))}>
                    <Minus />
                  </button>
                </div>
                {staged.map(row)}
              </>
            )}
            <div className="scm-sec">
              <span>{t('scm.changes').replace('{n}', String(changes.length))}</span>
              {changes.length > 0 && (
                <button type="button" className="aiws-ic" data-scm="stageAll" title={t('scm.stageAll')} aria-label={t('scm.stageAll')} disabled={!!busy} onClick={() => void run('stage', () => window.ev.scm.stage(root, changes.map((e) => e.path), host))}>
                  <Plus />
                </button>
              )}
            </div>
            {changes.map(row)}
          </div>
        </>
      )}
    </div>
  )
}
