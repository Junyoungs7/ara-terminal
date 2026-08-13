// F26 서버 콘솔 — 디스크 창. 위는 파일시스템(df), 아래는 폴더 파고들기(du).
//
// 이 창의 존재 이유는 아래쪽이다: **디스크가 꽉 찼을 때 범인 찾기.** 마운트를 고르면 그 아래 한
// 단계를 재고, 폴더를 누르면 한 단계 더 들어간다. [뒤로] 로 되돌아온다. 위쪽 표만 있으면
// "/data 가 95% 다"까지만 알고 그 다음에 다시 ssh 로 du 를 치게 된다.
//
// du 는 **폴링하지 않는다** — 큰 트리에서 몇 초씩 걸리는 명령이라 2.5초마다 돌리면 서버를 괴롭힌다.
// 고를 때·파고들 때·[새로고침] 때만 한 번 실행한다. df 는 싸므로 그대로 watch 한다.
import { useEffect, useRef, useState } from 'react'
import { parseDf, parseDu, type DirUsage, type DiskRow } from '@shared/remoteCatalog'
import { humanSize } from './filePath'
import { IconBack, IconRefresh } from './icons'
import { t } from '../i18n'

// ── 순수 함수(단위 테스트 대상: tests/serverConsole.test.ts) ────────────────

/**
 * 사람이 관리하지 않는 파일시스템. parseDf 는 일부러 걸러 주지 않는다("무엇을 숨길지는 화면이
 * 정한다") — 그 판단이 여기다. 이것들을 그대로 보여 주면 tmpfs 수십 줄에 진짜 디스크가 묻힌다.
 */
const VIRTUAL_FS = new Set([
  'tmpfs',
  'devtmpfs',
  'ramfs',
  'squashfs',
  'overlay',
  'proc',
  'sysfs',
  'devpts',
  'cgroup',
  'cgroup2',
  'debugfs',
  'tracefs',
  'securityfs',
  'pstore',
  'efivarfs',
  'configfs',
  'fusectl',
  'mqueue',
  'hugetlbfs',
  'binfmt_misc',
  'autofs',
  'nsfs',
  'none'
])

/** 크기 0 도 가상 취급한다 — 남은 용량을 말할 수 없는 항목은 이 표에서 할 일이 없다. */
export function isVirtualFs(row: DiskRow): boolean {
  return VIRTUAL_FS.has(row.type) || row.totalKb === 0
}

export function visibleDisks(rows: readonly DiskRow[], showVirtual: boolean): DiskRow[] {
  return showVirtual ? [...rows] : rows.filter((r) => !isVirtualFs(r))
}

/** 빨강 = 곧 멈춘다 / 주황 = 지금 봐 둬야 한다. 그 아래는 색을 쓰지 않는다. */
export const DISK_CRIT_PCT = 90
export const DISK_WARN_PCT = 75

export function diskTone(usePct: number): 'crit' | 'warn' | null {
  if (usePct >= DISK_CRIT_PCT) return 'crit'
  return usePct >= DISK_WARN_PCT ? 'warn' : null
}

/**
 * `du -x -d1 -k <base>` 결과에서 **자식만** 남긴다. du 는 대상 폴더 자신도 한 줄로 주는데(대개 제일 큰
 * 줄이다) 그대로 두면 자기 자신을 눌러 제자리를 다시 재게 된다. 접두사에 `/` 를 붙여 비교하므로
 * `/data` 를 파고들 때 형제인 `/database` 가 딸려 오지 않는다.
 */
export function duChildren(rows: readonly DirUsage[], base: string): DirUsage[] {
  const prefix = base.endsWith('/') ? base : base + '/'
  return rows.filter((r) => r.path !== base && r.path.startsWith(prefix))
}

/** 방문 이력 한 칸. 마운트를 갈아탄 것도 이력이라 둘을 함께 들고 있어야 제자리로 돌아온다. */
export type DiskStop = { mount: string; path: string }

/**
 * [뒤로] — 방문 이력 한 칸 되돌리기(2026-08-13 준영님 요청으로 [상위로]를 대체).
 *
 * 파고들기만 하면 [상위로]와 결과가 같지만, **위 표에서 마운트를 갈아탄 경우** 갈린다:
 * `/data` 를 보다가 `/` 를 고르면 [상위로]는 (마운트 자신이라) 막혀 있고 [뒤로]는 `/data` 로 돌아온다.
 * 같은 자리를 두 번 밀지 않는다 — [새로고침] 이나 같은 폴더 재클릭으로 이력이 부풀지 않게.
 */
export function pushStop(hist: readonly DiskStop[], cur: DiskStop): DiskStop[] {
  const top = hist[hist.length - 1]
  if (top && top.mount === cur.mount && top.path === cur.path) return [...hist]
  return [...hist, cur]
}

/** df·du 는 KB 로 준다. 표기는 파일 탐색기와 같은 humanSize 를 쓴다(두 번째 단위 규칙을 만들지 않는다). */
const kb = (n: number): string => humanSize(n * 1024)

// ── 화면 ────────────────────────────────────────────────────────────────────

type Props = {
  sessionId: string | null
  /** 숨은 탭은 원격에 명령을 보내지 않는다(active=false → unwatch). */
  active: boolean
  /** 지금 보는 경로를 파일 탐색기 창에서 연다(기존 탐색기 진입점 재사용 — 새 창을 만들지 않는다). */
  onOpenExplorer: (path: string) => void
}

export function DiskTable({ sessionId, active, onOpenExplorer }: Props): JSX.Element {
  const [disks, setDisks] = useState<DiskRow[]>([])
  const [showVirtual, setShowVirtual] = useState(false)
  // mount: 위 표에서 고른 파일시스템. path: 지금 파고든 위치(mount 이거나 그 아래).
  const [mount, setMount] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [dirs, setDirs] = useState<DirUsage[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 방문 이력(가장 뒤가 직전 자리). [뒤로]가 여기서 하나씩 꺼낸다.
  const [hist, setHist] = useState<DiskStop[]>([])
  // 폴더를 빠르게 두 번 누르면 응답이 뒤바뀔 수 있다 — 마지막으로 요청한 경로의 답만 화면에 올린다.
  const want = useRef<string>('')

  // 서버가 바뀌면 위·아래를 함께 버린다. 남겨 두면 A 의 /data 목록을 B 의 것으로 착각한다.
  useEffect(() => {
    setDisks([])
    setMount(null)
    setPath(null)
    setDirs([])
    setErr(null)
    setHist([])
    // 재는 중에 서버가 바뀌면 그 응답은 버려진다(want 가 어긋난다) — busy 도 함께 내려야
    // "재는 중"이 영영 남지 않는다.
    setBusy(false)
    want.current = ''
  }, [sessionId])

  useEffect(() => {
    if (!active || !sessionId) return
    const off = window.ev?.remote.onData((d) => {
      if (d.sessionId === sessionId && d.cmdId === 'disk.usage') setDisks(parseDf(d.out))
    })
    void window.ev?.remote.watch(sessionId, 'disk.usage')
    return () => {
      off?.()
      void window.ev?.remote.unwatch(sessionId, 'disk.usage')
    }
  }, [active, sessionId])

  const shown = visibleDisks(disks, showVirtual)

  const loadDu = async (target: string): Promise<void> => {
    if (!sessionId) return
    want.current = target
    setPath(target)
    setDirs([])
    setErr(null)
    setBusy(true)
    const r = await window.ev?.remote.run(sessionId, 'disk.du', { path: target })
    if (want.current !== target) return // 그 사이 다른 폴더를 눌렀다 — 늦게 온 답은 버린다
    setBusy(false)
    if (!r?.ok) {
      // 조용히 비우지 않는다. `/` 전체처럼 오래 걸리는 경로는 10초 상한에 걸리는데, 그때 빈 목록을
      // 보여 주면 "폴더가 없다"로 읽힌다.
      setErr(r?.reason === 'timeout' ? t('console.disk.du.timeout') : t('console.err.' + (r?.reason ?? 'exec')))
      return
    }
    setDirs(duChildren(parseDu(r.out), target))
  }

  /** 새 자리로 이동 — 지금 자리를 이력에 남긴다. [새로고침] 은 이 길로 오지 않는다(제자리라서). */
  const go = (m: string, target: string): void => {
    if (mount && path) setHist((h) => pushStop(h, { mount, path }))
    setMount(m)
    void loadDu(target)
  }

  const back = (): void => {
    const prev = hist[hist.length - 1]
    if (!prev) return
    setHist((h) => h.slice(0, -1))
    setMount(prev.mount)
    void loadDu(prev.path)
  }

  return (
    <div className="con-disk">
      <div className="con-toolbar">
        <span className="con-sect">{t('console.disk.fsTitle')}</span>
        <span className="sb-tab-spacer" />
        {/* 가상 파일시스템은 기본으로 감춘다 — 숨겼다는 사실이 보이게 체크박스로 둔다. */}
        <label className="fb-check">
          <input type="checkbox" checked={showVirtual} onChange={(e) => setShowVirtual(e.target.checked)} />
          {t('console.disk.showVirtual')}
        </label>
      </div>

      <div className="con-tblwrap dsk-top">
        <table className="con-tbl">
          <thead>
            <tr>
              <th className="cmount">{t('console.disk.col.mount')}</th>
              <th className="ctype">{t('console.disk.col.type')}</th>
              <th className="cuse">{t('console.disk.col.use')}</th>
              <th className="ctotal">{t('console.disk.col.total')}</th>
              <th className="cavail">{t('console.disk.col.avail')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => {
              const tone = diskTone(d.usePct)
              return (
                <tr
                  key={d.mount}
                  className={'dsk-row' + (d.mount === mount ? ' sel' : '') + (tone ? ' ' + tone : '')}
                  data-mount={d.mount}
                  title={d.filesystem}
                  onClick={() => go(d.mount, d.mount)}
                >
                  <td className="cmount">{d.mount}</td>
                  <td className="ctype">{d.type}</td>
                  <td className="cuse">
                    <span className="con-bar">
                      <i style={{ width: `${Math.min(100, d.usePct)}%` }} />
                    </span>
                    <span className="dsk-pct">{d.usePct}%</span>
                  </td>
                  <td className="ctotal">{kb(d.totalKb)}</td>
                  <td className="cavail">{kb(d.availKb)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {disks.length === 0 && <div className="con-empty">{t('console.disk.loading')}</div>}
        {disks.length > 0 && shown.length === 0 && <div className="con-empty">{t('console.disk.none')}</div>}
      </div>

      <div className="con-toolbar dsk-bar">
        {/* [뒤로]는 경로 **왼쪽**이다 — 브라우저·탐색기 관례이고, 준영님이 짚으신 자리다. */}
        <button
          type="button"
          className="con-btn icon"
          data-action="disk.back"
          title={t('console.disk.back')}
          aria-label={t('console.disk.back')}
          disabled={hist.length === 0}
          onClick={back}
        >
          <IconBack />
        </button>
        <span className="dsk-path">{path ?? ''}</span>
        <span className="con-sect">{t(path ? 'console.disk.du.head' : 'console.disk.du.pick')}</span>
        <span className="sb-tab-spacer" />
        <button
          type="button"
          className="con-btn"
          data-action="disk.refresh"
          title={t('sftp.refresh')}
          disabled={!path || busy}
          onClick={() => path && void loadDu(path)}
        >
          <IconRefresh />
        </button>
        <button
          type="button"
          className="con-btn"
          data-action="disk.explorer"
          disabled={!path}
          onClick={() => path && onOpenExplorer(path)}
        >
          {t('console.disk.open')}
        </button>
      </div>

      <div className="con-tblwrap dsk-dirs">
        {dirs.map((d) => (
          <div key={d.path} className="dsk-dir" data-path={d.path} title={d.path} onClick={() => mount && go(mount, d.path)}>
            <span className="sz">{kb(d.kb)}</span>
            <span className="pt">{d.path}</span>
          </div>
        ))}
        {busy && <div className="con-empty">{t('console.disk.du.busy')}</div>}
        {!busy && err && <div className="con-empty bad">{err}</div>}
        {!busy && !err && path && dirs.length === 0 && <div className="con-empty">{t('console.disk.du.empty')}</div>}
      </div>
    </div>
  )
}
