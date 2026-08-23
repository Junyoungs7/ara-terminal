/**
 * 씬 하나에 화면 하나. 키는 narration.json 의 씬 id 와 같다 — 대본과 화면이 한 이름으로 묶인다.
 * 여기 없는 id 는 기본 화면(앱 창)이 나온다. 대본을 늘려도 영상이 깨지지 않게.
 */
import React from 'react'
import { AbsoluteFill, interpolate, staticFile, useCurrentFrame } from 'remotion'
import { C, MONO, UI } from './theme'
import { AppWindow, Caret, Dialog, Keys, Prompt, TitleCard, Typed, useIntro } from './ui'

const PS_ROWS = [
  [4821, 'jun', '62.4', '18.2', 'node /srv/app/server.js --port 3000'],
  [1, 'root', '0.1', '0.3', '/sbin/init splash'],
  [932, 'postgres', '2.7', '9.8', 'postgres: checkpointer'],
  [2210, 'jun', '0.0', '1.1', 'tmux: server']
]
const PS_HEAD = ['PID', '사용자', 'CPU', '메모리', '명령']
const BOTTOM_TABS = ['포트 모니터', '시스템 모니터', '프로세스', '서비스', '디스크', '패키지', '컨테이너', '세션 기록']

const termBuild = (
  <>
    <Prompt />
    <Typed text="npm run build" />
    <Caret />
  </>
)

/** 큰 글자 한 장 — 광고에서 말과 화면이 같은 속도로 가게. */
const Big: React.FC<{ children: React.ReactNode; sub?: string }> = ({ children, sub }) => {
  const t = useIntro()
  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center', padding: '0 160px' }}>
      <div style={{ textAlign: 'center', opacity: t, transform: `translateY(${interpolate(t, [0, 1], [22, 0])}px)` }}>
        <div style={{ color: C.hi, fontSize: 82, fontWeight: 700, letterSpacing: '-.04em', lineHeight: 1.18, wordBreak: 'keep-all' }}>
          {children}
        </div>
        {sub && <div style={{ color: C.lo, fontSize: 32, marginTop: 26 }}>{sub}</div>}
      </div>
    </AbsoluteFill>
  )
}

/** 카드 셋이 차례로 뜬다. */
const Cards: React.FC<{ items: [string, string][] }> = ({ items }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ display: 'flex', flexDirection: 'row', gap: 30, alignItems: 'center', justifyContent: 'center', padding: '0 120px' }}>
      {items.map(([h, b], i) => {
        const t = interpolate(frame, [i * 9, i * 9 + 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        return (
          <div
            key={h}
            style={{
              flex: 1,
              background: C.surface,
              border: `1px solid ${C.line}`,
              borderRadius: 20,
              padding: '36px 32px',
              opacity: t,
              transform: `translateY(${interpolate(t, [0, 1], [26, 0])}px)`
            }}
          >
            <div style={{ color: C.hi, fontSize: 34, fontWeight: 700, marginBottom: 14 }}>{h}</div>
            <div style={{ color: C.lo, fontSize: 24, lineHeight: 1.6, wordBreak: 'keep-all' }}>{b}</div>
          </div>
        )
      })}
    </AbsoluteFill>
  )
}

export const SCENES: Record<string, React.ReactNode> = {
  /* ── 광고 ─────────────────────────────────────────────────────────── */
  ad1: <Big sub="지금 쓰고 계신 그 터미널도 합니다">서버에 붙는 일은<br />어느 터미널이나 합니다</Big>,
  ad2: <Big>아라는 <span style={{ color: C.accent }}>붙은 다음</span>을 바꿉니다</Big>,
  ad3: (
    <AppWindow
      focus="bottom"
      term={termBuild}
      bottom={{ tabs: BOTTOM_TABS, on: '프로세스', head: PS_HEAD, rows: PS_ROWS }}
    />
  ),
  ad4: <Big sub="에이전트도, 데스크톱 환경도 필요 없습니다">서버에는<br /><span style={{ color: C.accent }}>아무것도 설치하지 않습니다</span></Big>,
  ad5: (
    <AppWindow
      focus="term"
      term={
        <>
          <Prompt />
          <span style={{ color: C.hi }}>psql -h db -U app</span>
          {'\n'}
          <span style={{ color: C.err }}>FATAL: password authentication failed for user "app"</span>
          {'\n\n'}
          <span style={{ color: C.dim }}>— 우클릭 → [아라에게 질문] · 첨부에서 </span>
          <span style={{ color: C.warn }}>PGPASSWORD=••••••</span>
          <span style={{ color: C.dim }}> 는 가려서 나갑니다</span>
        </>
      }
    />
  ),
  ad6: (
    <AppWindow
      focus="term"
      chat={
        <>
          <div style={{ color: C.lo, fontSize: 15, marginBottom: 14 }}>아라에게 묻기</div>
          <div style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, fontSize: 17, lineHeight: 1.6, color: C.mid }}>
            비밀번호가 바뀌었는지 확인해 보세요.
            <pre style={{ margin: '12px 0 0', padding: 12, background: C.terminal, borderRadius: 8, color: C.accentBright, fontFamily: MONO, fontSize: 15 }}>
              psql -h db -U app -W
            </pre>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ padding: '7px 14px', borderRadius: 999, border: `1px solid ${C.accentLine}`, color: C.accentBright, fontSize: 14 }}>
                터미널로 보내기
              </span>
              <span style={{ color: C.dim, fontSize: 14 }}>실행은 사람이</span>
            </div>
          </div>
        </>
      }
      term={
        <>
          <Prompt />
          <Typed text="psql -h db -U app -W" delay={20} />
          <Caret />
          {'\n'}
          <span style={{ color: C.dim }}>— 넣어만 뒀습니다. 엔터는 사람이 누릅니다.</span>
        </>
      }
    />
  ),
  ad7: <Cards items={[['탭을 떼어낸다', '크롬처럼 창 밖으로 끌면 새 창. 세션은 끊기지 않습니다.'], ['다시 켜면 그대로', '세션 · 분할 · 작업 폴더까지 복원됩니다.'], ['알아서 최신', '사내 서버에서 받아 두고 다음에 켤 때 적용합니다.']]} />,
  ad8: <TitleCard title="A.R.A" sub="사내 배포 중 · http://192.168.100.56:8899" />,

  /* ── 1. 설치 ──────────────────────────────────────────────────────── */
  in1: (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: C.lo, fontSize: 28, marginBottom: 18 }}>사내 배포 사이트</div>
        <div style={{ color: C.accent, fontSize: 54, fontFamily: MONO }}>http://192.168.100.56:8899</div>
        <div
          style={{
            marginTop: 44,
            display: 'inline-flex',
            gap: 12,
            alignItems: 'center',
            padding: '18px 34px',
            borderRadius: 999,
            background: C.accent,
            color: '#1a1512',
            fontSize: 28,
            fontWeight: 700
          }}
        >
          ⤓ Windows용 다운로드
        </div>
      </div>
    </AbsoluteFill>
  ),
  in2: <Dialog title="A.R.A 설치" body="설치 경로를 고를 수 있습니다." rows={[['설치 위치', 'C:\\Program Files\\A.R.A']]} confirm="설치" />,
  in3: <Dialog title="Windows의 PC 보호" body="알 수 없는 게시자입니다. [추가 정보] → [실행]" confirm="실행" />,
  in4: (
    <Big sub="반복 시도는 계정 잠금으로 이어질 수 있습니다">
      보안 프로그램이 막으면<br /><span style={{ color: C.err }}>다시 시도하지 마세요</span>
    </Big>
  ),
  in5: <AppWindow focus="tabs" term={<><Prompt host="jun@내PC" path="C:\\work" /><Caret /></>} />,

  /* ── 2. 연결 ──────────────────────────────────────────────────────── */
  cn1: <AppWindow focus="sidebar" term={termBuild} />,
  cn2: (
    <Dialog
      title="새 연결"
      rows={[
        ['연결 이름', 'dev-server'],
        ['호스트', '192.168.100.56'],
        ['포트', '22'],
        ['사용자', 'jun'],
        ['인증', '비밀번호 / 공개키']
      ]}
      confirm="저장 후 접속"
    />
  ),
  cn3: (
    <Dialog
      title="호스트키 확인"
      body="이 서버의 호스트키를 처음 봅니다. 지문이 예상과 같은지 확인한 뒤 신뢰하세요."
      rows={[
        ['알고리즘', 'ssh-ed25519'],
        ['지문 (SHA256)', 'kM3d…7Qf1']
      ]}
      confirm="신뢰"
    />
  ),
  cn4: <AppWindow focus="sidebar" term={<><Prompt /><Typed text="uptime" /><Caret /></>} />,
  cn5: (
    <Cards
      items={[
        ['비밀번호', 'Windows 자격 증명에 저장됩니다.'],
        ['설정 파일', 'workspace.json 에는 남지 않습니다.'],
        ['저장 안 한 서버', '접속할 때 묻고, 그 접속에만 씁니다.']
      ]}
    />
  ),

  /* ── 3. 파일 ──────────────────────────────────────────────────────── */
  fl1: <AppWindow focus="sidebar" term={termBuild} />,
  fl2: (
    <AppWindow
      focus="sidebar"
      side={[
        { name: 'dev-server', on: true, dot: C.ok },
        { name: '~/data/logs', indent: true },
        { name: 'app-2026-08-23.log', indent: true },
        { name: 'nginx', indent: true }
      ]}
      term={
        <>
          <Prompt />
          <Typed text="cd ~/data/logs" />
          <Caret />
        </>
      }
    />
  ),
  fl3: (
    <>
      <AppWindow focus="win" term={termBuild} />
      <Keys keys={['Ctrl', 'Shift', 'O']} />
    </>
  ),
  fl4: (
    <AppWindow
      focus="bottom"
      term={termBuild}
      bottom={{
        tabs: ['전송'],
        on: '전송',
        head: ['파일', '방향', '진행', '크기'],
        rows: [
          ['vgt-erp-1.4.2.tar.gz', '내 PC → dev-server', '63%', '68.0 MB'],
          ['application-prod.yml', '내 PC → dev-server', '완료', '4 KB'],
          ['dump.sql', 'dev-server → kvt-gpu', '대기', '1.2 GB']
        ]
      }}
    />
  ),
  fl5: (
    <AppWindow
      focus="term"
      term={
        <>
          <span style={{ color: C.dim }}>{'// application-prod.yml — 원격 파일을 그대로 편집합니다\n'}</span>
          <span style={{ color: C.info }}>server:</span>
          {'\n  port: '}
          <span style={{ color: C.accentBright }}>8080</span>
          {'\n'}
          <span style={{ color: C.info }}>spring:</span>
          {'\n  profiles: '}
          <span style={{ color: C.accentBright }}>prod</span>
          {'\n\n'}
          <span style={{ color: C.ok }}>저장하면 그대로 서버에 올라갑니다</span>
        </>
      }
    />
  ),

  /* ── 4. 서버 도구 ─────────────────────────────────────────────────── */
  tl1: <AppWindow focus="rail" term={termBuild} bottom={{ tabs: BOTTOM_TABS, on: '프로세스', head: PS_HEAD, rows: PS_ROWS }} />,
  tl2: <AppWindow focus="bottom" term={termBuild} bottom={{ tabs: BOTTOM_TABS, on: '프로세스', head: PS_HEAD, rows: PS_ROWS }} />,
  tl3: (
    <AppWindow
      focus="bottom"
      term={termBuild}
      bottom={{
        tabs: BOTTOM_TABS,
        on: '서비스',
        head: ['유닛', '상태', '부팅 시', '설명'],
        rows: [
          ['nginx.service', 'running', 'enabled', '웹 서버'],
          ['postgresql.service', 'running', 'enabled', '데이터베이스'],
          ['vgt-erp.service', 'running', 'enabled', '업무 시스템'],
          ['backup.timer', 'waiting', 'enabled', '야간 백업']
        ]
      }}
    />
  ),
  tl4: <Big sub="이미 열려 있는 연결로 표준 명령을 대신 실행할 뿐입니다">서버에 남는 것은<br /><span style={{ color: C.accent }}>없습니다</span></Big>,
  tl5: (
    <Dialog
      title="프로세스를 종료할까요?"
      body="node /srv/app/server.js --port 3000 (PID 4821)"
      rows={[['보낼 신호', 'SIGTERM']]}
      confirm="종료"
    />
  ),

  /* ── 5. AI ────────────────────────────────────────────────────────── */
  ai1: (
    <Dialog
      title="설정 · AI"
      rows={[
        ['프로바이더', 'Anthropic / OpenAI / 호환 엔드포인트'],
        ['사내 서버', 'http://…:8000/v1'],
        ['API 키', '•••••••••••• (자격 증명에 저장)']
      ]}
      confirm="저장"
    />
  ),
  ai2: (
    <>
      <AppWindow
        focus="win"
        term={termBuild}
        chat={
          <>
            <div style={{ color: C.lo, fontSize: 15, marginBottom: 14 }}>아라에게 묻기</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
              {['선택한 출력', '현재 폴더', '세션 기록'].map((c, i) => (
                <span
                  key={c}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 999,
                    fontSize: 14,
                    border: `1px solid ${i < 2 ? C.accentLine : C.line}`,
                    color: i < 2 ? C.accentBright : C.lo,
                    background: i < 2 ? C.glow : C.overlay
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
            <div style={{ color: C.dim, fontSize: 15 }}>무엇을 함께 보낼지 고릅니다</div>
          </>
        }
      />
      <Keys keys={['Alt', 'A']} />
    </>
  ),
  ai3: (
    <AppWindow
      focus="term"
      term={
        <>
          <Prompt />
          <span style={{ color: C.hi }}>tail -n 3 /var/log/app.log</span>
          {'\n'}
          <span style={{ background: C.glow, color: C.hi }}>ERROR 2026-08-23 14:02:13 slow query 812ms — /api/tour</span>
          {'\n'}
          <span style={{ color: C.dim }}>— 선택 → 우클릭 → [아라에게 질문]</span>
        </>
      }
    />
  ),
  ai4: (
    <Dialog
      title="이렇게 보냈습니다"
      body="첨부한 내용에서 비밀처럼 보이는 값은 가려서 나갔습니다."
      rows={[
        ['PGPASSWORD', '••••••'],
        ['Authorization', 'Bearer ••••••'],
        ['서버 이름', 'dev-server (그대로)']
      ]}
      confirm="닫기"
    />
  ),
  ai5: (
    <AppWindow
      focus="term"
      term={
        <>
          <Prompt />
          <Typed text="EXPLAIN ANALYZE SELECT * FROM tour WHERE city_id = 12;" delay={12} cps={30} />
          <Caret />
          {'\n'}
          <span style={{ color: C.dim }}>— [터미널로 보내기]는 넣기만 합니다. 엔터는 사람이.</span>
        </>
      }
    />
  ),

  /* ── 6. 창·세션 ───────────────────────────────────────────────────── */
  wn1: (
    <>
      <AppWindow focus="term" term={termBuild} />
      <Keys keys={['Ctrl', 'Shift', '\\']} />
    </>
  ),
  wn2: (
    <>
      <AppWindow focus="term" term={termBuild} />
      <Keys keys={['Alt', '←', '→']} />
    </>
  ),
  wn3: <AppWindow focus="tabs" term={termBuild} />,
  wn4: (
    <Cards
      items={[
        ['세션', '열려 있던 탭이 그대로 살아납니다.'],
        ['분할 배치', '나눠 둔 칸의 크기까지 같습니다.'],
        ['작업 폴더', '있던 자리에서 다시 시작합니다.']
      ]}
    />
  )
}

/**
 * 큰 글자만 있는 씬 — **자막을 겹쳐 쓰지 않는다.** 같은 문장이 화면에 두 번 나오면 읽는 눈이
 * 어디를 봐야 할지 모른다(첫 렌더에서 실제로 그렇게 보였다).
 */
export const TEXT_ONLY = new Set(['ad1', 'ad2', 'ad4', 'ad8', 'in4', 'tl4'])

export const fallbackScene = <AppWindow term={termBuild} />
