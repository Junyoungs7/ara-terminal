// 마이크 → PCM16 조각(AudioWorklet). AudioContext 를 16kHz 로 만들어 두므로 여기 들어오는 소리는 이미 16kHz 다.
// 1024 샘플(64ms)씩 모아 Int16 바이트와 그 조각의 RMS(0~1)를 보낸다. 별도 파일인 이유: CSP(script-src 'self')가 blob: 모듈을 막는다.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Int16Array(1024)
    this.n = 0
    this.sq = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i += 1) {
      const v = Math.max(-1, Math.min(1, ch[i]))
      this.sq += v * v
      this.buf[this.n] = v < 0 ? v * 0x8000 : v * 0x7fff
      this.n += 1
      if (this.n === this.buf.length) {
        const out = this.buf.buffer
        this.port.postMessage({ pcm: out, rms: Math.sqrt(this.sq / this.n) }, [out])
        this.buf = new Int16Array(1024)
        this.n = 0
        this.sq = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
