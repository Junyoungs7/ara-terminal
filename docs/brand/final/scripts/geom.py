"""ARA·Oriel 마크 기하 — marks.json(fit_marks.py 가 보드에 맞춘 상수)에서 면 2개를 3차 베지어로 만든다.
좌표계: 보드 픽셀. place() 로 원하는 캔버스에 옮긴다."""
import json, os, numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
M = json.load(open(os.path.join(HERE, 'marks.json'), encoding='utf-8'))



def bez(seg, n=48):
    p0, p1, p2, p3 = [np.asarray(p, float) for p in seg]
    t = np.linspace(0, 1, n)[:, None]
    return (1-t)**3*p0 + 3*(1-t)**2*t*p1 + 3*(1-t)*t**2*p2 + t**3*p3


def split(seg, t):
    p0, p1, p2, p3 = [np.asarray(p, float) for p in seg]
    a, b, c = p0+(p1-p0)*t, p1+(p2-p1)*t, p2+(p3-p2)*t
    d, e = a+(b-a)*t, b+(c-b)*t
    f = d+(e-d)*t
    return (p0, a, d, f), (f, e, c, p3)


def line(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    return (a, a+(b-a)/3, a+(b-a)*2/3, b)


def rev(seg):
    return tuple(seg[::-1])


def edges(name):
    m = M[name]
    T = [np.array(p, float) for p in m['tips']]
    C = np.array(m['C'], float)
    k = m['k']
    out = []
    for i in range(4):
        a, b = T[i], T[(i+1) % 4]
        out.append((a, a+k[2*i]*(C-a), b+k[2*i+1]*(C-b), b))
    return T, C, out


def faces(name):
    """→ (면 a, 면 b, fold) — ARA: a=위(꼬리·위 갈래), b=아래 갈래. Oriel: a=오른쪽, b=왼쪽. — 각 면은 닫힌 3차 베지어 목록. fold 는 접힘선 한 조각."""
    T, C, E = edges(name)
    if name == 'ara':
        # 접힘선은 보드에서 잰 3차 베지어(fit_marks.fit_ara_crease) — 노치 N 은 아래→왼쪽 변 위의 점
        cr = M['ara']['crease']
        N = np.array(cr['N'])
        pts = bez(E[2], 400)
        t = int(np.argmin(((pts-N)**2).sum(1)))/399
        e2a, e2b = split(E[2], t)          # 아래끝→노치, 노치→왼끝
        N = e2a[3]
        crease = (T[1], np.array(cr['c2']), np.array(cr['c1']), N)  # 오른쪽 끝 → 노치
        upper = [e2b, E[3], E[0], crease]           # 위 면(꼬리·위 갈래): 밝은 면
        lower = [E[1], e2a, rev(crease)]            # 아래 면(아래 갈래): 어두운 면
        return upper, lower, crease
    # Oriel: 위·아래 끝을 잇는 세로 접힘. 오른쪽이 밝은 면.
    fold = line(T[0], T[2])
    right = [E[0], E[1], rev(fold)]
    left = [E[2], E[3], fold]
    return right, left, fold


def bbox(name):
    T, C, E = edges(name)
    p = np.vstack([bez(e, 200) for e in E])
    return p.min(0), p.max(0)


def place(name, canvas, fill):
    """보드 좌표 → canvas 크기 정사각 캔버스. 마크 bbox 긴 변 = canvas*fill, bbox 중심을 가운데.
    반환: 함수 f(points) 와 배율."""
    lo, hi = bbox(name)
    s = canvas*fill/max(hi-lo)
    c = (lo+hi)/2
    off = np.array([canvas/2, canvas/2]) - c*s
    return (lambda p: np.asarray(p, float)*s+off), s


def path_d(face, f, nd=2):
    fmt = lambda p: f'{p[0]:.{nd}f} {p[1]:.{nd}f}'
    segs = [[f(p) for p in s] for s in face]
    d = 'M' + fmt(segs[0][0])
    for s in segs:
        d += ' C' + ' '.join(fmt(p) for p in s[1:])
    return d + 'Z'


def polygon(face, f, n=48):
    return np.vstack([f(bez(s, n))[:-1] for s in face])
