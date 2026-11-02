# Oriel 넘김 — 브랜드 마크 키트 (2026-11-02 확정)

확정 보드: `D:\AI\OFA\docs\brand\final\source-board.png` (준영님 2026-11-02).
키트 위치: `D:\AI\OFA\docs\brand\final\kit\oriel\` · 한눈에 보기: `kit\index.html` · 모션 데모: `kit\motion\working-demo.html`.
**손으로 고치지 말 것** — 전부 `docs\brand\final\scripts\` 가 굽는다(아래 "다시 굽기").

## 1. 쓸 파일

| 자리 | 파일 | 비고 |
|---|---|---|
| Windows 앱·설치 프로그램 아이콘(electron-builder `win.icon`) | `kit\oriel\oriel.ico` | 16·20·24·32·40·48·64·256 다중. 16~48 은 평면 2톤 판(픽셀 정렬), 64·256 은 그라데이션. **.ico 를 그대로 줄 것**(PNG 를 주면 256 한 장짜리가 된다) |
| macOS 앱 아이콘(`mac.icon`) | `kit\oriel\oriel.icns` 또는 `kit\oriel\png\oriel-macos-1024.png` | 검은 둥근 사각 판(1024 캔버스 안 824, 반경 185) 위 마크. iconset 폴더 `oriel.iconset\` 도 있음 — 맥에서 `iconutil -c icns oriel.iconset` 로 다시 만들 수 있다 |
| 창 아이콘(`BrowserWindow({icon})`, Windows/Linux) | `kit\oriel\png\oriel-256.png` (또는 .ico) | 바탕 투명 |
| 트레이 | `kit\oriel\png\oriel-16.png`·`-20`·`-24`·`-32` (DPI 별) | **평면 2톤 판만**. 트레이에 그라데이션 판 금지 |
| 설정·정보 화면의 로고 | `kit\oriel\svg\oriel-wordmark.svg`(밝은 바탕) · `oriel-wordmark-dark.svg`(어두운 바탕) | 글자는 Pretendard Regular(400) 윤곽으로 바꿔 넣었다 — 글꼴 없어도 같다 |
| 앱 안 마크(시작 화면·빈 화면·AI 아바타) | `svg\oriel-color.svg` / `oriel-color-dark.svg` | 인라인 SVG 로 넣을 땐 그라데이션 id 가 겹치지 않게(React `useId`) |
| 48px 이하 앱 안 마크·파비콘 | `svg\oriel-flat.svg` | 평면 2톤 |
| 한 색만 되는 자리(인쇄·워터마크·OS 템플릿 아이콘) | `svg\oriel-mono.svg` | `currentColor`. 면 b(왼쪽)는 60% — 단색에서도 접힘이 남는다 |
| PNG 모음 | `png\oriel-{16,20,24,32,40,48,64,128,256,512,1024}.png` | 48 이하는 평면 판 |
| 색 토큰 | `kit\tokens.json` · `kit\tokens.css` | |

## 2. 색 토큰 (보드에서 PIL 로 잰 값 — 면을 5px 깎은 안쪽 픽셀 중앙값)

Oriel 면: **a = 오른쪽(밝은 면, 주황)**, **b = 왼쪽(어두운 면, 산호빨강)**. 접힘선 = 위 끝과 아래 끝을 잇는 세로선.

| 변형 | 면 | 평면(중앙값) | 그라데이션 정지점 0 · .5 · 1 | 축 |
|---|---|---|---|---|
| 밝은 바탕(light) | a 오른쪽 | `#E87A53` | `#F69353` · `#E6784F` · `#D95C57` | 위 끝 → 아래 끝 |
| 밝은 바탕(light) | b 왼쪽 | `#F78467` | `#DE585C` · `#F0735F` · `#FDA481` | 왼 끝 → 접힘선 가운데 |
| 어두운 바탕(dark) | a 오른쪽 | `#EE7B51` | `#F99956` · `#EE7C50` · `#D35251` | 위 끝 → 아래 끝 |
| 어두운 바탕(dark) | b 왼쪽 | `#F5775B` | `#E5595C` · `#F5725B` · `#EC7852` | 왼 끝 → 접힘선 가운데 |
| **작은 판(≤48px) 평면 2톤** | a 오른쪽 | `#F69353` | — | |
| **작은 판(≤48px) 평면 2톤** | b 왼쪽 | `#DE585C` | — | |
| macOS 판 | 위 → 아래 | `#242325` → `#151516` | | |
| 워드마크 글자 | 밝은 바탕 / 어두운 바탕 | `#131317` / `#FEFEFE` | | |

참고 — 같은 보드의 ARA: 남색→보라(라이트 면a `#1C2C75`, 다크 면a `#686AE2`·면b `#9C88F8`). 전체 표는 `kit\tokens.json`.

### 앱 신호색과의 거리 (`kit\signal-distance.md`, ΔE76)
- Oriel 작은 판 주황 `#F69353` ↔ 사람 앰버 `#FFB547` = **22.8 (주의)**. 나란히 두면 같은 계열로 읽힐 수 있다. 결정은 바꾸지 않는다 — 대신 아래 쓰임 규칙 1 을 지킨다.
- 나머지 Oriel 토큰은 30 이상(구분됨).

## 3. 쓰임 규칙

1. **브랜드 색은 마크·로고 자리 안에서만.** UI 신호색(사람 = 앰버, AI = 인디고→애저→스카이, 시안 C `c.css`)은 그대로 둔다. 버튼·강조·선택·포커스에 브랜드 주황/산호를 쓰지 않는다 — 앰버와 겹쳐 "사람" 신호가 흐려진다.
2. **48px 이하는 평면 2톤 판**(`*-flat.svg`, PNG 16~48). 그라데이션을 줄이지 말 것 — 16px 에서 그라데이션은 얼룩이 되고 접힘이 사라진다.
3. **접힘(두 면 명암)은 모든 크기에서 남긴다.** 접힘과 비대칭 비례가 이 마크를 흔한 AI ✦ 반짝이와 가르는 유일한 것이다. 한 색 판도 면 b 를 60% 로 남긴다.
4. 작은 판은 픽셀 정렬돼 있다(bbox 왼쪽 위가 정수 픽셀, 여백 1%, 알파 감마 0.75 로 가는 끝 보강). 다른 크기로 늘이지 말고 가장 가까운 크기 파일을 쓴다.
5. 마크를 돌리거나 기울이거나 비율을 바꾸지 않는다. 그림자·외곽선 추가 금지(모션의 빛 번짐 층은 예외 — 4절).
6. 앱 아이콘(작업 표시줄)은 바탕이 투명 — 라이트(`#F3F3F3`)·다크(`#202020`) 작업 표시줄 둘 다 확인함(`compare\taskbar-16-48.png`).
7. 맥은 반드시 검은 판 판(`*-macos-*`)을 쓴다 — 맥 Dock 은 판 없는 아이콘을 다른 앱과 크기가 안 맞게 보인다.

## 4. 동작 중(working) 모션

옛 마크의 도는 고리를 대신한다. 데모: `kit\motion\working-demo.html` (A·B × 512/64/24/16 × 다크/라이트, "명령 보내기" 3초 게이트 데모 포함).

**A — 빛남(기본)**
- 접힌 두 면이 엇갈려 밝아진다: 면마다 흰 덧칠 층(면 경로 그대로, 흰색) — a 는 opacity .22→0→.22, b 는 0→.22→0. 주기 **2.4s**, `ease-in-out`(넘침 없음).
- 빛 번짐 숨쉬기: **미리 흐리게 구운 PNG 층**(`kit\motion\oriel-glow.png`, 상자보다 사방 25% 크게)의 opacity 만 .15↔.55, 같은 주기.

**B — A + 앞에서 본 궤도**
- 납작한 타원(세로/가로 **0.2**, 가로 반지름 = 상자의 **0.46**)이 **−14°** 기울어 별을 가로지른다. 선 굵기 max(1px, 상자×0.006), 색 = 작은 판 밝은 면 색, 앞 반 불투명도 .85 · 뒤 반 .4.
- 빛점(흰 중심 → 브랜드색 둥근 그라데이션, 지름 max(3px, 상자×0.05))이 한 바퀴 **3.6s**, `linear`.
- **가림은 층 순서로**: 쌓는 순서 = 빛 번짐 → 뒤 반 타원 → 뒤 빛점 → 별 → 덧칠 a·b → 앞 반 타원 → 앞 빛점. 앞 반 = 아래쪽 반(관찰자 쪽). 빛점 두 벌이 `steps` 로 반 주기씩 번갈아 보인다(앞 0~50%, 뒤 50~100%).
- 빛점 이동은 transform 만: `rotate(-14°) scaleY(.2)` > `rotate(φ)` 애니메이션 > `translateX(R)` > `rotate(-φ)` 애니메이션 > `scaleY(5)` — 행렬이 상쇄돼 빛점이 동그란 채 타원 위를 돈다. `offset-path` 는 쓰지 않는다(합성기 밖).

**구현 제약**
- 움직이는 속성은 **transform · opacity 뿐**. 프레임마다 `filter: blur()`·`box-shadow`·SVG 속성 바꾸기 금지(아크릴 창 다시 그리기가 비싸다 — iGPU ~25% 측정).
- 덧칠은 면마다 따로 된 `<svg>` 상자로 만들고 그 상자의 opacity 를 움직인다(데모 방식). 이 Edge 에서는 SVG 안 `<path>` opacity 도 메인 스레드 비용 0 으로 쟀지만(`scripts\control.cjs`), 상자 쪽이 합성기 층으로 확실하다.
- **게이트**: 에이전트가 최근 **3초** 안에 명령을 냈을 때만 `.working` — 그 밖엔 정지 마크.
- `prefers-reduced-motion: reduce` → 모든 애니메이션 끔, 빛점 숨김(정지한 별, 궤도 선은 정지 상태로 남아도 됨).

**작은 크기 규칙**
- **16–24px: A(빛남)만.** 궤도 선은 그리지 않는다 — 1px 타원이 별을 가로지르면 별 모양이 깨진다. B 를 꼭 써야 하면 **빛점 하나(점)만**(데모의 "B(≤24: 빛점만)").
- 64px 이상: A 또는 B.

**비용 측정**(`scripts\perf.cjs`, 헤드리스 msedge, B 모드 64px 6개 동시, 5초)
| | 마크 0개 | 마크 6개 |
|---|---|---|
| 프레임 간격 평균 / p95 / 최대 | 16.67 / 16.8 / 16.8 ms | 16.67 / 16.8 / 16.8 ms |
| 33ms 넘은 프레임 | 0 | 0 |
| 스타일 재계산 · 레이아웃 (rAF 없는 5초) | 0 · 0 | 0 · 0 |
| 메인 스레드 작업 시간 | 0.002 s | 0.006 s |

→ 애니메이션 전부가 합성기에서 돈다(메인 스레드 0). 양성 대조(`scripts\control.cjs`): 같은 지표가 `left` 애니메이션(메인 스레드) 하나에서는 재계산 121회/2초를 잡는다 — 0 은 "못 잡는다"가 아니라 "없다". 주의: rAF 를 함께 돌리면 메인 프레임이 매번 생겨 합성기 애니메이션도 재계산 수에 잡힌다(그래서 ①을 rAF 없이 잰다).
**한계**: 헤드리스 합성이라 GPU 래스터·페인트·아크릴 뒤 합성 비용은 이 숫자에 없다 — Oriel 실창에서 iGPU 를 다시 잴 것.

## 5. 다시 굽기

```
cd D:\AI\OFA\docs\brand\final\scripts
python fit_marks.py        # 보드 → marks.json (윤곽 IoU ARA .955 · Oriel .946, ARA 접힘선 rms 0.87px)
python measure_colors.py   # 보드 → colors.json
python build_kit.py        # → kit\ (SVG·PNG·ICO·ICNS·iconset·tokens)
python build_motion.py     # → kit\motion\
python compare.py          # → compare\board-vs-vector.png
python signal_distance.py  # → kit\signal-distance.md
```
의존: numpy · Pillow · fontTools(+brotli). npm 의존성 없음. 스크린샷·측정은 `NODE_PATH=D:/AI/OFA/node_modules node shot.cjs|perf.cjs`(헤드리스 msedge, 창 안 뜸).

## 6. 알려진 차이(보드 대비)

- 보드의 접힘선 흰 하이라이트 띠·종이 질감은 넣지 않았다(평면 그라데이션 2면). 비교: `compare\board-vs-vector.png`.
- 워드마크는 커닝 미적용(Pretendard 기본 advance). "Oriel" 은 커닝 쌍이 거의 없어 차이가 작다.
- .icns 는 PNG 엔트리로 직접 조립(ic04~ic14) — 맥에서 열어 확인한 적은 없다. 문제가 있으면 `oriel.iconset` 을 `iconutil` 로.
