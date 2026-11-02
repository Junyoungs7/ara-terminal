# ARA 쪽 — 브랜드 마크 적용·규칙 (2026-11-02 확정)

키트: `D:\AI\OFA\docs\brand\final\kit\ara\` · 규칙의 뼈대는 `HANDOFF-oriel.md` 와 같다(3절 쓰임 규칙, 4절 모션). 여기는 ARA 에 다른 것만.

## 색 토큰 (보드에서 잰 값)
ARA 면: **a = 위 면(위 갈래 + 왼쪽 아래 꼬리)**, **b = 아래 갈래**. 접힘선 = 오른쪽 끝 → 아래·왼쪽 변의 오목점(보드에서 잰 3차 베지어).

| 변형 | 면 | 평면 | 그라데이션 0 · .5 · 1 |
|---|---|---|---|
| 밝은 바탕(light, 남색) | a | `#1C2C75` | `#08103B` · `#142161` · `#6665D4` (위 끝 → 접힘선 가운데) |
| 밝은 바탕(light) | b | `#373784` | `#806DC9` · `#313176` · `#35398D` |
| 어두운 바탕(dark, 밝은 보라) | a | `#686AE2` | `#5E61DA` · `#6868E1` · `#6662D7` |
| 어두운 바탕(dark) | b | `#9C88F8` | `#8A72D8` · `#A68DF8` · `#9688FC` |
| 작은 판(≤48px) 평면 2톤 | a / b | `#5E61DA` / `#A68DF8` | 다크 줄에서 a 는 가장 어두운 정지점, b 는 가장 밝은 정지점 |

**앱 아이콘·앱 안 마크는 dark(밝은 보라) 변형을 쓴다** — 바탕을 모르는 자리라서. 라이트 줄 남색은 `#202020` 작업 표시줄에 묻힌다. 남색 판(`ara-color.svg`)은 밝은 바탕이 확실한 자리(문서·사이트 밝은 화면)에만.

신호색 거리(`kit\signal-distance.md`): ARA 다크·작은 판 보라는 AI 신호(인디고~애저)와 ΔE 23~27(주의). **결정은 그대로** — 브랜드 보라는 마크 자리 안에서만, AI 가 일하는 신호(인디고→애저→스카이)는 바꾸지 않는다.

## 아라(v2.2, D:\AI\OFA-v22)에 적용한 것
- 설치본 아이콘: `resources/icons/ara-icon.ico` ← `kit/ara/ara.ico`(16~48 평면 판 + 64·256). 맥 `resources/icons/ara-icon.png` ← `ara-macos-1024.png`(검은 판).
- 마스터: `assets/brand/ara-icon.svg` ← `ara-color-dark.svg`, `assets/brand/ara-favicon.svg` ← `ara-flat.svg`.
- `npm run icons:svg`(scripts/make-brand-svg.mjs)를 **배포기**로 바꿈: 위 두 SVG → `resources/icons/ara-icon.svg`, `brandMark.ts`(면 경로·그라데이션), `index.html` 파비콘, `site/assets/ara-icon.svg`, `video/public/logo.svg`.
- `BrandOrb.tsx`(시작 화면·첫 인사): 고리+터미널 → 접힌 별. 색은 테마 강조색(`--accent`, 사람 앰버)을 더는 따르지 않고 브랜드 그라데이션 고정.
- 창 아이콘·트레이: v2.2 메인 프로세스는 `BrowserWindow({icon})` 도 트레이도 없다 — exe 아이콘(.ico)이 그대로 쓰인다. 바꿀 자리 없음.
- `UpdateProgress` 의 로고는 `assets/brand/ara-favicon.svg` 를 import — 파일 교체로 따라온다.

## 동작 중(working) 모션 — ARA
HANDOFF-oriel.md 4절과 같은 규칙·수치(A 빛남 2.4s, B 앞에서 본 궤도 −14°·납작 0.2·빛점 3.6s, transform·opacity 만, 빛 번짐은 `kit/motion/ara-glow.png` 층 opacity, 3초 게이트, reduced-motion 정지, 16–24px 은 A 만 또는 빛점 하나).
ARA 에서 붙일 자리 후보: AI 대화 패널의 "생각 중" 점 세 개(`.ara-think`) 옆/대신, 타이틀바·AI 탭의 마크. **아직 앱에 붙이지 않았다** — 자리와 게이트(최근 3초 명령) 연결은 메인 결정.
