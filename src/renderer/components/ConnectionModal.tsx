import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile, ProfileInput } from '@shared/types'
import { connDotClass, type ConnState } from '../store/profiles'
import { Dropdown } from './Dropdown'
import { matchProfile } from '../store/groups'
import { t } from '../i18n'
import { IconClose } from './icons'
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

const emptyForm: Form = {
  type: 'ssh',
  name: '',
  host: '',
  port: '22',
  username: '',
  authType: 'key',
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

  const selectProfile = (p: ConnectionProfile) => {
    setSelectedId(p.id)
    setForm(formFrom(p))
    setError('')
  }

  const newProfile = () => {
    setSelectedId(null)
    setForm(emptyForm)
    setError('')
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

  const saveAndConnect = async () => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setError(t('conn.err.required'))
      return
    }
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
          <span className="x" onClick={onClose}>
            <IconClose />
          </span>
        </div>
        <div className="modal-body">
          <div className="prof-list" onContextMenu={(e) => openRowMenu(e, null)}>
            <div className="pl-hd">
              <span>
                {t('conn.profiles')} · {profiles.length}
              </span>
              <span className="kbd" title={t('conn.new')} onClick={newProfile}>
                ＋
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
                  <input
                    type="password"
                    value={form.secret}
                    placeholder={form.id ? t('conn.secret.keep') : t('conn.rdp.secret.optional')}
                    onChange={(e) => setForm({ ...form, secret: e.target.value })}
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
                  <div className="seg-ctl">
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
                      <input
                        type="password"
                        value={form.secret}
                        placeholder={form.id ? t('conn.secret.keep') : ''}
                        onChange={(e) => setForm({ ...form, secret: e.target.value })}
                      />
                    </div>
                  </>
                ) : (
                  <div className="fld col-2">
                    <label>{t('conn.field.password')}</label>
                    <input
                      type="password"
                      value={form.secret}
                      placeholder={form.id ? t('conn.secret.keep') : ''}
                      onChange={(e) => setForm({ ...form, secret: e.target.value })}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        <div className="modal-ft">
          {error ? <span className="err">{error}</span> : <span className="hint">⏎ {t('conn.saveConnect')}</span>}
          <span className="sp" />
          <button className="btn sec" onClick={onClose}>
            {t('conn.cancel')}
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
