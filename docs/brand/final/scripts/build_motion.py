"""'동작 중(working)' 모션 데모 — kit/motion/working-demo.html + 미리 그린 빛 번짐 PNG.
규칙(HANDOFF·ARA-MOTION 과 같은 내용):
  · 움직이는 속성은 transform · opacity 둘뿐. 빛 번짐(glow)은 미리 흐리게 구운 PNG 층의 opacity 만 바꾼다
    (프레임마다 filter blur·box-shadow 금지 — Oriel 아크릴 창 다시 그리기가 비싸다).
  · (A) 빛남: 접힌 두 면 위 흰 덧칠 층이 엇갈려 밝아졌다 어두워진다 + 빛 번짐 숨쉬기. 2.4s, ease-in-out(넘침 없음).
  · (B) A + 앞에서 본 궤도: 납작하고 살짝 기운 타원이 별을 가로지른다. 빛점이 타원을 돈다 —
    앞 반(아래)은 별 위 층, 뒤 반(위)은 별 아래 층 → 가림은 층 순서로. 빛점 이동 = 중첩 rotate·translate·scale.
  · 16–24px: A 만(궤도 선은 그리지 않는다). B 를 꼭 써야 하면 빛점 하나(점)만.
  · prefers-reduced-motion: 별 정지, 빛점 없음(궤도 선은 정지 상태로 남는다).
  · 켜는 조건(앱 쪽 게이트): 에이전트가 최근 3초 안에 명령을 냈을 때만 .working.
"""
import os, numpy as np
from PIL import Image, ImageFilter
import build_kit as K
from geom import faces, place, path_d

OUT = os.path.join(K.KIT, 'motion')
os.makedirs(OUT, exist_ok=True)

PERIOD = 2.4        # s — 빛남 한 주기(두 면이 한 번씩 밝아짐)
ORBIT = 3.6         # s — 빛점 한 바퀴
TILT = -14          # deg — 궤도 기울기
RX = 0.46           # 궤도 가로 반지름(마크 상자 대비)
FLAT = 0.2          # 세로/가로 — 낮은 각도에서 본 고리
GLOW_PAD = 0.25     # 빛 번짐 PNG 는 상자보다 사방 25% 크게


def glow_png(name):
    """마크 실루엣을 흐리게 구운 빛 번짐 — 한 번만 굽고 CSS 가 opacity 만 바꾼다."""
    S = 512
    a = K.mark_layers(name, S, K.FILL, 'grad', 'dark', ss=2)
    pad = int(S*GLOW_PAD)
    alpha = Image.fromarray(a[..., 3].astype('uint8')).resize((S, S))
    big = Image.new('L', (S+2*pad, S+2*pad), 0)
    big.paste(alpha, (pad, pad))
    big = big.filter(ImageFilter.GaussianBlur(S*0.06))
    col = K.rgb(K.SMALL[name]['b'] if name == 'ara' else K.SMALL[name]['a'])
    rgba = np.zeros((big.height, big.width, 4), 'uint8')
    rgba[..., :3] = col
    rgba[..., 3] = (np.asarray(big)*0.85).astype('uint8')
    Image.fromarray(rgba, 'RGBA').save(os.path.join(OUT, f'{name}-glow.png'))


def star_svg(name, size, row):
    small = size <= 24
    fill = K.SMALL_FILL if small else K.FILL
    f, _ = place(name, 1024, fill)
    fa, fb, _ = faces(name)
    body = K.svg_mark_body(name, f, 'flat' if small else row, f'{name}-{row}-{size}-')
    # 덧칠은 면마다 따로 된 <svg> 층 — 상자 opacity 는 확실히 합성기 층이 된다(안쪽 <path> opacity 도
    # 이 Edge 에선 메인 스레드 0 이었지만 브라우저마다 보장되지 않는다. control.cjs 참고).
    return (f'<svg class="star" viewBox="0 0 1024 1024">{body}</svg>'
            f'<svg class="sh sa" viewBox="0 0 1024 1024"><path d="{path_d(fa, f, 1)}"/></svg>'
            f'<svg class="sh sb" viewBox="0 0 1024 1024"><path d="{path_d(fb, f, 1)}"/></svg>')


def ring_svg(name, size, half):
    rx, ry = RX*1024, RX*FLAT*1024
    sw = max(1.0, 0.006*size)*1024/size            # 최소 1px
    sweep = 0 if half == 'front' else 1            # 앞 = 아래 반(왼→아래→오른)
    col = K.SMALL[name]['b'] if name == 'ara' else K.SMALL[name]['a']
    op = .85 if half == 'front' else .4
    return (f'<svg class="ring {half}" viewBox="0 0 1024 1024"><g transform="rotate({TILT} 512 512)">'
            f'<path d="M{512-rx:.1f} 512 A{rx:.1f} {ry:.1f} 0 0 {sweep} {512+rx:.1f} 512" fill="none" stroke="{col}" stroke-opacity="{op}" stroke-width="{sw:.2f}" stroke-linecap="round"/></g></svg>')


def glint(half):
    # tilt·납작 → 돌기 → 팔 → 되돌기 → 펴기 : 행렬이 상쇄돼 빛점은 동그란 채로 타원 위를 돈다
    return (f'<div class="orb"><div class="spin"><div class="arm"><div class="unspin"><div class="unsq">'
            f'<i class="glint {half}"></i></div></div></div></div></div>')


def mark(name, size, row, mode):
    """mode: 'A' 빛남만 · 'B' 빛남+궤도 · 'Bdot' (≤24) 빛점만."""
    parts = [f'<img class="glow" src="{name}-glow.png" alt="">']
    if mode == 'B':
        parts.append(ring_svg(name, size, 'back'))
    if mode in ('B', 'Bdot'):
        parts.append(glint('back'))
    parts.append(star_svg(name, size, row))
    if mode == 'B':
        parts.append(ring_svg(name, size, 'front'))
    if mode in ('B', 'Bdot'):
        parts.append(glint('front'))
    col = K.SMALL[name]['b'] if name == 'ara' else K.SMALL[name]['a']
    return (f'<div class="mk working" style="--s:{size}px;--glint:{col}" title="{name} {size}px {mode}">' + ''.join(parts) + '</div>')


CSS = f"""
:root{{color-scheme:light dark;font:13px/1.5 'Pretendard','Segoe UI',sans-serif}}
body{{margin:0;background:#141416;color:#ddd}}
h1{{font-size:18px;margin:16px}} p{{margin:4px 16px;max-width:900px}}
.row{{display:flex;flex-wrap:wrap;align-items:center;gap:28px;padding:20px 16px}}
.row.dark{{background:#141416;color:#ddd}} .row.light{{background:#FCF6EF;color:#222}}
.cell{{display:flex;flex-direction:column;align-items:center;gap:8px}}
.lab{{font-size:11px;opacity:.7}}
.mk{{position:relative;width:var(--s);height:var(--s);flex:none}}
.mk>*{{position:absolute;inset:0;width:100%;height:100%}}
.mk .glow{{inset:-{GLOW_PAD*100:.0f}%;width:{100+2*GLOW_PAD*100:.0f}%;height:{100+2*GLOW_PAD*100:.0f}%;opacity:0}}
.sh{{fill:#fff;opacity:0;will-change:opacity}}
.orb{{inset:auto;left:50%;top:50%;width:0;height:0;transform:rotate({TILT}deg) scaleY({FLAT})}}
.orb *{{position:absolute;left:0;top:0;width:0;height:0}}
.arm{{transform:translateX(calc(var(--s)*{RX}))}}
.unsq{{transform:scaleY({1/FLAT:.4f})}}
.glint{{display:block;width:calc(max(3px,var(--s)*.05));height:calc(max(3px,var(--s)*.05));
  margin:calc(max(3px,var(--s)*.05)/-2) 0 0 calc(max(3px,var(--s)*.05)/-2);border-radius:50%;
  background:radial-gradient(circle,#fff 0 30%,var(--glint) 55%,transparent 72%);opacity:0}}
/* 동작 중일 때만 — 앱에서는 '최근 3초 안에 명령' 게이트가 .working 을 붙였다 뗀다 */
.working .glow{{animation:glow {PERIOD}s ease-in-out infinite}}
.working .sa{{animation:shA {PERIOD}s ease-in-out infinite}}
.working .sb{{animation:shB {PERIOD}s ease-in-out infinite}}
.working .spin{{animation:spin {ORBIT}s linear infinite}}
.working .unspin{{animation:spin {ORBIT}s linear infinite reverse}}
.working .glint.front{{animation:half {ORBIT}s step-end infinite}}
.working .glint.back{{animation:half {ORBIT}s step-end infinite reverse}}
@keyframes glow{{0%,100%{{opacity:.15}}50%{{opacity:.55}}}}
@keyframes shA{{0%,100%{{opacity:.22}}50%{{opacity:0}}}}
@keyframes shB{{0%,100%{{opacity:0}}50%{{opacity:.22}}}}
@keyframes spin{{to{{transform:rotate(1turn)}}}}
@keyframes half{{0%{{opacity:1}}50%{{opacity:0}}100%{{opacity:0}}}}
@media (prefers-reduced-motion:reduce){{
  .working *{{animation:none!important}} .glint{{display:none}}
}}
.ctl{{margin:12px 16px;display:flex;gap:12px;align-items:center}}
button{{font:inherit;padding:4px 10px}}
"""

JS = """
// 게이트 데모: 명령을 낸 뒤 3초 동안만 .working
const gate = document.getElementById('gate')
let last = 0, timer
document.getElementById('cmd').onclick = () => {
  last = performance.now(); gate.classList.add('working')
  clearTimeout(timer); timer = setTimeout(() => gate.classList.remove('working'), 3000)
}
gate.classList.remove('working')
// ?perf=N : N 개(기본 6)만 B 모드 64px 로 띄우고 rAF 프레임 간격을 5초 잰다(perf.cjs 가 읽는다)
const q = new URLSearchParams(location.search)
if (q.has('perf')) {
  document.getElementById('demo').style.display = 'none'
  const n = +q.get('perf'), host = document.getElementById('perfhost'), tpl = document.getElementById('perftpl')
  for (let i = 0; i < n / 2; i++) host.insertAdjacentHTML('beforeend', tpl.innerHTML)
  const iv = []; let prev = 0, t0 = 0
  const tick = (t) => { if (!t0) t0 = t; if (prev) iv.push(t - prev); prev = t; if (t - t0 < 5000) requestAnimationFrame(tick); else window.__perf = iv }
  // rAF 는 perf.cjs 가 부를 때만 — rAF 가 돌면 메인 스레드가 매 프레임 깨어나 합성기 애니메이션도 스타일 재계산에 잡힌다
  window.__startRaf = () => requestAnimationFrame(tick)
}
"""


def main():
    for n in ('ara', 'oriel'):
        glow_png(n)
    rows = []
    for row in ('dark', 'light'):
        for n in ('ara', 'oriel'):
            cells = []
            for mode in ('A', 'B'):
                for s in (512, 64, 24, 16):
                    m = mode if (mode == 'A' or s > 24) else 'Bdot'
                    lab = {'A': 'A 빛남', 'B': 'B 빛남+궤도', 'Bdot': 'B(≤24: 빛점만)'}[m]
                    cells.append(f'<div class="cell">{mark(n, s, row, m)}<span class="lab">{n} · {s}px · {lab}</span></div>')
            rows.append(f'<div class="row {row}">' + ''.join(cells) + '</div>')
    perf_tpl = ''.join(mark(n, 64, 'dark', 'B') for n in ('ara', 'oriel'))  # 한 벌 = 2개
    html = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>동작 중 모션</title>
<style>{CSS}</style></head><body>
<div id="demo">
<h1>동작 중(working) 모션 — ARA · Oriel</h1>
<p>A = 빛남(접힌 두 면이 엇갈려 밝아짐 + 빛 번짐 숨쉬기, {PERIOD}s). B = A + 앞에서 본 궤도(납작·{abs(TILT)}° 기운 타원, 빛점 한 바퀴 {ORBIT}s — 위 반은 별 뒤로 가려진다).
움직이는 속성은 transform·opacity 뿐. 16–24px 은 A 권장(B 는 빛점만). prefers-reduced-motion 이면 정지·빛점 없음.</p>
<div class="ctl"><div class="mk working" id="gate" style="--s:64px;--glint:{K.SMALL['ara']['b']}">{mark('ara', 64, 'dark', 'B')[mark('ara', 64, 'dark', 'B').index('>')+1:-6]}</div>
<button id="cmd">명령 보내기(3초 게이트)</button><span class="lab">버튼을 누른 뒤 3초 동안만 움직인다</span></div>
{''.join(rows)}
</div>
<div id="perfhost" class="row dark"></div>
<template id="perftpl">{perf_tpl}</template>
<script>{JS}</script></body></html>
"""
    open(os.path.join(OUT, 'working-demo.html'), 'w', encoding='utf-8', newline='\n').write(html)
    print('→', os.path.join(OUT, 'working-demo.html'))


if __name__ == '__main__':
    main()
