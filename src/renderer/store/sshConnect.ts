/**
 * SSH 접속의 **되묻는 절차** — 창이 둘이어도 한 벌만 둔다(#201 A).
 *
 * 여기 있는 것은 `connect()` 가 실패로 돌려준 사유를 보고 **사람에게 물어 다시 시도하는** 부분뿐이다:
 * 호스트키 첫 접속이면 지문을 보여 주고 승낙을 받고, 저장된 비밀번호가 없으면 그 자리에서 받는다.
 * 그 밖의 실패는 주입받은 `showFailure` 에 넘긴다.
 *
 * 왜 떼어냈나: 이 절차는 `Shell.connectProfile` 안에만 있었다. 떼어낸 창에 재접속·복제를 배선하려면
 * 같은 것을 또 써야 하는데, 그러면 #201 이 잡으려는 바로 그 병(같은 일을 하는 길이 둘인데 한쪽만
 * 온전한 것)을 우리가 새로 만든다. `putty 로는 되는데 우리 앱은 안 된다`(2026-09-16 준영님 제보)가
 * 정확히 그 병이었다 — putty 는 물어보고 우리는 안 물어봤다.
 *
 * ⚠️ **여기 없는 것**은 전부 "창마다 다른 것"이다: RDP 분기 · `adopt` · 화면 초점 · 접속 후
 *    [파일] 탭으로 넘기기 · 실패 안내의 갈래(본창은 실패 후 연결 관리자를 열 수 있고 떼어낸 창은
 *    그 창이 없다). 그래서 `showFailure` 가 주입이다 — **같은 것(되묻는 순서)만 공유한다.**
 */
import type { SshConnectResult } from '@shared/ipc'
import type { ConnectionProfile } from '@shared/types'
import type { AiCommand } from '@shared/aiCli'
import type { DialogResult, DialogSpec } from '../components/Dialog'
import type { ConnectFailure } from './profiles'
import { t } from '../i18n'

export type ConnectDeps = {
  /** `useProfiles().connect` 그대로 — 인자 순서도 같다(여기서 새 모양을 만들지 않는다). */
  connect: (
    profileId: string,
    acceptHostKey?: boolean,
    password?: string,
    size?: { cols: number; rows: number },
    aiCommand?: { argv: AiCommand; cwd: string },
    winId?: string
  ) => Promise<SshConnectResult>
  lookup: (id: string) => Promise<ConnectionProfile | undefined>
  ask: (spec: DialogSpec) => Promise<DialogResult>
  askText: (spec: DialogSpec & { input: NonNullable<DialogSpec['input']> }) => Promise<string | null>
  /** 마지막 수단 안내. Shell 은 [다시 입력]·[호스트키 재설정] 갈래가 있는 제 것을 준다. */
  showFailure: (profileId: string, res: ConnectFailure) => Promise<void>
}

export type ConnectOk = { ok: true; id: string; title?: string }

export type ConnectOpts = {
  acceptHostKey?: boolean
  password?: string
  size?: { cols: number; rows: number }
  aiCommand?: { argv: AiCommand; cwd: string }
  /** 부른 창(F32). 떼어낸 창이 자기 id 를 준다 — 안 주면 본창이다. */
  winId?: string
}

/**
 * 붙는다. 실패하면 **되묻고 다시 붙는다.**
 *
 * 실패 반환에 사유가 없는 이유: 이 함수가 돌아올 때는 **이미 화면으로 말했다**(지문 창 · 비밀번호
 * 창 · `showFailure`). 호출측이 또 말하면 같은 실패를 두 번 말하고, 사용자가 스스로 취소한 것까지
 * "실패했습니다"가 된다. `MainArea` 의 `'shown'` 계약이 같은 말을 한다 —
 * **`{ ok: false }` 는 조용히 넘어가라는 신호다.**
 */
export async function connectWithRecovery(
  deps: ConnectDeps,
  profileId: string,
  opts: ConnectOpts = {}
): Promise<ConnectOk | { ok: false }> {
  const res = await deps.connect(profileId, opts.acceptHostKey, opts.password, opts.size, opts.aiCommand, opts.winId)
  if (res.ok) return { ok: true, id: res.id, ...(res.title ? { title: res.title } : {}) }

  if (res.reason === 'hostKeyNew') {
    const p = await deps.lookup(profileId)
    const r = await deps.ask({
      title: t('conn.hostkey.title'),
      message: t('conn.hostkey.new'),
      detail: [
        { label: t('conn.fail.server'), value: p ? `${p.username}@${res.hostId}` : res.hostId },
        { label: t('conn.hostkey.alg'), value: res.algorithm },
        { label: t('conn.hostkey.fp'), value: res.fingerprint }
      ],
      confirmLabel: t('conn.hostkey.trustBtn'),
      cancelLabel: t('dlg.cancel')
    })
    if (r !== 'confirm') return { ok: false }
    return await connectWithRecovery(deps, profileId, { ...opts, acceptHostKey: true })
  }

  // 저장해 둔 비밀번호가 없다(또는 vault 에서 사라졌다). 예전엔 "연결 관리자에서 다시 입력하세요"로
  // 끝났는데, 그러면 **비밀번호를 저장하지 않고 쓰는 길이 아예 없다**(준영님 제보 18번).
  // 여기서 받아 이번 접속에만 쓴다. 저장은 하지 않는다 — 저장은 연결 관리자의 [저장]이 하는 일이다.
  // 이미 password 를 들고 온 재시도는 이 분기로 다시 오지 않는다(main 이 그 값을 우선한다).
  if (res.reason === 'orphanSecret') {
    const p = await deps.lookup(profileId)
    const pw = await deps.askText({
      title: t('conn.pw.title'),
      message: t('conn.pw.msg'),
      detail: p ? [{ label: t('conn.fail.server'), value: `${p.username}@${p.host}:${p.port}` }] : [],
      input: { placeholder: t('conn.pw.placeholder'), password: true },
      confirmLabel: t('conn.pw.connect'),
      cancelLabel: t('dlg.cancel')
    })
    if (!pw) return { ok: false }
    return await connectWithRecovery(deps, profileId, { ...opts, password: pw })
  }

  await deps.showFailure(profileId, res)
  return { ok: false }
}
