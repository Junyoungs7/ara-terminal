"""아이콘 키트 생성 — marks.json(형태) + colors.json(보드에서 잰 색) → kit/ 전부.
순서: python fit_marks.py → python measure_colors.py → python build_kit.py
의존: numpy · Pillow · fontTools(+brotli, 워드마크 글자 윤곽). npm 의존성 없음.
"""
import io, json, struct, os, shutil, numpy as np
from PIL import Image, ImageDraw
from geom import faces, place, path_d, polygon, bbox, HERE, M

ROOT = os.path.normpath(os.path.join(HERE, '..'))
KIT = os.path.join(ROOT, 'kit')
COL = json.load(open(os.path.join(HERE, 'colors.json'), encoding='utf-8'))
FONT = r'D:\AI\OFA-v22\resources\fonts\PretendardVariable.woff2'

# ── 색 ────────────────────────────────────────────────────────────────────────
# 'light' = 밝은 바탕용(보드 위 줄) · 'dark' = 어두운 바탕용(보드 아래 줄). 값은 전부 보드에서 잰 것.
# 작은 크기(≤48) 평면 2톤: 면 구분이 남도록 두 면의 명도 차가 큰 측정값을 골랐다.
#   ARA  — 다크 줄 정지점 중 a(위 면)는 가장 어두운 것 · b(아래 면)는 가장 밝은 것: 두 면 명도 차가 가장 크고, 라이트·다크
#          작업 표시줄 둘 다에서 읽힌다(라이트 줄 남색은 #202020 에 묻힌다).
#   Oriel — 라이트 줄 정지점 끝값(a 오른쪽 주황 #F69354 · b 왼쪽 산호빨강 #DD585C): "왼쪽 어둡게·오른쪽 밝게".
def _lum(h):
    return sum(w*int(h[i:i+2], 16) for w, i in ((.2126, 1), (.7152, 3), (.0722, 5)))


SMALL = {'ara': {'a': min(COL['ara']['dark']['a']['stops'], key=_lum), 'b': max(COL['ara']['dark']['b']['stops'], key=_lum)},
         'oriel': {'a': COL['oriel']['light']['a']['stops'][0], 'b': COL['oriel']['light']['b']['stops'][0]}}
# 앱 아이콘(PNG·ICO·ICNS 64px 이상)이 쓰는 그라데이션 줄 — 바탕을 모르므로 ARA 는 밝은 다크 변형.
APP_ROW = {'ara': 'dark', 'oriel': 'light'}
PLATE = (COL['board']['plate_top_dark'], COL['board']['plate_bottom_dark'])
FILL = 0.88          # 정사각 캔버스에서 마크 bbox 긴 변 비율
PLATE_FILL = 0.62    # macOS 판: 1024 캔버스 기준 마크 긴 변(판 824 의 약 77% — 보드 판 안 비율)
SMALL_MAX = 48
SMALL_FILL = 0.98    # 작은 판은 여백을 거의 없앤다 — 끝이 가는 마크라 1px 이 아깝다
SMALL_GAMMA = 0.75   # 작은 판 알파를 살짝 올려 가는 끝(ARA 꼬리)이 사라지지 않게
PNG_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]


def rgb(h):
    return np.array([int(h[i:i+2], 16) for i in (1, 3, 5)], float)


# ── 래스터 ────────────────────────────────────────────────────────────────────
def mark_layers(name, size, fill, style, row, ss=8, snap=False):
    """→ RGBA float 배열(size×size). style: 'grad' | 'flat'."""
    f, s = place(name, size, fill)
    if snap:  # 작은 크기: bbox 왼쪽 위를 정수 픽셀에 — 끝점이 픽셀 경계에서 시작한다
        lo, _ = bbox(name)
        p = f(lo)
        d = np.round(p)-p
        f0 = f
        f = lambda q, f0=f0, d=d: f0(q)+d
    N = size*ss
    lab = Image.new('L', (N, N), 0)
    dr = ImageDraw.Draw(lab)
    fa, fb, _ = faces(name)
    for v, face in ((1, fa), (2, fb)):
        dr.polygon([tuple(p*ss) for p in polygon(face, f, 64)], fill=v)
    lab = np.asarray(lab)
    yy, xx = (np.mgrid[0:N, 0:N]+0.5)/ss
    img = np.zeros((N, N, 4))
    for v, key in ((1, 'a'), (2, 'b')):
        m = lab == v
        if style == 'flat':
            img[m, :3] = rgb(SMALL[name][key])
        else:
            c = COL[name][row][key]
            a, b = (f(np.array(p)) for p in c['axis'])
            t = (((xx-a[0])*(b[0]-a[0]) + (yy-a[1])*(b[1]-a[1])) / ((b-a) @ (b-a))).clip(0, 1)[m]
            st = [rgb(h) for h in c['stops']]
            col = np.where(t[:, None] < .5, st[0]+(st[1]-st[0])*(t[:, None]/.5), st[1]+(st[2]-st[1])*((t[:, None]-.5)/.5))
            img[m, :3] = col
        img[m, 3] = 255
    return downsample(img, ss)


def downsample(img, ss):
    H, W = img.shape[0]//ss, img.shape[1]//ss
    pre = img.copy()
    pre[..., :3] *= img[..., 3:4]/255
    pre = pre.reshape(H, ss, W, ss, 4).mean((1, 3))
    out = pre.copy()
    a = pre[..., 3:4]
    out[..., :3] = np.where(a > 0, pre[..., :3]*255/np.maximum(a, 1e-6), 0)
    return out


def over(top, bot):
    ta, ba = top[..., 3:4]/255, bot[..., 3:4]/255
    oa = ta+ba*(1-ta)
    oc = (top[..., :3]*ta + bot[..., :3]*ba*(1-ta))/np.maximum(oa, 1e-6)
    return np.concatenate([oc, oa*255], -1)


def plate(size, ss=4):
    """macOS 판 — 1024 기준 824 둥근 사각(반경 185 ≈ 22.4%), 위→아래 그라데이션."""
    N = size*ss
    k = N/1024
    im = Image.new('L', (N, N), 0)
    ImageDraw.Draw(im).rounded_rectangle([100*k, 100*k, 924*k, 924*k], radius=185*k, fill=255)
    m = np.asarray(im) > 0
    t = np.clip((np.arange(N)/k-100)/824, 0, 1)[:, None, None]
    top, bot = rgb(PLATE[0]), rgb(PLATE[1])
    img = np.zeros((N, N, 4))
    img[..., :3] = top+(bot-top)*t
    img[..., 3] = m*255
    return downsample(img, ss)


def to_im(a):
    return Image.fromarray(np.clip(np.round(a), 0, 255).astype('uint8'), 'RGBA')


def app_png(name, size):
    small = size <= SMALL_MAX
    if not small:
        return to_im(mark_layers(name, size, FILL, 'grad', APP_ROW[name], ss=4))
    a = mark_layers(name, size, SMALL_FILL, 'flat', APP_ROW[name], ss=16, snap=True)
    a[..., 3] = 255*(a[..., 3]/255)**SMALL_GAMMA
    return to_im(a)


def mac_png(name, size):
    small = size <= SMALL_MAX
    mk = mark_layers(name, size, PLATE_FILL, 'flat' if small else 'grad', 'dark', ss=16 if small else 4)
    return to_im(over(mk, plate(size, 16 if small else 4)))


# ── SVG ───────────────────────────────────────────────────────────────────────
def svg_mark_body(name, f, variant, idp):
    fa, fb, _ = faces(name)
    da, db = path_d(fa, f), path_d(fb, f)
    if variant in ('light', 'dark'):
        defs = []
        for key in ('a', 'b'):
            c = COL[name][variant][key]
            a, b = (f(np.array(p)) for p in c['axis'])
            st = ''.join(f'<stop offset="{o}" stop-color="{h}"/>' for o, h in zip(('0', '.5', '1'), c['stops']))
            defs.append(f'<linearGradient id="{idp}{key}" gradientUnits="userSpaceOnUse" x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}">{st}</linearGradient>')
        return (f'<defs>{"".join(defs)}</defs>\n  <path d="{da}" fill="url(#{idp}a)"/>\n  <path d="{db}" fill="url(#{idp}b)"/>')
    if variant == 'flat':
        return f'<path d="{da}" fill="{SMALL[name]["a"]}"/>\n  <path d="{db}" fill="{SMALL[name]["b"]}"/>'
    # mono: 한 색(currentColor), 접힘은 면 b 를 60% 로 — 단색에서도 접힘이 남는다
    return f'<path d="{da}" fill="currentColor"/>\n  <path d="{db}" fill="currentColor" fill-opacity=".6"/>'


def svg_mark(name, variant, size=1024):
    f, _ = place(name, size, SMALL_FILL if variant == 'flat' else FILL)
    label = 'ARA' if name == 'ara' else 'Oriel'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-label="{label}">\n  '
            + svg_mark_body(name, f, variant, f'{name}-{variant}-') + '\n</svg>\n')


def svg_mac(name):
    f, _ = place(name, 1024, PLATE_FILL)
    label = 'ARA' if name == 'ara' else 'Oriel'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="{label}">\n'
            f'  <defs><linearGradient id="{name}-plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{PLATE[0]}"/><stop offset="1" stop-color="{PLATE[1]}"/></linearGradient></defs>\n'
            f'  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#{name}-plate)"/>\n  '
            + svg_mark_body(name, f, 'dark', f'{name}-mac-') + '\n</svg>\n')


_font = None


def text_paths(text, cap_h):
    """Pretendard Regular(가변 글꼴 wght 400 인스턴스)로 글자를 윤곽 path 로. 커닝은 적용하지 않음."""
    global _font
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    if _font is None:
        from fontTools.varLib.instancer import instantiateVariableFont
        _font = instantiateVariableFont(TTFont(FONT), {'wght': 400})
    gs = _font.getGlyphSet()
    cmap = _font.getBestCmap()
    sc = cap_h/_font['OS/2'].sCapHeight
    pen = SVGPathPen(gs)
    x = 0
    for ch in text:
        g = cmap[ord(ch)]
        gs[g].draw(TransformPen(pen, (sc, 0, 0, -sc, x, 0)))
        x += gs[g].width*sc
    return pen.getCommands(), x


def svg_wordmark(name, row):
    H = 100.0                                   # 마크 bbox 높이
    lo, hi = bbox(name)
    s = H/(hi-lo)[1]
    w = (hi-lo)[0]*s
    f = lambda p: (np.asarray(p, float)-lo)*s
    cap = 0.42*H                                # 보드: 글자 대문자 높이 ≈ 마크 높이의 0.42~0.44
    gap = 0.2*H                                 # 보드: 마크와 글자 사이 ≈ 0.2H
    label = 'ARA' if name == 'ara' else 'Oriel'
    d, tw = text_paths(label, cap)
    ink = COL['board']['text_light'] if row == 'light' else COL['board']['text_dark']
    W = w+gap+tw
    base = H/2+cap/2                            # 대문자 가운데 = 마크 가운데
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.1f} {H:.0f}" width="{W*2:.0f}" height="{H*2:.0f}" role="img" aria-label="{label}">\n  '
            + svg_mark_body(name, f, row, f'{name}-wm-{row}-')
            + f'\n  <!-- 글자: Pretendard Regular(400) 윤곽, 대문자 높이 {cap:.0f} -->\n'
            f'  <path transform="translate({w+gap:.2f} {base:.2f})" fill="{ink}" d="{d}"/>\n</svg>\n')


# ── ICO / ICNS ────────────────────────────────────────────────────────────────
def save_ico(images, path):
    # ICO 를 손으로 쓴다: 256 은 PNG, 나머지는 32bit DIB(BMP) — Pillow 는 크기별 다른 그림을 넣는 길이 버전마다 달라서.
    entries = []
    for im in images:
        w = im.width
        if w >= 256:
            b = io.BytesIO(); im.save(b, 'PNG'); data = b.getvalue()
        else:
            a = np.asarray(im)
            bgra = a[::-1, :, [2, 1, 0, 3]].tobytes()
            mask_row = ((w+31)//32)*4
            hdr = struct.pack('<IiiHHIIiiII', 40, w, w*2, 1, 32, 0, len(bgra), 0, 0, 0, 0)
            data = hdr + bgra + bytes(mask_row*w)
        entries.append((w, data))
    out = io.BytesIO()
    out.write(np.array([0, 1, len(entries)], '<u2').tobytes())
    off = 6+16*len(entries)
    for w, data in entries:
        out.write(bytes([w % 256, w % 256, 0, 0]) + np.array([1, 32], '<u2').tobytes() + np.array([len(data), off], '<u4').tobytes())
        off += len(data)
    for _, data in entries:
        out.write(data)
    open(path, 'wb').write(out.getvalue())


ICONSET = [(16, 'icon_16x16'), (32, 'icon_16x16@2x'), (32, 'icon_32x32'), (64, 'icon_32x32@2x'),
           (128, 'icon_128x128'), (256, 'icon_128x128@2x'), (256, 'icon_256x256'), (512, 'icon_256x256@2x'),
           (512, 'icon_512x512'), (1024, 'icon_512x512@2x')]


def save_icns(name, d):
    iconset = os.path.join(d, f'{name}.iconset')
    os.makedirs(iconset, exist_ok=True)
    cache = {}
    for sz, fn in ICONSET:
        if sz not in cache:
            cache[sz] = mac_png(name, sz)
        cache[sz].save(os.path.join(iconset, fn+'.png'))
    # ICNS 직접 조립(PNG 엔트리): ic04 16 · ic05 32 · ic07 128 · ic08 256 · ic09 512 · ic10 1024 · ic11 32(16@2) · ic12 64(32@2) · ic13 256(128@2) · ic14 512(256@2)
    types = [('ic04', 16), ('ic05', 32), ('ic11', 32), ('ic12', 64), ('ic07', 128), ('ic13', 256),
             ('ic08', 256), ('ic14', 512), ('ic09', 512), ('ic10', 1024)]
    body = b''
    for t, sz in types:
        b = io.BytesIO(); cache[sz].save(b, 'PNG'); p = b.getvalue()
        body += t.encode() + (8+len(p)).to_bytes(4, 'big') + p
    open(os.path.join(d, f'{name}.icns'), 'wb').write(b'icns' + (8+len(body)).to_bytes(4, 'big') + body)


# ── 키트 ──────────────────────────────────────────────────────────────────────
def build(name):
    d = os.path.join(KIT, name)
    for sub in ('svg', 'png'):
        os.makedirs(os.path.join(d, sub), exist_ok=True)
    w = lambda rel, s: open(os.path.join(d, rel), 'w', encoding='utf-8', newline='\n').write(s)
    w(f'svg/{name}-color.svg', svg_mark(name, 'light'))
    w(f'svg/{name}-color-dark.svg', svg_mark(name, 'dark'))
    w(f'svg/{name}-flat.svg', svg_mark(name, 'flat'))
    w(f'svg/{name}-mono.svg', svg_mark(name, 'mono'))
    w(f'svg/{name}-macos.svg', svg_mac(name))
    w(f'svg/{name}-wordmark.svg', svg_wordmark(name, 'light'))
    w(f'svg/{name}-wordmark-dark.svg', svg_wordmark(name, 'dark'))
    pngs = {}
    for sz in PNG_SIZES:
        pngs[sz] = app_png(name, sz)
        pngs[sz].save(os.path.join(d, 'png', f'{name}-{sz}.png'))
    m1024 = mac_png(name, 1024)
    m1024.save(os.path.join(d, 'png', f'{name}-macos-1024.png'))
    m1024.crop((100, 100, 924, 924)).save(os.path.join(d, 'png', f'{name}-macos-824.png'))
    save_ico([pngs[s] if s in pngs else app_png(name, s) for s in ICO_SIZES], os.path.join(d, f'{name}.ico'))
    save_icns(name, d)


# ── 판 아이콘(시안 B, 신고 #34 — 2026-11-11 준영님 확정) ─────────────────────────
# 실행 파일·창·작업 표시줄 아이콘 전용. 앱 안 로고(BrandOrb 등)는 위 투명 마크 그대로.
# 판: 캔버스 꽉 찬 둥근 사각(rx 230/1024), 왼쪽 위→오른쪽 아래 그라데이션. 별: 흰색(면 a)·연보라(면 b) 2톤.
# 비율은 시안 그대로 — 평면 SVG(SMALL_FILL) 를 0.78 배 → 마크 긴 변 = 0.98×0.78.
TILE_GRAD = ('#5E61DA', '#9A7BF0')
TILE_STAR = {'a': '#FFFFFF', 'b': '#DCD2FF'}
TILE_RX = 230/1024
TILE_FILL = SMALL_FILL*0.78
# 작은 판 별 굵기 보정: 면 윤곽에 덧그리는 선 폭(px, 최종 크기 기준) — 16·24px 에서 가는 갈래가 판색에 묻히지 않게.
TILE_BOLD = {16: 1.1, 20: 1.0, 22: 0.95, 24: 0.9, 28: 0.8, 32: 0.7, 33: 0.68, 40: 0.5, 44: 0.45, 48: 0.4}
# ARA 3 아이콘 줄 왼쪽 위 로고(22 논리 px) 전용 — 배율 100·125·150·200% 의 실제 픽셀. 사이 굵기는 이웃 값 사이(2026-11-12).
TILE_RAIL = (22, 28, 33, 44)


def tile_png(name, size, ss=16):
    N = size*ss
    k = N/1024
    pm = Image.new('L', (N, N), 0)
    ImageDraw.Draw(pm).rounded_rectangle([0, 0, N-1, N-1], radius=TILE_RX*N, fill=255)
    yy, xx = (np.mgrid[0:N, 0:N]+0.5)/N
    t = ((xx+yy)/2)[..., None]
    g0, g1 = rgb(TILE_GRAD[0]), rgb(TILE_GRAD[1])
    img = np.zeros((N, N, 4))
    img[..., :3] = g0+(g1-g0)*t
    img[..., 3] = (np.asarray(pm) > 0)*255
    f, _ = place(name, size, TILE_FILL)
    lab = Image.new('L', (N, N), 0)
    dr = ImageDraw.Draw(lab)
    fa, fb, _ = faces(name)
    w = TILE_BOLD.get(size, 0)*ss
    for v, face in ((1, fa), (2, fb)):
        pts = [tuple(p*ss) for p in polygon(face, f, 64)]
        dr.polygon(pts, fill=v)
        if w:
            dr.line(pts+[pts[0]], fill=v, width=max(1, round(w)), joint='curve')
    lab = np.asarray(lab)
    for v, key in ((1, 'a'), (2, 'b')):
        img[lab == v, :3] = rgb(TILE_STAR[key])
    return to_im(downsample(img, ss))


def svg_tile(name):
    f, _ = place(name, 1024, TILE_FILL)
    fa, fb, _ = faces(name)
    label = 'ARA' if name == 'ara' else 'Oriel'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="{label}">\n'
            f'  <defs><linearGradient id="{name}-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{TILE_GRAD[0]}"/><stop offset="1" stop-color="{TILE_GRAD[1]}"/></linearGradient></defs>\n'
            f'  <rect width="1024" height="1024" rx="{TILE_RX*1024:.0f}" fill="url(#{name}-tile)"/>\n'
            f'  <path d="{path_d(fa, f)}" fill="{TILE_STAR["a"]}"/>\n  <path d="{path_d(fb, f)}" fill="{TILE_STAR["b"]}"/>\n</svg>\n')


def build_tile(name):
    d = os.path.join(KIT, name)
    open(os.path.join(d, 'svg', f'{name}-tile.svg'), 'w', encoding='utf-8', newline='\n').write(svg_tile(name))
    pngs = {sz: tile_png(name, sz, 16 if sz <= 256 else 4) for sz in PNG_SIZES}
    for sz, im in pngs.items():
        im.save(os.path.join(d, 'png', f'{name}-tile-{sz}.png'))
    for sz in TILE_RAIL:
        if sz not in pngs:
            tile_png(name, sz).save(os.path.join(d, 'png', f'{name}-tile-{sz}.png'))
    save_ico([pngs[s] if s in pngs else tile_png(name, s) for s in ICO_SIZES], os.path.join(d, f'{name}-tile.ico'))


def tokens():
    out = {'measured_from': 'docs/brand/final/source-board.png (PIL, 면을 5px 깎은 안쪽 픽셀의 중앙값)'}
    for n in ('ara', 'oriel'):
        out[n] = {row: {k: {'flat': COL[n][row][k]['flat'], 'gradient': COL[n][row][k]['stops']} for k in ('a', 'b')} for row in ('light', 'dark')}
        out[n]['small_flat'] = SMALL[n]
        out[n]['app_icon_row'] = APP_ROW[n]
    out['macos_plate'] = {'top': PLATE[0], 'bottom': PLATE[1]}
    out['wordmark_ink'] = {'light': COL['board']['text_light'], 'dark': COL['board']['text_dark']}
    json.dump(out, open(os.path.join(KIT, 'tokens.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    css = ['/* 브랜드 토큰 — 생성물(scripts/build_kit.py). 마크·로고 자리에서만 쓴다(UI 신호색 아님). */', ':root {']
    for n in ('ara', 'oriel'):
        for row in ('light', 'dark'):
            for k in ('a', 'b'):
                g = COL[n][row][k]['stops']
                css.append(f'  --{n}-{row}-{k}: {COL[n][row][k]["flat"]}; --{n}-{row}-{k}-g0: {g[0]}; --{n}-{row}-{k}-g1: {g[1]}; --{n}-{row}-{k}-g2: {g[2]};')
        css.append(f'  --{n}-small-a: {SMALL[n]["a"]}; --{n}-small-b: {SMALL[n]["b"]};')
    css.append('}')
    open(os.path.join(KIT, 'tokens.css'), 'w', encoding='utf-8', newline='\n').write('\n'.join(css)+'\n')


if __name__ == '__main__':
    os.makedirs(KIT, exist_ok=True)
    for n in ('ara', 'oriel'):
        build(n)
    build_tile('ara')
    tokens()
    print('kit →', KIT)
