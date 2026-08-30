import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { ConnectionProfile, ProfileInput } from '@shared/types'
import { connDotClass, type ConnState } from '../store/profiles'
import { Dropdown } from './Dropdown'
import { matchProfile } from '../store/groups'
import { t } from '../i18n'
import { IconClose } from './icons'
import { PasswordInput } from './PasswordInput'
import { ContextMenu } from '../interactions/ContextMenu'
import { treeMenu } from '../interactions/actions'

// 모달을 어떤 상태로 열지. 트리 "정보 수정"→select, 그룹 "새 연결"→new(그룹 기본값), 그 외 null.
export type ConnModalRequest =
  | { mode: 'select'; profileId: string }
  | { mode: 'new'; group?: string }
  | null

// 폼 상태(목업 우측 .prof-form). secret은 저장 시에만 전송되고 화면엔 보관하지 않는다.
// W4sat F21: type='rdp' 이면 authType/keyPath/secret 은 화면에서 숨고 저장에도 실리지 않는다.
type Form = {
  id?: string
  type: 'ssh' | 'rdp'
  name: string
  host: string
  port: string
  username: string
  authType: 'key' | 'password'
  keyPath: string
  group: string
  secret: string
}

export const emptyForm: Form = {
  type: 'ssh',
  name: '',
  host: '',
  port: '22',
  username: '',
  // **2026-08-21: 기본을 비밀번호로 바꿨다.** 준영님 제보 30번("신규 서버 등록시 비밀번호가 전부
  // 틀리대")의 원인이 이 한 줄이었다. 기본이 'key' 라 신규 프로필의 인증 섹션은 [개인키] + 그 아래
  // **패스프레이즈** 칸으로 열렸고, 거기에 서버 비밀번호를 넣으면 없는 키 파일(~/.ssh/id_ed25519)로
  // 인증을 시도하며 그 값은 cfg.passphrase 로 들어간다 → 항상 실패. "다른 툴로는 되는데"가 그래서다.
  // 사내 서버는 대부분 비밀번호 인증이고, 키를 쓰는 사람은 방식을 바꿀 줄 안다.
  authType: 'password',
  keyPath: '~/.ssh/id_ed25519',
  // R6: 그룹 기본값은 없음(빈 값 = "기타"). 개발/운영 두 이름을 앱이 정해 주던 자리다.
  group: '',
  secret: ''
}

function formFrom(p: ConnectionProfile): Form {
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    host: p.host,
    port: String(p.port),
    username: p.username,
    authType: p.type === 'ssh' ? p.auth.type : 'key',
    keyPath: p.type === 'ssh' && p.auth.type === 'key' ? p.auth.keyPath : '',
    group: p.group ?? '',
    secret: '' // 비밀은 vault에만 — 편집 시 빈 값(미입력 시 기존 비밀 유지)
  }
}

// SSH↔RDP 전환 시 기본 포트가 그대로 남으면 사용자가 잊고 넘어가기 쉽다(22 로 RDP 접속 시도 등) —
// 기본값 그대로일 때만 상대측 기본값으로 바꿔준다(직접 입력한 포트는 건드리지 않는다).
function portForType(currentPort: string, currentType: Form['type'], nextType: Form['type']): string {
  if (nextType === currentType) return currentPort
  if (nextType === 'rdp' && currentPort === '22') return '3389'
  if (nextType === 'ssh' && currentPort === '3389') return '22'
  return currentPort
}

function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

type Props = {
  open: boolean
  request: ConnModalRequest
  profiles: ConnectionProfile[]
  // R6: 그룹 콤보 선택지(트리와 같은 목록 — 빈 그룹 포함, 이름순).
  groups: string[]
  /** 서버별 연결 상태 — 목록의 상태 점에 쓴다. 트리와 같은 값을 받아 같은 색을 그린다. */
  conn?: ConnState
  onClose: () => void
  onSave: (input: ProfileInput) => Promise<ConnectionProfile>
  // Shell 의 connectProfile — 호스트키 확인·실패 다이얼로그까지 처리하고 성공 여부만 돌려준다
  // (모달이 같은 분기를 다시 구현하지 않는다).
  onConnect: (profileId: string) => Promise<boolean>
  // FB-ui2 추가 지시(2026-08-05): 좌측 프로필 목록 우클릭 [복제]/[삭제]. Shell 이 사이드바 트리의
  // server.duplicate/server.delete 와 같은 CRUD 경로(save/remove)를 재사용해 구현한 걸 그대로 받는다
  // — 이 컴포넌트가 직접 vault·IPC 를 만지지 않는다. onDelete 는 확인 다이얼로그까지 포함해서 온다.
  onDuplicate: (p: ConnectionProfile) => Promise<ConnectionProfile>
  onDelete: (p: ConnectionProfile) => Promise<void>
}

// 연결 관리자 모달 (design-system §5.3, 목업 variant-final-3.html 919행~). 좌:프로필 리스트 / 우:폼.
export function ConnectionModal({ open, request, profiles, groups, conn, onClose, onSave, onConnect, onDuplicate, onDelete }: Props) {
  const [form, setForm] = useState<Form>(emptyForm)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string>('')
  const [busy, setBusy] = useState(false)
  // [접속 테스트]·[저장] 결과 한 줄. error 와 자리를 나눠 쓰지 않는다 — 성공을 빨간 오류 자리에
  // 띄우면 실패로 읽힌다.
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)
  // R6: 프로필 리스트 필터(트리 검색과 같은 규칙 — 이름·호스트·그룹).
  const [query, setQuery] = useState('')
  // FB-ui2: 프로필 행 우클릭 메뉴 좌표 + 대상(null = 빈 영역 → [새 프로필]만).
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; profileId: string | null } | null>(null)
  // 이번 "열림" 사이클에서 초기 선택을 이미 했는지. 이 가드가 없으면 selectedId 를 null 로 만드는
  // 신규 프로필(＋) 클릭이 곧바로 첫 프로필로 되돌려져 두 번째 프로필을 만들 수 없다(2026-08-03 발견).
  const initedRef = useRef(false)
  // #70(2026-08-14): 열릴 때 첫 칸에 커서를 둔다. 서버에 붙는 것이 이 앱의 첫 동작인데 마우스로
  // 칸을 찍어야 시작할 수 있었다(AI CLI 모달·확인 다이얼로그는 원래 포커스를 준다).
  const nameRef = useRef<HTMLInputElement>(null)

  // #70: 열리면 이름 칸으로 커서를 옮긴다. 폼 초기화가 끝난 뒤여야 하므로 한 프레임 뒤에 준다
  // (SmartPalette 가 쓰던 것과 같은 방식 — 등장 애니메이션 중 focus 는 스크롤을 튀게 한다).
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => nameRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // 모달이 열릴 때 1회만 초기 상태 결정: 요청(수정/그룹 신규) 우선, 없으면 첫 프로필.
  useEffect(() => {
    if (!open) {
      initedRef.current = false
      return
    }
    if (initedRef.current) return
    initedRef.current = true
    setError('')
    setResult(null)
    setQuery('')
    if (request?.mode === 'new') {
      setSelectedId(null)
      setForm({ ...emptyForm, group: request.group ?? emptyForm.group })
      return
    }
    const target =
      request?.mode === 'select' ? profiles.find((p) => p.id === request.profileId) : profiles[0]
    if (target) {
      setSelectedId(target.id)
      setForm(formFrom(target))
    } else {
      setSelectedId(null)
      setForm(emptyForm)
    }
  }, [open, profiles, request])

  // ESC로 닫기(a11y MVP).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  // 다른 프로필로 옮기면 앞 프로필의 테스트 결과는 무효다 — 남겨 두면 이 서버의 결과로 읽힌다.
  const selectProfile = (p: ConnectionProfile) => {
    setSelectedId(p.id)
    setForm(formFrom(p))
    setError('')
    setResult(null)
  }

  const newProfile = () => {
    setSelectedId(null)
    setForm(emptyForm)
    setError('')
    setResult(null)
  }

  // FB-ui2: 프로필 행 우클릭 — 빈 영역은 profileId=null([새 프로필]만 뜬다).
  const openRowMenu = (e: React.MouseEvent, profileId: string | null) => {
    e.preventDefault()
    e.stopPropagation()
    setRowMenu({ x: e.clientX, y: e.clientY, profileId })
  }

  // [복제]/[삭제]/[정보 수정]/[새 프로필] — 트리 우클릭이 쓰는 것과 같은 id(server.edit 등)를
  // 그대로 받는다(interactions/actions.tsx TREE_MENUS.connRow 참고, 새 액션 id 아님).
  const onRowMenuPick = async (id: string) => {
    const target = rowMenu?.profileId ? profiles.find((x) => x.id === rowMenu.profileId) : undefined
    setRowMenu(null)
    if (id === 'profile.new') {
      newProfile()
      return
    }
    if (!target) return
    if (id === 'server.edit') {
      selectProfile(target)
    } else if (id === 'server.duplicate') {
      const copy = await onDuplicate(target)
      selectProfile(copy)
    } else if (id === 'server.delete') {
      await onDelete(target)
      // 지금 편집 중이던 프로필이 지워졌으면 폼을 비운다(존재하지 않는 id 를 들고 있지 않게).
      if (selectedId === target.id) newProfile()
    }
  }

  const toInput = (): ProfileInput => ({
    id: form.id,
    type: form.type,
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port) || (form.type === 'rdp' ? 3389 : 22),
    username: form.username.trim(),
    // rdp는 인증 필드 자체가 없다(ProfileStore가 무시한다) — 그래도 형만 채워 보낸다.
    authType: form.authType,
    keyPath: form.type === 'ssh' && form.authType === 'key' ? form.keyPath.trim() : undefined,
    // 빈 그룹명은 저장하지 않는다 — 그룹 없음(트리의 "기타")과 같은 뜻이다.
    group: form.group.trim() || undefined,
    // rdp 도 비밀번호를 저장한다(2026-08-07) — 빈 값은 "그대로 두기"라 보내지 않는다.
    secret: form.secret !== '' ? form.secret : undefined
  })

  // 폼 어디서든 Enter → 저장하고 접속. 텍스트 칸만 대상이다(체크박스·버튼에서 Enter 를 가로채면
  // 그 컨트롤의 기본 동작을 빼앗는다). 조합 중(한글 IME)일 때는 확정 Enter 이므로 보내지 않는다.
  const onFormKeyDown = (e: React.KeyboardEvent): void => {
    e.stopPropagation() // 터미널로 키가 새지 않게(기존 규칙)
    if (e.key !== 'Enter' || busy) return
    const el = e.target as HTMLElement
    if (el.tagName !== 'INPUT' || (el as HTMLInputElement).type === 'checkbox') return
    if ('isComposing' in e.nativeEvent && (e.nativeEvent as KeyboardEvent).isComposing) return
    e.preventDefault()
    void saveAndConnect()
  }

  // 필수 칸 검사 — 세 버튼이 모두 이 문을 지난다.
  const missingRequired = (): boolean => {
    if (form.name.trim() && form.host.trim() && form.username.trim()) return false
    setError(t('conn.err.required'))
    return true
  }

  const saveAndConnect = async () => {
    if (missingRequired()) return
    setBusy(true)
    setError('')
    try {
      const saved = await onSave(toInput())
      setSelectedId(saved.id)
      setForm((f) => ({ ...f, id: saved.id, secret: '' }))
      // 호스트키 확인·실패 사유 표시는 Shell 의 커스텀 다이얼로그가 담당한다.
      if (await onConnect(saved.id)) onClose()
      else setError(t('conn.connectFailed'))
    } finally {
      setBusy(false)
    }
  }

  // [저장] — 접속하지 않고 저장만. 창은 열어 둔다(연달아 여러 서버를 등록하는 흐름이라
  // 저장할 때마다 창이 닫히면 다시 열어야 한다). 저장된 프로필이 폼에 그대로 남는다.
  const saveOnly = async () => {
    if (missingRequired()) return
    setBusy(true)
    setError('')
    try {
      const saved = await onSave(toInput())
      setSelectedId(saved.id)
      setForm((f) => ({ ...f, id: saved.id, secret: '' }))
      setResult({ ok: true, msg: t('conn.saved') })
    } finally {
      setBusy(false)
    }
  }

  // [접속 테스트] — **저장하지 않고** 폼 값으로 붙어 본다. SSH 는 인증까지 확인하고 바로 끊고,
  // RDP 는 서버에 닿는지까지만 본다(비밀번호 검증은 실제 접속과 같은 경로라서 — 그 한계를 문구로 말한다).
  const testConn = async () => {
    if (missingRequired()) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const r = await window.ev.ssh.test(toInput())
      if (r.ok) setResult({ ok: true, msg: t(r.note === 'rdpReachOnly' ? 'conn.test.reachOnly' : 'conn.test.ok') })
      else setResult({ ok: false, msg: t('conn.test.fail.' + r.reason) + (r.message ? ` — ${r.message}` : '') })
    } catch (e) {
      // 조용히 넘어가지 않는다. 2026-08-22 준영님 제보 "접속 테스트 버튼 클릭시 아무 반응 없음" 이
      // 이 자리였다 — 옵셔널 체이닝으로 감싸 두면 preload 가 낡아 test 가 없을 때(앱을 재시작하기
      // 전) 예외가 나고도 화면에는 아무 일도 안 일어난다. 버튼을 눌렀으면 무엇이든 답해야 한다.
      setResult({ ok: false, msg: t('conn.test.fail.network') + ` — ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={'overlay open'} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-hd">
          <div className="mh-ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M7 9l2 2-2 2" />
              <path d="M12 13h5" />
            </svg>
          </div>
          <div>
            <h2>{t('conn.title')}</h2>
            <p>{t('conn.subtitle')}</p>
          </div>
          {/* SVG 는 스크린리더가 읽지 않는다 — 이름은 여기서 준다(닫기 버튼 감사, FINISH-M2). */}
          <button type="button" className="x" aria-label={t('dlg.close')} title={t('dlg.close')} onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="prof-list" onContextMenu={(e) => openRowMenu(e, null)}>
            {/* 2026-08-19: 헤더의 맨 `＋` 글리프를 목록 아래 **라벨 있는 버튼**으로 옮겼다.
                준영님이 "추가 버튼을 만들어 달라"고 하신 것 — 라벨 없는 한 글자는 눌러 보기 전에
                무엇인지 알 수 없었다. 두 자리에 다 두지 않는다(같은 일을 하는 버튼이 290px 칸에
                둘이면 어느 것을 눌러야 하는지가 새 질문이 된다). */}
            <div className="pl-hd">
              <span>
                {t('conn.profiles')} · {profiles.length}
              </span>
            </div>
            <div className="sb-search">
              <div className="field">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.6-3.6" />
                </svg>
                <input
                  type="text"
                  value={query}
                  placeholder={t('conn.search.placeholder')}
                  aria-label={t('conn.search.placeholder')}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </div>
            </div>
            {profiles.filter((p) => matchProfile(p, query)).map((p) => (
              <div
                key={p.id}
                className={'prof' + (p.id === selectedId ? ' sel' : '')}
                onClick={() => selectProfile(p)}
                onContextMenu={(e) => openRowMenu(e, p.id)}
              >
                <span className="pfi">{initial(p.name)}</span>
                <div className="pf-main">
                  <div className="pf-name">
                    {p.name}
                    {p.group && <span className="pf-tag">{p.group}</span>}
                  </div>
                  <div className="pf-host">
                    {p.username}@{p.host}
                  </div>
                </div>
                {/* 2026-08-13 감사: 여기가 var(--idle) 하드코딩이라, 트리에서 초록인 서버가
                    이 화면에서는 늘 회색이었다. 같은 서버가 화면마다 다른 색이면 안 된다. */}
                {/* 2026-08-13 감사: 여기가 var(--idle) 하드코딩이라, 트리에서 초록인 서버가
                    이 화면에서는 늘 회색이었다. 같은 서버가 화면마다 다른 색이면 안 된다. */}
                <span className={'pf-st ' + connDotClass(conn?.[p.id])} />
              </div>
            ))}
            {/* 목록 맨 아래. 칸 전체가 스크롤되므로 sticky 로 바닥에 붙여 둔다 — 서버가 스무 개면
                "아래"가 화면 밖이라 버튼을 찾으러 스크롤해야 한다. */}
            <button type="button" className="pl-add" onClick={newProfile}>
              <Plus /> {t('conn.new')}
            </button>
          </div>
          <div className="prof-form" onKeyDown={onFormKeyDown}>
            {/* W4sat F21: SSH/RDP 타입 선택 — authType 세그먼트와 같은 톤. RDP는 인증 섹션 자체가 없다. */}
            <div className="fld" style={{ marginBottom: 10 }}>
              <label>{t('conn.field.type')}</label>
              <div className="seg-ctl">
                <button
                  type="button"
                  className={form.type === 'ssh' ? 'on' : ''}
                  onClick={() => setForm({ ...form, type: 'ssh', port: portForType(form.port, form.type, 'ssh') })}
                >
                  SSH
                </button>
                <button
                  type="button"
                  className={form.type === 'rdp' ? 'on' : ''}
                  onClick={() => setForm({ ...form, type: 'rdp', port: portForType(form.port, form.type, 'rdp') })}
                >
                  RDP
                </button>
              </div>
            </div>
            <div className="pf-sec-t">{t('conn.section.info')}</div>
            <div className="frm-grid">
              <div className="fld col-2">
                <label>{t('conn.field.name')}</label>
                <input
                  ref={nameRef}
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="fld">
                <label>{t('conn.field.host')}</label>
                <input type="text" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              </div>
              <div className="fld">
                <label>{t('conn.field.port')}</label>
                <input type="text" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
              <div className="fld">
                <label>{t('conn.field.user')}</label>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </div>
              <div className="fld">
                <label>{t('conn.field.group')}</label>
                <Dropdown
                  value={form.group}
                  options={groups}
                  editable
                  placeholder={t('conn.field.group.placeholder')}
                  onChange={(v) => setForm({ ...form, group: v })}
                  ariaLabel={t('conn.field.group')}
                />
              </div>
            </div>
            {/* RDP 는 인증 방식 선택이 없다(비밀번호뿐) — 저장해 두면 접속할 때 입력 화면을 건너뛴다.
                비워 두면 기존 동작대로 접속할 때마다 물어본다. */}
            {form.type === 'rdp' && (
              <>
                <div className="pf-sec-t" style={{ marginTop: 16 }}>
                  {t('conn.section.auth')}
                </div>
                <div className="fld col-2">
                  <label>{t('conn.field.password')}</label>
                  <PasswordInput
                    value={form.secret}
                    placeholder={form.id ? t('conn.secret.keep') : t('conn.rdp.secret.optional')}
                    ariaLabel={t('conn.field.password')}
                    onChange={(v) => setForm({ ...form, secret: v })}
                  />
                </div>
                <div className="pf-hint">{t('conn.rdp.secret.hint')}</div>
              </>
            )}
            {form.type === 'ssh' && (
              <>
                <div className="pf-sec-t" style={{ marginTop: 16 }}>
                  {t('conn.section.auth')}
                </div>
                <div className="fld" style={{ marginBottom: 10 }}>
                  <label>{t('conn.field.authMethod')}</label>
                  {/* 2026-08-22 준영님: [비밀번호]를 앞으로. 기본이 비밀번호가 됐으니(제보 30)
                      켜져 있는 쪽이 왼쪽에 오는 게 맞다 — 세그먼트는 첫 칸을 기본으로 읽는다. */}
                  <div className="seg-ctl">
                    <button
                      type="button"
                      className={form.authType === 'password' ? 'on' : ''}
                      onClick={() => setForm({ ...form, authType: 'password' })}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="4" y="10" width="16" height="10" rx="2" />
                        <path d="M8 10V7a4 4 0 018 0v3" />
                      </svg>
                      {t('conn.auth.password')}
                    </button>
                    <button
                      type="button"
                      className={form.authType === 'key' ? 'on' : ''}
                      onClick={() => setForm({ ...form, authType: 'key' })}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M15 7a4 4 0 11-5.6 3.6L4 16v3h3l1-1h2v-2h2l1.5-1.5A4 4 0 0115 7z" />
                      </svg>
                      {t('conn.auth.key')}
                    </button>
                  </div>
                </div>
                {form.authType === 'key' ? (
                  <>
                    <div className="fld col-2">
                      <label>{t('conn.field.privateKey')}</label>
                      <div className="key-file">
                        <input
                          type="text"
                          value={form.keyPath}
                          onChange={(e) => setForm({ ...form, keyPath: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="fld col-2" style={{ marginTop: 10 }}>
                      <label>{t('conn.field.passphrase')}</label>
                      <PasswordInput
                        value={form.secret}
                        placeholder={form.id ? t('conn.secret.keep') : t('conn.passphrase.placeholder')}
                        ariaLabel={t('conn.field.passphrase')}
                        onChange={(v) => setForm({ ...form, secret: v })}
                      />
                    </div>
                    {/* 2026-08-21: 준영님이 이 칸을 "비밀번호"로 바꿔 달라고 하셨는데, 그러면 제보 30번이
                        영구화된다 — 패스프레이즈는 **키 파일을 푸는 암호**이고 서버 비밀번호가 아니다.
                        이름을 감추는 대신 무엇인지 적었다. 서버 비밀번호는 위 [비밀번호] 방식으로 간다. */}
                    <div className="pf-hint">{t('conn.passphrase.hint')}</div>
                  </>
                ) : (
                  <div className="fld col-2">
                    <label>{t('conn.field.password')}</label>
                    <PasswordInput
                      value={form.secret}
                      placeholder={form.id ? t('conn.secret.keep') : ''}
                      ariaLabel={t('conn.field.password')}
                      onChange={(v) => setForm({ ...form, secret: v })}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        {/* 2026-08-19 준영님: "⏎ 저장 후 접속" 힌트를 뺐다 — 바로 옆 버튼이 같은 말을 하고 있었다.
            Enter 로 제출되는 동작(#70)은 그대로다.
            2026-08-21 준영님: 버튼 하나를 셋으로 갈랐다 — [접속 테스트](저장 안 함) · [저장](접속 안 함) ·
            [저장 후 접속]. 셋을 한 줄에 두면 주된 동작이 안 읽히므로 강조는 마지막 하나만 준다. */}
        <div className="modal-ft">
          {/* [접속 테스트]는 **왼쪽 끝**이다(2026-08-22 준영님). 저장·접속과 성격이 다르다 —
              아무것도 바꾸지 않고 확인만 하는 동작이라 저장하는 버튼들과 섞여 있으면 안 된다. */}
          <button className="btn sec" disabled={busy} onClick={() => void testConn()}>
            {t('conn.test')}
          </button>
          {error ? <span className="err">{error}</span> : null}
          {!error && result ? <span className={result.ok ? 'okmsg' : 'err'}>{result.msg}</span> : null}
          <span className="sp" />
          <button className="btn sec" onClick={onClose}>
            {t('conn.cancel')}
          </button>
          <button className="btn sec" disabled={busy} onClick={() => void saveOnly()}>
            {t('conn.save')}
          </button>
          <button className="btn pri" disabled={busy} onClick={() => void saveAndConnect()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 12l5 5 9-9" />
            </svg>
            {t('conn.saveConnect')}
          </button>
        </div>
      </div>
      {/* FB-ui2 추가 지시: 좌측 프로필 목록 우클릭 메뉴 — 트리·탭바가 쓰는 ContextMenu 그대로 재사용. */}
      <ContextMenu
        open={rowMenu !== null}
        x={rowMenu?.x ?? 0}
        y={rowMenu?.y ?? 0}
        items={treeMenu(rowMenu?.profileId ? 'connRow' : 'connEmpty')}
        onPick={(id) => void onRowMenuPick(id)}
        onClose={() => setRowMenu(null)}
      />
    </div>
  )
}
