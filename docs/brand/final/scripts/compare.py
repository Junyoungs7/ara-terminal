"""보드 vs 벡터 비교 이미지 — 보드 좌표 그대로 벡터를 그려 나란히(보드 | 벡터 | 겹쳐 보기 | 차이).
겹쳐 보기 = 보드 위에 벡터 윤곽(초록)·접힘선(빨강). 차이 = 윤곽 마스크 XOR(빨강=보드에만, 파랑=벡터에만).
→ ../compare/board-vs-vector.png"""
import os, numpy as np
from PIL import Image, ImageDraw
from geom import faces, polygon, bez, M, HERE
import build_kit as K

BOARD = Image.open(os.path.join(HERE, '..', 'source-board.png')).convert('RGB')
A = np.asarray(BOARD).astype(int)
OUT = os.path.join(HERE, '..', 'compare')
os.makedirs(OUT, exist_ok=True)
BOX = (30, 120, 610, 420)   # 두 마크를 다 담는 보드 영역(라이트 줄). 다크 줄은 y+503
ident = lambda p: np.asarray(p, float)


def vector_in_board(row, dy):
    x0, y0, x1, y1 = BOX
    bg = A[60, 60] if row == 'light' else A[700, 60]
    W, H = x1-x0, y1-y0
    canvas = np.zeros((H, W, 4)); canvas[..., :3] = bg; canvas[..., 3] = 255
    ss = 4
    for n in ('ara', 'oriel'):
        f = lambda p: np.asarray(p, float)-[x0, y0]
        lab = Image.new('L', (W*ss, H*ss), 0); dr = ImageDraw.Draw(lab)
        fa, fb, _ = faces(n)
        for v, face in ((1, fa), (2, fb)):
            dr.polygon([tuple(p*ss) for p in polygon(face, f, 64)], fill=v)
        lab = np.asarray(lab)
        yy, xx = (np.mgrid[0:H*ss, 0:W*ss]+0.5)/ss
        img = np.zeros((H*ss, W*ss, 4))
        for v, key in ((1, 'a'), (2, 'b')):
            m = lab == v
            c = K.COL[n][row][key]
            a, b = (f(np.array(p)) for p in c['axis'])
            t = (((xx-a[0])*(b[0]-a[0]) + (yy-a[1])*(b[1]-a[1])) / ((b-a) @ (b-a))).clip(0, 1)[m][:, None]
            st = [K.rgb(h) for h in c['stops']]
            img[m, :3] = np.where(t < .5, st[0]+(st[1]-st[0])*(t/.5), st[1]+(st[2]-st[1])*((t-.5)/.5))
            img[m, 3] = 255
        canvas = K.over(K.downsample(img, ss), canvas)
    return K.to_im(canvas).convert('RGB')


rows = []
for row, dy in (('light', 0), ('dark', 503)):
    x0, y0, x1, y1 = BOX
    board = BOARD.crop((x0, y0+dy, x1, y1+dy))
    vec = vector_in_board(row, dy)
    ov = board.copy(); d = ImageDraw.Draw(ov)
    tm = Image.new('L', board.size, 0); vm = Image.new('L', board.size, 0)
    for n in ('ara', 'oriel'):
        f = lambda p: np.asarray(p, float)-[x0, y0]
        fa, fb, fold = faces(n)
        for face in (fa, fb):
            p = polygon(face, f, 64)
            d.line([tuple(q) for q in p]+[tuple(p[0])], fill=(0, 200, 0), width=1)
            ImageDraw.Draw(vm).polygon([tuple(q) for q in p], fill=255)
        d.line([tuple(q) for q in f(bez(fold, 64))], fill=(230, 0, 0), width=1)
    bg = A[60, 60] if row == 'light' else A[700, 60]
    tmask = np.abs(np.asarray(board).astype(int)-bg).sum(-1) > 20
    vmask = np.asarray(vm) > 127
    diff = np.full(tmask.shape+(3,), 255, 'uint8')
    diff[tmask & vmask] = (200, 200, 200); diff[tmask & ~vmask] = (220, 0, 0); diff[~tmask & vmask] = (0, 60, 230)
    iou = (tmask & vmask).sum()/(tmask | vmask).sum()
    both = tmask & vmask
    err = np.abs(np.asarray(board).astype(int)-np.asarray(vec).astype(int)).sum(-1)[both].mean()/3
    print(row, 'IoU %.3f  color err %.1f/255' % (iou, err))
    tiles = [board, vec, ov, Image.fromarray(diff)]
    W, H = board.size
    sheet = Image.new('RGB', (W*4+30, H+28), (255, 255, 255))
    dd = ImageDraw.Draw(sheet)
    for i, (t, lab) in enumerate(zip(tiles, ('board', 'vector', 'overlay', f'diff  IoU {iou:.3f}'))):
        sheet.paste(t, (i*(W+10), 28)); dd.text((i*(W+10)+4, 8), f'{row}: {lab}', fill=(0, 0, 0))
    rows.append(sheet)
out = Image.new('RGB', (rows[0].width, sum(r.height for r in rows)), (255, 255, 255))
y = 0
for r in rows:
    out.paste(r, (0, y)); y += r.height
out.save(os.path.join(OUT, 'board-vs-vector.png'))
out.resize((out.width*2, out.height*2), Image.LANCZOS).crop((0, 0, out.width*2, out.height)).save(os.path.join(OUT, 'board-vs-vector-light-2x.png'))
print('ok', os.path.join(OUT, 'board-vs-vector.png'))
