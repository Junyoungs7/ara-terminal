// G1 글라스 스위치 — <html data-glass="on"> 하나로 styles/glass.css 가 켜진다(꺼지면 속성이 없다 = 지금 화면 그대로).
// ARA_GLASS(preload 가 건넨 값)가 설정값을 덮는다. OS 재질은 창을 만들 때 main 이 이미 깔았으니
// 여기서는 body 를 비울지만 알린다(data-glass-material) — 글라스를 끄면 그 속성도 같이 걷는다.
import { glassOn } from '@shared/glass'

export function applyGlass(pref: boolean): void {
  const root = document.documentElement
  const on = glassOn(pref, window.ev?.app?.glassForce)
  if (on) root.dataset.glass = 'on'
  else delete root.dataset.glass
  const material = on ? window.ev?.app?.glassMaterial : undefined
  if (material) root.dataset.glassMaterial = material
  else delete root.dataset.glassMaterial
}

// ARA_GLASS 로 강제한 판(성능 A/B)은 설정을 읽기 전 첫 그림부터 같은 화면이어야 한다 — 켜기 시간 지표가 같은 그림을 잰다.
if (typeof document !== 'undefined') applyGlass(false)
