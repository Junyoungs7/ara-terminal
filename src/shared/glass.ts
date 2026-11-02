// G1 글라스(시안 C) — 켬/끔과 창 바탕 재질을 정하는 순수 함수. main(창 만들 때)·preload·렌더러가 같이 쓴다.
//
// 기본 바탕은 **CSS 만**이다: 시안 C(mockups/v2/glass/c.css·glass.css)는 창을 투명하게 하지 않고 body 에
// 정적 radial 그라디언트(--gl-wall)를 깐 뒤 구조 면을 반투명 틴트로 얹는다. 창이 불투명이라 DWM 합성
// 비용이 없고, 그라디언트가 움직이지 않아 유휴 때 다시 그릴 것이 없다(Oriel 측정: 투명 창은 매 프레임
// 다시 그려 내장 GPU ~25%). OS 재질(Windows 11 mica/acrylic · macOS vibrancy)은 측정용으로만
// ARA_GLASS_MATERIAL 로 켠다 — 설정 화면에는 없다(A/B 결과를 보고 메인이 정한다).

/** 설정값 + ARA_GLASS 강제(성능 A/B 용 — '1' 켬 · '0' 끔 · 그 밖은 무시). */
export function glassOn(pref: boolean, force: string | undefined): boolean {
  if (force === '1') return true
  if (force === '0') return false
  return pref
}

export type GlassMaterial = 'mica' | 'acrylic' | 'vibrancy'

/**
 * ARA_GLASS_MATERIAL → 이 OS 에서 쓸 재질. 없거나 모르는 값·안 되는 OS 면 null(CSS 바탕).
 * 'os' = 그 OS 의 기본(Windows mica · macOS vibrancy). Windows 10 은 Electron 이 무시한다(불투명으로 남는다).
 */
export function glassMaterialOf(env: string | undefined, platform: string): GlassMaterial | null {
  if (platform === 'win32') return env === 'mica' || env === 'os' ? 'mica' : env === 'acrylic' ? 'acrylic' : null
  if (platform === 'darwin') return env === 'vibrancy' || env === 'os' ? 'vibrancy' : null
  return null
}
