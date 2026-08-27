import type { WakeEngine } from './voice'

// 깨우는 말 엔진 — **이 PC 안에서만** 돈다(2026-08-27).
//
// 이 모듈이 이 기능의 보안선이다: "아라야"가 들리기 전의 소리는 여기서 끝나고 어디로도 안 간다.
// 클라우드 받아쓰기를 상시로 돌리는 방식은 그래서 처음부터 후보가 아니었다.
//
// **vosk-browser**(Apache-2.0)를 쓴다. 고른 이유:
//  · WASM 이라 **네이티브 모듈이 없다** — node-gyp·electron-rebuild 를 건드리지 않는다
//  · 접근 키가 필요 없다(Picovoice 는 사내 배포에 상용 라이선스가 걸린다)
//  · 오프라인이라 VPN·인터넷 없이 돈다(준영님 결정으로 모델을 설치본에 함께 싣는다)
//
// **무겁다.** 5.8MB 번들 + 83MB 모델이라 앱 시작에 끼우지 않는다 — 음성을 켠 뒤 마이크가 열릴 때
// 처음으로 동적 import 한다. 어디가 깨지든 null 을 돌려주고, 그러면 음성은 단축키로만 돈다
// (없는 기능을 있는 척하지 않는다).
//
// ⚠️ **실측 남음**: 아카이브 형식(alphacephei 는 .zip, 이 라이브러리 예제는 .tar.gz)과 한국어
// 인식률·오작동률은 준영님 마이크로 확인해야 한다. 설정 [음성]의 [깨우기 시험]이 그 확인용이다.

export async function createWakeEngine(): Promise<WakeEngine | null> {
  const model = await window.ev?.voice.wakeModel().catch(() => null)
  if (!model?.ok) return null

  try {
    // 동적 import — 음성을 안 켠 사람의 앱에는 이 번들이 아예 로드되지 않는다.
    const vosk = await import('vosk-browser')
    const url = URL.createObjectURL(new Blob([new Uint8Array(model.bytes)], { type: 'application/octet-stream' }))
    let m: Awaited<ReturnType<typeof vosk.createModel>>
    try {
      m = await vosk.createModel(url)
    } finally {
      URL.revokeObjectURL(url)
    }

    let rec: ReturnType<typeof makeRec> | null = null
    let cb: ((text: string) => void) | null = null
    let rate = 0

    function makeRec(sampleRate: number) {
      const r = new m.KaldiRecognizer(sampleRate)
      // 끝난 문장과 **부분 결과**를 다 본다. "아라야" 한 마디는 문장 끝을 기다리면 1초 넘게 늦는다.
      r.on('result', (msg) => {
        const text = 'result' in msg && 'text' in msg.result ? msg.result.text : ''
        if (text.trim()) cb?.(text)
      })
      r.on('partialresult', (msg) => {
        const text = 'result' in msg && 'partial' in msg.result ? msg.result.partial : ''
        if (text.trim()) cb?.(text)
      })
      return r
    }

    return {
      feed(chunk, sampleRate) {
        // 마이크 표본율이 바뀌면(장치 교체) 인식기를 다시 만든다 — 섞어 먹이면 글자가 뭉개진다.
        if (!rec || rate !== sampleRate) {
          rec?.remove()
          rate = sampleRate
          rec = makeRec(sampleRate)
        }
        // AudioBuffer 를 만들지 않는다 — Float32 를 그대로 받는 길이 있다(복사 한 번을 아낀다).
        rec.acceptWaveformFloat(chunk, sampleRate)
      },
      onText(fn) {
        cb = fn
      },
      dispose() {
        cb = null
        rec?.remove()
        rec = null
        m.terminate()
      }
    }
  } catch {
    return null // 번들·모델 어느 쪽이 깨져도 음성 자체는 단축키로 살아 있어야 한다
  }
}
