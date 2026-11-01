// M12 CV-01 — AI 작업 공간 오른쪽 [탐색기] 패널(Orca right-sidebar/FileExplorer.tsx 자리). 트리는 터미널 [파일] 탭과 **한 구현**(components/FileTree)이고,
// 여기서는 그 트리에 작업 단위 폴더(work 세션 — main 의 work/backend 가 로컬 디스크·원격 SFTP 를 고른다)·git 상태 색·폴더 감시만 얹는다.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/renderer/src/components/right-sidebar/FileExplorer.tsx·file-explorer-watch-*.ts(바뀌면 펼친 폴더 다시 읽기),
// docs/site/content/docs/editing/file-explorer.mdx(git 상태 색·경로 복사·끌어 옮기기). 뺀 것: 이름 필터 투영·가상 스크롤·[폴더에서 찾기]·OS 클립보드 파일 복사·원격 다운로드.
import { useEffect, useMemo, useState, type JSX } from 'react'
import { FileTree, type ActiveFileSession } from '../../components/FileTree'
import { gitDecorations } from '../../store/fileView'
import { useDialog } from '../../components/Dialog'
import { t } from '../../i18n'
import { openFile } from './codeStore'
import { hostOfWorktree, useAiwsStore } from './store'

export function ExplorerPanel({ onOpened }: { onOpened: () => void }): JSX.Element {
  const wt = useAiwsStore((s) => (s.activeWorktreeId ? Object.values(s.worktreesByRepo).flat().find((w) => w.id === s.activeWorktreeId) : undefined))
  const host = wt ? hostOfWorktree(wt.id) : undefined
  const root = wt?.path ?? null
  const dialog = useDialog()
  const [token, setToken] = useState(0)
  const [deco, setDeco] = useState<ReturnType<typeof gitDecorations>>({ files: new Map(), dirs: new Set() })

  // 폴더 감시 — 로컬은 OS 감시(묶어서), 원격은 주기적으로. 바뀌면 트리가 펼친 폴더까지 조용히 다시 읽고, git 색도 다시.
  useEffect(() => {
    if (!root) return
    void window.ev.code.watchTree(root, host)
    const off = window.ev.code.onTreeChanged((e) => e.root === root && setToken((n) => n + 1))
    return () => {
      off()
      void window.ev.code.unwatchTree(root, host)
    }
  }, [root, host])
  useEffect(() => {
    if (!root) return
    let live = true
    void window.ev.gitInspect.status(root, host).then((r) => live && setDeco(r.ok ? gitDecorations(r.entries) : { files: new Map(), dirs: new Set() }))
    return () => void (live = false)
  }, [root, host, token])

  const session = useMemo<ActiveFileSession>(() => (root ? { id: `${host ?? ''}\0${root}`, type: 'work', root, host, serverKey: host } : null), [root, host])
  const decorate = useMemo(() => {
    if (!root) return undefined
    const base = root.replace(/[\\/]+$/, '')
    return (abs: string): string | undefined => {
      const rel = abs.slice(base.length).replace(/\\/g, '/').replace(/^\/+/, '')
      return deco.files.get(rel) ?? (deco.dirs.has(rel) ? 'dirty' : undefined)
    }
  }, [root, deco])

  const open = async (abs: string): Promise<void> => {
    const r = await openFile(abs)
    if (!r.ok) return void dialog.ask({ title: t('code.err.openTitle'), message: r.message, cancelLabel: null })
    onOpened()
  }

  return (
    <div className="aiws-explorer" role="region" aria-label={t('rbar.explorer')} data-aiws="explorer">
      {wt ? (
        <FileTree
          key={wt.id}
          session={session}
          active
          cwd={root}
          ask={dialog.ask}
          askText={dialog.askText}
          onOpenFile={(p) => void open(p)}
          decorate={decorate}
          watchToken={token}
        />
      ) : (
        <span className="sb-placeholder">{t('code.err.noWorktree')}</span>
      )}
      {dialog.node}
    </div>
  )
}
