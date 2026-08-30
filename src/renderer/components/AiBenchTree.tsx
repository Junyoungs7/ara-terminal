import { useEffect, useState } from 'react'
import { ChevronDown, GitBranch, X } from 'lucide-react'
import type { AgentState } from '@shared/agentStatus'
import type { AiSessionState } from '@shared/aiSession'
import {
  agoText,
  groupRows,
  GROUP_FOLDED,
  type BenchGroupId,
  type WorkbenchRow,
  type WorkbenchStatus
} from '../store/aiWorkbench'
import { t } from '../i18n'

/**
 * 사이드바 [AI] 탭(#129 · F1a) — **지금 어느 AI 가 무엇을 하고 있나.**
 *
 * 줄의 모양은 Orca 실물을 재현한 목업 d6 에서 왔고(`agent_talk/mockups/sidebar2/`), 목업
 * 라운드가 찾아낸 네 장치를 그대로 지킨다:
 *  ① **선이 없다** — 구분선도 카드 테두리도 없고, 행은 여백으로만 나뉜다. 테두리를 갖는 것은
 *     선택된 줄 하나뿐이다(선은 정보가 아닌데 정보처럼 눈에 걸린다).
 *  ② **크기 대신 명도** — 두 줄이 1.5px 안쪽이다. 2번째 줄을 조용하게 만들려고 작게 만들지
 *     않는다. 크기로 층을 만들면 줄마다 높이가 흔들려 목록이 울퉁불퉁해진다.
 *  ③ **경과는 오른쪽 열** — 문장의 일부가 아니라 세로로 훑히는 열이다. 라틴으로 써서
 *     `--fs-nano` 를 합법으로 만든다(store/aiWorkbench.ts 의 `agoText`).
 *  ④ **줄바꿈 없이 잘라낸다** — 묶음 안에서 줄 높이가 완전히 일정해야 한다.
 *
 * ⚠️ **묶음 축만 실물과 다르다.** Orca 는 `고정/진행 중`으로 묶는데 우리가 그대로 옮기면
 * `대기 중` 한 줄이 진행 중 묶음 열두 번째에 파묻힌다. 저쪽이 안 아쉬운 이유는 **그 제품에
 * 대기 상태가 없기 때문**이다 — 에이전트가 묻지 않는다. 우리는 묻는다.
 */

/**
 * 점 하나가 말하는 것. 색은 **상태에만** 쓴다(서버·CLI 는 글자다).
 *  · 초록 = 돌고 있다 · 노랑 = **나를 기다린다**(훅이 그렇게 말했다) · 회색 = 안 돌고 있다
 *  · 빨강 = 끊김(폴더나 서버가 사라졌다) — 조용히 다른 데서 열지 않는다
 *
 * ⚠️ `확인 불가` 에 **점선을 쓰지 않는다.** 7px 원의 점선은 점 네댓 개로 뭉개져 "약간 부드러운
 * 점"이 될 뿐이다. 속 빈 원만 쓰고, 구별은 **묶음 머리의 글자**가 진다(묶음이 늘 켜져 있으므로
 * 그 구별은 공짜다).
 */
const DOT: Record<WorkbenchStatus, string> = {
  live: 'ok',
  quiet: 'warn',
  idle: 'off',
  noPath: 'bad',
  noProfile: 'bad'
}

const TIP: Record<WorkbenchStatus, string> = {
  live: 'bench.st.live',
  quiet: 'bench.st.quiet',
  idle: 'bench.st.idle',
  noPath: 'bench.st.noPath',
  noProfile: 'bench.st.noProfile'
}

/** 도는 세션의 점·툴팁은 **훅이 말한 것**이 진다. 복원 판정(위 표)은 안 도는 줄의 몫이다. */
const STATE_DOT: Record<AgentState, string> = {
  working: 'ok',
  waiting: 'warn',
  done: 'off',
  unverifiable: 'unk'
}

const STATE_TIP: Record<AgentState, string> = {
  working: 'bench.st.working',
  waiting: 'bench.st.waiting',
  done: 'bench.st.done',
  unverifiable: 'bench.st.unverifiable'
}

/**
 * ⚠️ 도는 세션에 복원 판정을 그리면 **모르는 것이 초록으로 나간다**(훅 없는 CLI 는 늘
 * `unverifiable` 인데 `status` 는 그때도 `live` 다). 갈리는 자리를 여기 한 줄로 모은다.
 */
function look(r: WorkbenchRow): { dot: string; tip: string } {
  if (r.sessionId) return { dot: STATE_DOT[r.state], tip: STATE_TIP[r.state] }
  return { dot: DOT[r.status], tip: TIP[r.status] }
}

const GROUP_LABEL: Record<BenchGroupId, string> = {
  waiting: 'bench.g.waiting',
  working: 'bench.g.working',
  done: 'bench.g.done',
  unverifiable: 'bench.g.unverifiable',
  idle: 'bench.g.idle'
}

/** 경과 열이 다시 그려지는 주기. `12s` 를 초 단위로 쓰기로 한 이상 1초가 그 값이다. */
export const AGO_TICK_MS = 1_000

/**
 * 지금 시각. **패널이 보일 때만 돈다** — [연결]·[파일] 을 보고 있는 동안 1초마다 사이드바를
 * 다시 그릴 이유가 없다(세 패널이 전부 마운트된 채로 산다).
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), AGO_TICK_MS)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function AiBenchTree({
  rows,
  active,
  activeSessionId,
  onOpen,
  onRemove,
  onSplit
}: {
  rows: WorkbenchRow[]
  /** 이 패널이 지금 보이나 — 경과 열의 시계가 여기 걸린다. */
  active: boolean
  activeSessionId: string | null
  /** 살아 있으면 그 탭으로, 아니면 그 자리에서 다시 띄운다. */
  onOpen: (s: AiSessionState, sessionId: string | null) => void
  onRemove: (s: AiSessionState) => void
  /** #133 세션 분리 — 같은 저장소를 형제 폴더에 새 브랜치로 펼친다. */
  onSplit: (s: AiSessionState) => void
}): JSX.Element {
  const now = useNow(active)
  // 접힘은 화면의 기분이라 영속화하지 않는다 — 껐다 켜면 `끝남` 은 다시 접혀 있다.
  const [folded, setFolded] = useState<ReadonlySet<BenchGroupId>>(() => new Set(GROUP_FOLDED))

  if (rows.length === 0) {
    return <div className="bench-empty">{t('bench.empty')}</div>
  }
  const toggle = (id: BenchGroupId): void =>
    setFolded((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <div className="bench-list">
      {groupRows(rows).map((g) => {
        const shut = folded.has(g.id)
        const label = t(GROUP_LABEL[g.id])
        return (
          <div key={g.id} className="bench-group" data-group={g.id}>
            {/* 묶음 머리는 **늘 켜져 있다**(실물과 같다). 선 없이 여백과 낮은 명도로만 선다. */}
            <button
              type="button"
              className={'bench-sec' + (shut ? ' shut' : '')}
              aria-expanded={!shut}
              onClick={() => toggle(g.id)}
            >
              <ChevronDown />
              <span className="k">{label}</span>
              <span className="n">{g.rows.length}</span>
              {/* 큰 묶음 하나는 결국 평평한 목록이다 — 무슨 차례로 서 있는지 말해 준다. */}
              {g.id === 'working' && <span className="hint">{t('bench.g.stuck')}</span>}
            </button>
            {/* 접힌 묶음은 **안 그린다**(숨기는 것이 아니다) — 개수는 머리의 알약이 이미
                말하고, DOM 에 남겨 두면 "보이지 않는 줄"이 목록 검사에 섞인다. */}
            <div className="bench-rows" role="list" aria-label={label}>
              {!shut &&
                g.rows.map((r) => {
                  const dead = r.status === 'noPath' || r.status === 'noProfile'
                  const { dot, tip } = look(r)
                  return (
                    <div
                      key={r.s.id}
                      role="listitem"
                      className={
                        'bench-row' +
                        (r.depth === 1 ? ' child' : '') +
                        (r.sessionId && r.sessionId === activeSessionId ? ' on' : '') +
                        (dead ? ' dead' : '')
                      }
                      data-bench={r.s.id}
                      data-status={r.status}
                      data-state={r.state}
                      onDoubleClick={() => !dead && onOpen(r.s, r.sessionId)}
                    >
                      <button
                        type="button"
                        className="bench-name"
                        disabled={dead}
                        title={`${r.s.cwd}\n${t(tip)}`}
                        onClick={() => onOpen(r.s, r.sessionId)}
                      >
                        <span className="l1">
                          <span className={'bench-dot ' + dot} title={t(tip)} />
                          <span className="t">{r.s.title}</span>
                          <span className="ago">{agoText(now - r.since)}</span>
                        </span>
                        <span className="l2">
                          {/* 서버는 **행 안의 글자**다 — 트리 노드로 만들면 목록이 두 겹이 된다. */}
                          <span className="chip">{r.serverName}</span>
                          <span className="cli">{r.s.engine}</span>
                          {/* 분리 세션은 브랜치가 곧 그 세션의 정체다 — 폴더 이름만으론 형제들이 구분되지 않는다. */}
                          {r.s.worktree && <span className="br">{r.s.worktree.branch}</span>}
                          {/* 켜져 있으면 **늘 보인다**(설계 §6 확정 2) — 잊게 두지 않는다. */}
                          {r.s.skipPerms && <span className="skip">{t('bench.skipPerms')}</span>}
                        </span>
                      </button>
                      {/* 액션은 **2번째 줄 오른쪽**에 얹힌다(실물과 같다). 1번째 줄 오른쪽 끝은
                        경과 열의 자리라, 여기를 흐름에 넣으면 액션이 있는 줄과 없는 줄의 경과가
                        서로 다른 x 에 서서 **그 열이 무너진다**(목업이 찾은 장치 ③).
                        훅만 보고 세운 줄에는 지울 것도 분리할 것도 없다 — 목록에 적립된 적이
                        없고, 그 세션이 끝나면 줄도 함께 사라진다. */}
                      {r.saved && (
                        <span className="bench-acts">
                          {/* 분리 세션에서 또 분리하지 않는다 — worktree 의 worktree 는 git 이 허용해도
                            부모·자식 관계가 두 단이 되어 지울 때 무엇이 딸려 가는지 알기 어려워진다.
                            ⑂(U+2442)는 Pretendard·나눔고딕코딩 어디에도 없어 두부가 될 수 있던 자리다 —
                            분기 = git worktree 이므로 GitBranch 가 뜻까지 맞는다. */}
                          {!r.s.worktree && !dead && (
                            <button
                              type="button"
                              className="bench-x"
                              title={t('bench.split')}
                              onClick={() => onSplit(r.s)}
                            >
                              <GitBranch />
                            </button>
                          )}
                          <button
                            type="button"
                            className="bench-x"
                            title={t('bench.remove')}
                            onClick={() => onRemove(r.s)}
                          >
                            <X />
                          </button>
                        </span>
                      )}
                    </div>
                  )
                })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
