"""보드(source-board.png)의 두 마크 윤곽을 4갈래 별 곡선 모델로 맞춘다.
모델: 끝점 4개(위·오른쪽·아래·왼쪽) + 중심 C. 이웃 끝점 사이 변은 3차 베지어,
조절점 = 끝점 + k*(C - 끝점) → 오목한 변. 맞춘 상수는 marks.json 에 저장(생성 스크립트가 읽음).
실행: python fit_marks.py  (numpy·PIL 만 사용)"""
import json, os, numpy as np
from PIL import Image, ImageDraw
HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = os.path.join(HERE, '..', 'source-board.png')
A = np.asarray(Image.open(BOARD).convert('RGB')).astype(int)
BG = A[60, 60]

def bez(p0, p1, p2, p3, n=40):
    t = np.linspace(0, 1, n)[:, None]
    return (1-t)**3*p0 + 3*(1-t)**2*t*p1 + 3*(1-t)*t**2*p2 + t**3*p3

def outline(tips, C, ks, n=40):
    pts = []
    for i in range(4):
        a, b = tips[i], tips[(i+1) % 4]
        k1, k2 = ks[2*i], ks[2*i+1]
        pts.append(bez(a, a + k1*(C-a), b + k2*(C-b), b, n)[:-1])
    return np.vstack(pts)

def raster(poly, box, ss=1):
    x0, y0, x1, y1 = box
    im = Image.new('L', ((x1-x0)*ss, (y1-y0)*ss), 0)
    ImageDraw.Draw(im).polygon([((x-x0)*ss, (y-y0)*ss) for x, y in poly], fill=255)
    return np.asarray(im) > 127

def fit(name, box, tips, seed=0):
    x0, y0, x1, y1 = box
    target = np.abs(A[y0:y1, x0:x1]-BG).sum(-1) > 20  # 배경 잡음 p99.9 = 6 · Oriel 접힘 하이라이트(#FCE5DC)가 배경과 36 차이라 60 이면 구멍이 난다
    tips = np.array(tips, float)
    C = tips.mean(0); ks = np.full(8, 0.6)
    def score(C, ks, tips):
        m = raster(outline(tips, C, ks), box)
        return (m & target).sum() / (m | target).sum()
    best = score(C, ks, tips); rng = np.random.default_rng(seed)
    step = 1.0
    for it in range(24000):
        if it % 5000 == 4999: step *= 0.5
        C2, k2, t2 = C.copy(), ks.copy(), tips.copy()
        r = rng.integers(3)
        if r == 0: C2 += rng.normal(0, 4*step, 2)
        elif r == 1:
            j = rng.integers(8); k2[j] = np.clip(k2[j] + rng.normal(0, .08*step), 0.05, 1.3)
        else:
            j = rng.integers(4); t2[j] += rng.normal(0, 1.5*step, 2)
        s = score(C2, k2, t2)
        if s > best: best, C, ks, tips = s, C2, k2, t2
    print(name, 'IoU %.4f' % best)
    return dict(tips=tips.round(2).tolist(), C=C.round(2).tolist(), k=ks.round(4).tolist(), iou=round(best, 4), box=box)

def fit_ara_crease(m):
    """ARA 접힘선: 라이트 줄에서 세로로 훑어 '밝은 띠 → 어두운 아래 면' 명도 낙차가 가장 큰 y 를 잰다(x 214~284 —
    그 오른쪽은 두 면이 좁아 낙차가 안 잡힌다). 끝점 = 아래→왼쪽 변 위 가장 가까운 점(N)과 오른쪽 끝(T1).
    그 사이 3차 베지어 조절점 둘을 최소제곱으로."""
    L = A.sum(-1)
    mask = np.abs(A-BG).sum(-1) > 20
    pts = []
    for x in range(214, 286, 2):
        ys = np.nonzero(mask[200:400, x])[0]+200
        lo = ys.min()+int((ys.max()-ys.min())*0.35)   # 위 갈래 가장자리 낙차를 피한다
        g = np.convolve(np.diff(L[lo:ys.max()+1, x]), np.ones(3), 'same')
        pts.append((x, lo+int(np.argmin(g))))
    pts = np.array(pts, float)
    tips, C, k = np.array(m['tips']), np.array(m['C']), m['k']
    a, b = tips[2], tips[3]
    e2 = bez(a, a+k[4]*(C-a), b+k[5]*(C-b), b, 400)
    N = e2[np.argmin(((e2-pts[0])**2).sum(1))]
    T1 = tips[1]
    P = np.vstack([N, pts, T1])
    t = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]; t /= t[-1]
    B = np.stack([(1-t)**3, 3*(1-t)**2*t, 3*(1-t)*t**2, t**3], 1)
    rhs = P - np.outer(B[:, 0], N) - np.outer(B[:, 3], T1)
    sol, *_ = np.linalg.lstsq(B[:, 1:3], rhs, rcond=None)
    print('ara crease rms %.2fpx' % np.sqrt(((B[:, 1:3]@sol - rhs)**2).sum(1).mean()))
    return dict(N=N.round(2).tolist(), c1=sol[0].round(2).tolist(), c2=sol[1].round(2).tolist(), T1=T1.round(2).tolist(),
                samples=pts.tolist())


if __name__ == '__main__':
    out = {
        'ara': fit('ara', (30, 120, 368, 420), [(279, 139), (363, 259), (187, 397), (47, 304)]),
        'oriel': fit('oriel', (368, 120, 610, 420), [(471, 143), (585, 259), (471, 369), (374, 281)]),
    }
    out['ara']['crease'] = fit_ara_crease(out['ara'])
    json.dump(out, open(os.path.join(HERE, 'marks.json'), 'w'), indent=1)
