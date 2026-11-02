"""브랜드 토큰 ↔ 앱 신호색(mockups/v2/glass/c.css — 시안 C) 거리. CIELAB ΔE76. 겹침 경고만 낸다(결정은 그대로).
→ ../kit/signal-distance.md 표"""
import json, os
from build_kit import KIT
SIG = {'AI --ai-a #5B4BFF': '#5B4BFF', 'AI --ai-m #1F8FFF': '#1F8FFF', 'AI --ai-b 다크 #4AD6FF': '#4AD6FF', 'AI --ai-b 라이트 #2BB8E8': '#2BB8E8',
       'AI 글자 다크 #AFC0FF': '#AFC0FF', 'AI 글자 라이트 #2A2BC4': '#2A2BC4',
       '사람 --user 다크 #FFB547': '#FFB547', '사람 --user 라이트 #E8930C': '#E8930C', '사람 글자 다크 #FFCB80': '#FFCB80', '사람 글자 라이트 #7E4400': '#7E4400'}
def lab(h):
    c = [int(h[i:i+2], 16)/255 for i in (1, 3, 5)]
    c = [x/12.92 if x <= .04045 else ((x+.055)/1.055)**2.4 for x in c]
    X = (c[0]*.4124+c[1]*.3576+c[2]*.1805)/.95047; Y = c[0]*.2126+c[1]*.7152+c[2]*.0722; Z = (c[0]*.0193+c[1]*.1192+c[2]*.9505)/1.08883
    f = lambda t: t**(1/3) if t > .008856 else 7.787*t+16/116
    return 116*f(Y)-16, 500*(f(X)-f(Y)), 200*(f(Y)-f(Z))
de = lambda a, b: sum((x-y)**2 for x, y in zip(lab(a), lab(b)))**.5
T = json.load(open(os.path.join(KIT, 'tokens.json'), encoding='utf-8'))
rows = ['| 브랜드 토큰 | 값 | 가장 가까운 신호색 | ΔE76 | 판정 |', '|---|---|---|---|---|']
for n in ('ara', 'oriel'):
    toks = {f'{n} {row} 면{k} 평면': T[n][row][k]['flat'] for row in ('light', 'dark') for k in ('a', 'b')}
    toks.update({f'{n} 작은 판 면{k}': v for k, v in T[n]['small_flat'].items()})
    for name, h in toks.items():
        s, v = min(SIG.items(), key=lambda kv: de(h, kv[1]))
        d = de(h, v)
        rows.append(f'| {name} | `{h}` | {s} | {d:.1f} | {"⚠ 가까움(<20)" if d < 20 else ("주의(<30)" if d < 30 else "구분됨")} |')
out = '\n'.join(rows)
open(os.path.join(KIT, 'signal-distance.md'), 'w', encoding='utf-8').write('# 브랜드 토큰 ↔ 앱 신호색 거리 (생성물: scripts/signal_distance.py)\n\n신호색 출처: `D:/AI/OFA/mockups/v2/glass/c.css`(시안 C). ΔE76 < 20 = 나란히 두면 같은 계열로 읽힐 수 있음(경고만, 결정은 그대로).\n\n' + out + '\n')
print(out)
