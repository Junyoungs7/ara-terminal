"""보드에서 면별 색을 잰다(PIL·numpy). 면을 5px 깎은 안쪽 픽셀만 — 가장자리 섞임을 뺀다.
각 면의 그라데이션 축으로 투영해 0~20% · 40~60% · 80~100% 구간 중앙값 = 그라데이션 세 정지점,
면 전체 중앙값 = 평면 색. 라이트 줄(보드 위) · 다크 줄(아래, y+503)을 따로. → colors.json"""
import json, os, numpy as np
from PIL import Image, ImageDraw, ImageFilter
from geom import faces, edges, polygon, bez, HERE

A = np.asarray(Image.open(os.path.join(HERE, '..', 'source-board.png')).convert('RGB')).astype(float)
DARK_DY = 503   # 다크 줄은 같은 마크가 503px 아래(윤곽 bbox 로 잼: 위 끝 139 → 642)


def axes(name):
    """면별 그라데이션 축(보드 좌표 시작·끝)."""
    T, C, E = edges(name)
    lf, df, fold = faces(name)  # a = ARA 위 면 · Oriel 오른쪽 면, b = 나머지
    if name == 'ara':
        cm = fold[0]*0.5 + fold[3]*0.5
        return {'a': (T[0], bez(fold, 3)[1]), 'b': (cm, T[2])}  # a: 위 끝 → 접힘선 가운데(남색 → 밝은 띠). 꼬리→오른끝 축보다 라이트 색 오차 21.6 → 17.1
    fm = (fold[0]+fold[3])/2
    return {'a': (T[0], T[2]), 'b': (T[3], fm)}


def hexc(v):
    return '#%02X%02X%02X' % tuple(int(round(x)) for x in v)


def face_mask(face):
    im = Image.new('L', (A.shape[1], A.shape[0]), 0)
    ImageDraw.Draw(im).polygon([tuple(p) for p in polygon(face, lambda p: p)], fill=255)
    im = im.filter(ImageFilter.MinFilter(11))  # 5px 깎기
    return np.asarray(im) > 127


def measure(name):
    lf, df, _ = faces(name)
    ax = axes(name)
    out = {}
    for row, dy in (('light', 0), ('dark', DARK_DY)):
        r = {}
        for key, face in (('a', lf), ('b', df)):
            m = face_mask(face)
            ys, xs = np.nonzero(m)
            px = A[ys+dy, xs]
            a, b = (np.asarray(p, float) for p in ax[key])
            t = ((np.stack([xs, ys], 1)-a) @ (b-a)) / ((b-a) @ (b-a))
            t0, t1 = t.min(), t.max()          # 깎은 면은 끝이 비므로 실제 픽셀 범위로 다시 잡는다
            a, b = a+(b-a)*t0, a+(b-a)*t1
            t = (t-t0)/(t1-t0)
            stops = []
            for lo, hi in ((-1, .2), (.4, .6), (.8, 2)):
                sel = (t >= lo) & (t <= hi)
                stops.append(hexc(np.median(px[sel], 0)))
            r[key] = {'flat': hexc(np.median(px, 0)), 'stops': stops,
                      'axis': [list(map(float, a)), list(map(float, b))]}
        out[row] = r
    return out


if __name__ == '__main__':
    res = {n: measure(n) for n in ('ara', 'oriel')}
    def at(x, y):
        return hexc(np.median(A[y-3:y+4, x-3:x+4].reshape(-1, 3), 0))
    res['board'] = {'bg_light': at(60, 60), 'bg_dark': at(60, 700),
                    'plate_top_dark': at(770, 700), 'plate_bottom_dark': at(770, 830),
                    'plate_top_light': at(770, 195), 'plate_bottom_light': at(770, 330),
                    'text_light': None, 'text_dark': None}
    # 워드마크 글자색: 'ARA' 글자 획 안쪽(가장 어두운/밝은 픽셀 중앙값)
    tl = A[250:292, 1180:1265].reshape(-1, 3); lum = tl.sum(1)
    res['board']['text_light'] = hexc(np.median(tl[lum < np.percentile(lum, 8)], 0))
    td = A[752:794, 1180:1265].reshape(-1, 3); lum = td.sum(1)
    res['board']['text_dark'] = hexc(np.median(td[lum > np.percentile(lum, 92)], 0))
    json.dump(res, open(os.path.join(HERE, 'colors.json'), 'w'), indent=1)
    print(json.dumps(res, indent=1))
