/**
 * 2.1 음성 IPC — 화면(마이크·스피커)과 Live 연결 사이의 통로. 판단은 LiveClient 가 한다.
 *
 * 🔴 키는 이 파일에서 vault 를 읽어 LiveClient 에 **함수로만** 넘긴다. 렌더러로 가는 것은 hasKey 하나다.
 * 🔴 bypass(승인 생략)는 이 모듈의 변수다 — 디스크에 없다. 앱을 다시 켜면 꺼진다(PLAN 결정).
 */
import { ipcMain, type WebContents } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { handle } from './handle'
import { pushSend } from '../util/windowPush'
import { aiKeyVaultId, type KeyVault } from '../secrets/aiKeys'
import { LiveClient, type LiveSocket } from '../voice/LiveClient'
import { openWs, VoiceLog, VoiceUsageFile } from '../voice/voiceFiles'
import { voiceCost, type VoiceEvent, type VoicePrefs } from '@shared/voice'

const PREVIEW_TEXT = '안녕하세요, 아라입니다. 이 목소리로 말씀드릴게요.'

export type VoiceRuntime = {
  /** 다음 라운드(도구 승인)가 읽는다. */
  bypass(): boolean
  stop(): void
}

export function registerVoiceIpc(deps: {
  vault: KeyVault
  prefs: () => VoicePrefs
  callName: () => string
  dir: string
  getWebContents: () => WebContents | null
  /** 시험 seam — 안 주면 실물 소켓(ws). */
  open?: (url: string) => LiveSocket
}): VoiceRuntime {
  let bypass = false
  mkdirSync(deps.dir, { recursive: true })
  const usage = new VoiceUsageFile(join(deps.dir, 'usage.json'))
  const log = new VoiceLog(join(deps.dir, 'log'), () => deps.prefs().keep)
  log.sweep()

  const push = (e: VoiceEvent): void => pushSend(deps.getWebContents(), 'voice:event', e)
  const getKey = (): string | null => {
    try {
      return deps.vault.get(aiKeyVaultId('google'))
    } catch {
      return null // 앱 잠금 중
    }
  }
  const config = () => {
    const p = deps.prefs()
    return { voiceName: p.voiceName, speed: p.speed, callName: deps.callName() }
  }
  const open = deps.open ?? openWs

  const live = new LiveClient({
    getKey,
    config,
    open,
    emit: push,
    onTurn: (me, ara) => log.write(me, ara),
    onUsage: (tokens) => usage.add({ tokens }),
    onSeconds: (seconds) => usage.add({ seconds })
  })
  // [들어보기]는 따로 — 대화 중에 눌러도 대화를 끊지 않는다. 소리만 흘리고 상태·자막은 안 보낸다.
  // ponytail: 들어보기의 연결 실패는 조용하다(소리가 안 날 뿐). 이유가 필요해지면 status 오류를 따로 알린다.
  const preview = new LiveClient({
    getKey,
    config,
    open,
    emit: (e) => {
      if (e.t === 'audio') push(e)
    },
    onUsage: (tokens) => usage.add({ tokens })
  })

  handle('voice:state', () => ({ hasKey: getKey() !== null, bypass, status: live.getStatus() }))
  handle('voice:start', () => {
    log.sweep()
    return live.start()
  })
  handle('voice:stop', () => {
    live.stop()
    return { ok: true } as const
  })
  handle('voice:preview', () => preview.start({ preview: PREVIEW_TEXT }))
  handle('voice:setBypass', ({ on }) => {
    bypass = on === true
    pushSend(deps.getWebContents(), 'voice:bypass', { on: bypass })
    return { bypass }
  })
  handle('voice:usage', () => {
    const u = usage.get()
    return { seconds: u.seconds, ...voiceCost(u) }
  })
  ipcMain.on('voice:audio', (_e, p: { pcm?: unknown }) => {
    if (p?.pcm instanceof Uint8Array) live.sendAudio(p.pcm)
  })
  ipcMain.on('voice:audioEnd', () => live.endAudio())

  return {
    bypass: () => bypass,
    stop: () => {
      live.stop()
      preview.stop()
    }
  }
}
