# 브라우저(현 Sonar) 새 이름 — 최종 후보 (brand-ideation Stage 2)

작성 2026-11-01 · 전체 후보 50개(kill file): `naming-explorations.md` · 비교 페이지: `D:\AI\OFA\mockups\v2\naming\index.html` · **로고는 그리지 않았다**
Sonar(ai-browser) 세션 후보(Mullion·Teum·Tandem·Oriel·Sill)와 추가 회피 목록·이름 변경 비용 메모를 반영했다.

## 0. 바탕
- **바꾸는 이유**: 사용자가 전부 개발자인데 "Sonar" 는 SonarQube(SonarSource)와 겹친다.
- **포지셔닝**: "보여 주되 끼어들지 않는다" + "도구는 정직하고, 사람이 주인이다" (`brand-ideation.md` P3·P5)
- **무드**: M2 먹과 한 획 + M3 정직한 기구. 짝은 ARA(작업대, "만든다") ↔ 브라우저(창, "본다")
- **브라우저 성격**: 같은 창을 함께 본다 · 운전대는 사람 · AI 작업은 옅은 베일 · 포커스를 뺏지 않음 · 조용함
- **이름이 해야 할 일 (Sonar 세션 메모)**: 내부 id `aibrowser`·MCP 도구 접두사 `aib_*` 는 그대로 둔다. 새 이름은 **화면 표시·브랜드 이름 + URL 스킴**(`name://newtab`)으로만 쓰인다 → 소문자로 짧게 쓸 수 있으면 좋다.
- **거르는 기준 (6+1, +보조 1)**: ①발음(한·영) ②철자 ③가용성(같은 이름의 브라우저·개발 도구·AI 제품, npm·GitHub 흔한 정도. 도메인·상표는 참고만) ④분야 내 독특함 ⑤확장성 ⑥부정 연상 ⑦ARA 짝 어울림 · 보조: URL 스킴(`name://`)으로 쓸 만한가
- 판정: ○ 통과 / △ 주의 / × 탈락

## 1. 추천

| 순위 | 이름 | 한 줄 이유 |
|---|---|---|
| **1** | **Boda (보다)** | "ARA와 보다" 가 그대로 문장이 된다 — "아라와 (함께) 본다". 두 이름 모두 우리말이라 짝이 자연스럽다. 브라우저·개발 도구 쪽에서 같은 이름을 찾지 못했다. `boda://newtab` 도 짧다. |
| **2** | **Oriel (오리엘)** | 벽 밖으로 튀어나온 돌출창 — 방 안에 머문 채 바깥을 본다 = "보여 주되 끼어들지 않는다". 건축·기구 느낌이라 M3 와 맞는다. Sonar 세션과 내가 따로 같은 이름을 골랐다. 겹치는 건 작은 유료 AI 프롬프트 상품 하나. |
| **3** | **Mullion (멀리언)** | 창 하나를 두 칸으로 가르는 창살 = 사람과 AI 가 한 창을 보되 경계가 있다. 뜻이 협업 구조를 가장 정확히 말한다(Sonar 세션 1순위). 겹치는 제품 없음. 다만 "million" 오독·낯선 단어라는 철자 약점이 있다. |

차점: **Sill** (짧고 조용하지만 너무 흔한 단어라 검색에 묻힘), **Duri** (뜻 최고, ARA 와 끝소리 -라/-리가 닮음).
**탈락 확정**: **Tandem** — 개발팀용 협업 앱(Tandem 가상 오피스, tandem.chat)이 이미 있다. **Still** — 한국어로 "스틸" 이라 브라우저 자동화 도구 **Steel** 과 소리가 같다.

## 2. 최종 후보 12개

### ① Boda — 보다
- **방식**: Suggestive(우리말 동사 그대로, ARA 와 같은 "우리말 이름" 계열)
- **뜻·이유**: "보다" = 본다. 브라우저가 하는 일 하나만 말하고, 무엇을 해 주겠다고 약속하지 않는다(끼어들지 않음). 스페인어로 "결혼식" — 짝이라는 뜻과 오히려 맞는다.
- **발음**: 보다 / 영어 BOH-dah · **스킴**: `boda://newtab`
- **ARA 와**: "ARA와 Boda" → 읽으면 "아라와 보다". 작업은 ARA 에서, 보는 건 Boda 에서.
- **겹치는 제품**: 브라우저·개발 도구·AI 앱 검색에서 같은 이름 없음(가까운 것 Bodhi Browser Extension — https://chromewebstore.google.com/detail/bodhi-browser-extension/bjdjhiombmfbcoeojijpfckljjghmjbf). npm 정확히 "boda" 패키지 검색 결과 없음(유사 generator-bode — https://npmjs.com/package/generator-bode). 동아프리카 "boda-boda"(오토바이 택시)는 다른 분야.

### ② Oriel — 오리엘
- **방식**: Metaphor(건축 — 돌출창)
- **뜻·이유**: 2층 벽에서 튀어나온 창. 안에 있으면서 세 방향을 본다. 창 = 브라우저, "안에 머문 채 본다" = 운전대는 사람. (Sonar 세션: Leica/Braun 무드와 맞음)
- **발음**: 오리엘 / 영어 OR-ee-ul · **스킴**: `oriel://newtab`
- **ARA 와**: "ARA와 Oriel" — 둘 다 모음 시작, 3·5글자. 첫 모음(아/오)이 달라 구별된다.
- **겹치는 제품**: "Oriel – Chrome Extension Developer" AI 스킬(유료 프롬프트 상품, KissMySkills) — https://kissmyskills.com/products/oriel-chrome-extension-developer. 브라우저·개발 도구 본체로는 없음. Oriel College 등 일반 고유명사 많음.

### ③ Mullion — 멀리언 (Sonar 세션 후보)
- **방식**: Metaphor(건축 — 창살, 창을 세로로 나누는 기둥)
- **뜻·이유**: 한 창을 두 칸으로 나누는 창살. 사람 칸과 AI 칸이 같은 창에 있되 경계가 분명하다 — AI 작업 베일, 포커스를 뺏지 않음과 맞다.
- **발음**: 멀리언 / 영어 MUL-yun · **스킴**: `mullion://newtab`
- **ARA 와**: "ARA와 Mullion" — 3·7글자, 모음 시작 ↔ 자음 시작 대비. 리듬 무난.
- **겹치는 제품**: 앱·소프트웨어·브라우저·개발 도구 검색에서 같은 이름 없음.
- **주의**: 영어 화자에게도 낯선 건축 용어, "million" 으로 잘못 읽기 쉽다. 창을 "가른다" 는 그림이 ARA 터미널의 분할 pane 과 겹쳐 보일 수 있다(회피 목록의 Pane 과 같은 동네).

### ④ Sill — 실 (양쪽 공통 후보)
- **방식**: Metaphor(창턱)
- **뜻·이유**: 창 아래 턱. 기대어 내다보는 자리. 창 자체가 아니라 "창가에 같이 서 있다".
- **발음**: 실 / 영어 SIL · **스킴**: `sill://newtab`
- **ARA 와**: "ARA와 Sill" — 3·4글자, 모음 ↔ 자음 시작.
- **겹치는 제품**: 브라우저·개발 도구 검색에서 없음. Sonar 세션 지적대로 **너무 짧고 흔해 검색에 묻힌다**. 영어 "silly" 소리.

### ⑤ Duri — 두리
- **방식**: Coined(우리말 "둘이" 를 이름처럼)
- **뜻·이유**: "둘이(서)" — 사람과 AI 둘이 같은 창을 본다. "두리번거리다"(둘러보다)와도 이어진다.
- **발음**: 두리 / 영어 DOO-ree · **스킴**: `duri://newtab`
- **ARA 와**: "ARA와 Duri" — 뜻은 좋지만 아라/두리 끝소리가 닮아 빠르게 말하면 섞일 수 있다.
- **겹치는 제품**: 검색에서 같은 이름의 브라우저·개발 도구·AI 앱 없음.

### ⑥ Teum — 틈 (Sonar 세션 후보)
- **방식**: Coined(우리말 "틈")
- **뜻·이유**: 벽의 틈으로 들여다본다, 일과 일 사이의 틈. ARA 와 같은 우리말 계열.
- **발음**: 틈 / 영어 화자는 "티엄"·"팀(team)" 으로 읽음 · **스킴**: `teum://newtab`
- **ARA 와**: "ARA와 Teum" — 한국어로는 "아라와 틈" 으로 예쁘다.
- **겹치는 제품**: 같은 이름 없음(비슷한 Teem 회의실 앱, Temu 쇼핑앱, TM Browser — https://global.jiran.com/?p=4193).
- **주의(사실상 탈락 쪽)**: 로마자 "Teum" 이 영어로 읽히지 않아 **철자 ×** — team·Temu 로 오독. 한국어로도 "빈틈"(허점)·"틈타다"(몰래 기회를 노리다) 연상이 있어 "정직한 도구" 와 부딪친다.

### ⑦ Loupe — 루페
- **방식**: Metaphor(정밀 광학 기구 — 보석상 확대경)
- **뜻·이유**: 눈에 대고 가까이 보는 작은 렌즈. M3 "정직한 기구"에 가장 직접적.
- **발음**: 루페(한국 통용) / 영어 LOOP · **스킴**: `loupe://newtab`
- **겹치는 제품**: GNOME 기본 이미지 뷰어 "Loupe"(GNOME 45부터) — https://en.wikipedia.org/wiki/Loupe_(software). 영어 발음이 "loop" 와 같아 개발자에게 혼동. 회피 목록의 Lens 와 같은 계열.

### ⑧ Okno — 오크노
- **방식**: Coined(외국어 차용 — 폴란드·러시아어 "창")
- **뜻·이유**: 뜻은 "창" 이지만 대부분에게 만든 말처럼 들린다. 짧고 둥근 O 두 개.
- **발음**: 오크노 / 영어 OK-no · **스킴**: `okno://newtab`
- **ARA 와**: "ARA와 Okno" — 둘 다 모음 시작, 대칭.
- **겹치는 제품**: 검색에서 없음(비슷한 Oku 브라우저 — https://github.com/OkuBrowser/oku). 영어로 "OK, no" 로 읽히는 농담 여지.

### ⑨ Overt — 오버트
- **방식**: Suggestive(드러난 ↔ covert)
- **뜻·이유**: "숨기지 않는" — P5 "도구는 정직하다" 를 한 단어로.
- **발음**: 오버트 / 영어 oh-VURT · **스킴**: `overt://newtab`
- **겹치는 제품**: 검색에서 없음. **한국어 "오버하다"(과하게 굴다)** 연상 — "끼어들지 않는다" 와 정반대라 부정 연상 ×.

### ⑩ Vitrine — 비트린
- **방식**: Metaphor(유리 진열장)
- **뜻·이유**: 유리 너머로 본다, 안에서 무엇이 일어나는지 다 보인다.
- **발음**: 비트린 / 영어 vi-TREEN · **스킴**: `vitrine://newtab`
- **겹치는 제품**: Shopify 3D 뷰어 앱 — https://apps.shopify.com/vitrine, 수집가 앱 MyVitrine 등(개발 도구 아님). 진열장 = "보기만 하고 만지지 마라" 라서 "운전대는 사람" 과 어긋난다.

### ⑪ Sightglass — 사이트글라스
- **방식**: Compound(sight + glass) / 기구 은유(보일러·탱크의 액면 확인 창)
- **뜻·이유**: 기계 안 상태를 정직하게 보여 주는 작은 유리창. M3 그대로.
- **스킴**: `sightglass://newtab`(길다)
- **겹치는 제품**: Bytecode Alliance 의 Wasmtime 벤치마크 도구 — https://github.com/bytecodealliance/sightglass. 같은 개발 도구 범주. 회피 목록의 Glass 포함. "ARA와 Sightglass" 3 대 10글자 리듬 불균형.

### ⑫ ARA View — 아라 뷰
- **방식**: Descriptive
- **뜻·이유**: 말 그대로 "ARA 의 보기 창". 가장 안전하고, 가족 관계가 즉시 읽힌다.
- **스킴**: `araview://newtab`(띄어쓰기 없앤 형태)
- **ARA 와**: "ARA와 ARA View" — 짝이 아니라 부속품처럼 들린다.
- **겹치는 제품**: 일반 단어 조합이라 별도 조회 안 함(공백).

## 3. 6+1 기준 표 (+ URL 스킴)

| 이름 | 발음 | 철자 | 가용성 | 독특함 | 확장성 | 부정 연상 | ARA 짝 | 스킴 | 결론 |
|---|---|---|---|---|---|---|---|---|---|
| **Boda** | ○ | ○ | ○ | △ 흔한 우리말이라 검색 섞임 | ○ | ○ | ○ 문장이 됨 | ○ | **1순위** |
| **Oriel** | ○ | △ Oriol·Oreal 오타 | △ AI 프롬프트 상품 1건 | ○ | ○ | △ 오리(duck) 약함 | ○ | ○ | **2순위** |
| **Mullion** | △ 낯섦 | △ million 오독 | ○ | ○ | ○ | ○ | ○ | ○ | **3순위** |
| Sill | ○ | △ Sil·Cill | ○ | △ 짧고 흔해 검색에 묻힘 | ○ | △ silly | ○ | ○ | 차점 |
| Duri | ○ | ○ | ○ | ○ | ○ | ○ | △ 아라/두리 소리 닮음 | ○ | 차점 |
| Teum | △ 영어로 못 읽음 | **×** team·Temu | ○ | ○ | ○ | △ 빈틈·틈타다 | ○ | ○ | 탈락 쪽 |
| Loupe | △ 영어 = loop | △ | △ GNOME Loupe | △ Lens 계열 | ○ | ○ | ○ | ○ | 주의 2 |
| Okno | ○ | ○ | ○ | ○ | ○ | △ "OK, no" | ○ | ○ | 후보 |
| Overt | ○ | ○ | ○ | ○ | ○ | **×** "오버하다" | ○ | ○ | 탈락 쪽 |
| Vitrine | △ | △ | △ 비개발 앱 다수 | ○ | ○ | △ "만지지 마라" | △ 길다 | ○ | 약함 |
| Sightglass | ○ | ○ | △ Wasm 벤치마크 | △ Glass 포함 | ○ | ○ | **×** 리듬 | △ 길다 | 약함 |
| ARA View | ○ | ○ | 미조회 | × 일반어 | △ | ○ | × 부속품처럼 | △ | 안전한 대안 |

## 4. 겹침 확인 — 회피 목록 대조
Sonar 세션이 준 회피 목록(브라우저·에이전트·개발 의미 단어)과 최종 12개를 대조했다. **정확히 같은 이름은 0개.** 소리·계열이 가까운 것만 적는다.

| 회피 목록 항목 | 가까운 후보 | 판단 |
|---|---|---|
| Lens (개발 의미) | Loupe | 같은 "렌즈" 계열 → △ |
| Glass (개발 의미) | Sightglass | 단어 포함 → △ |
| Pane (개발 의미) | Mullion | 창을 가르는 그림이 pane 분할과 가까움 → △ |
| Steel (브라우저 자동화) | Still(kill file) | 한국어 "스틸" 소리 동일 → **Still 탈락** |
| Orion (Kagi 브라우저) | Oriel | 첫 세 글자 O-r-i 같음 → △, 소리는 구별됨 |
| Opera / Arc / Atlas / Comet / Dia / Zen 등 나머지 브라우저 | 없음 | ○ |
| Operator / Manus / Devin / Copilot 등 에이전트 | 없음 | ○ |
| BOM (개발 의미) | Bom(봄, kill file) | **Bom 탈락** |
| Sonar, Helm, Tiller, Harbor, Prism, Skylight, Beacon, Lookout, Periscope, Lumen, Scope | 없음(Prism·Lumen·Lookout·Periscope 는 내 kill file 에서 이미 탈락) | ○ |

## 5. Sonar 세션 후보 평가 요약
| 후보 | 판정 | 이유 |
|---|---|---|
| Mullion | **통과(3순위)** | 겹침 없음, 뜻 정확. 철자·낯섦만 주의 |
| Teum | **사실상 탈락** | 로마자 철자 ×(team·Temu 오독), 빈틈·틈타다 부정 연상 |
| Tandem | **탈락** | 개발팀용 협업 앱 Tandem(tandem.chat, Mac·Win·Linux, GitHub 연동) — https://tandem.chat · https://alternativeto.net/software/tandem--virtual-office . 그 밖에 Tandem Diabetes·Tandem Bank·HP Tandem 등 상표 밀집 |
| Oriel | **통과(2순위)** | 양쪽이 따로 같은 이름에 도달 |
| Sill | 차점 | 겹침 없으나 짧고 흔해 검색에 묻힘(Sonar 세션 지적에 동의) |

## 6. 남은 결정 · 공백
1. **준영님이 고를 것**: 1~3순위 중 하나. 큰 갈림길은 **우리말 계열(Boda·Duri)** vs **건축·기구 계열(Oriel·Mullion·Sill)**.
2. **가용성 확인 범위(공백 명시)**: 웹 검색으로 "이름 + browser / developer tool / AI / app" 조회. npm 정확명 검색은 Boda 만, 나머지는 검색 결과로 갈음. **도메인·상표는 확인 안 함**(사내 도구라 참고 수준 — 사외 공개 시 필요).
3. **발음 시험 안 함**: "ARA와 ___" 를 회의에서 소리 내 불러 보고 고를 것.
4. 스킬이 가리키는 `references/naming-evaluation-rubric.md` 는 받은 폴더에 없어 본문의 6기준을 그대로 썼다.

---
## 결정 (2026-11-01)
**Oriel** 로 확정(준영님). 추가 검토: 발라(Bala/Valla — 속어 "발리다"·BALA AI 앱·ARA 와 소리 닮음), Valo(Claude·Codex 데스크톱 작업 공간과 정면 충돌), Vala(GNOME 언어), Vela(go-vela CI), Olla(LLM 프록시), Pella(속어·창호 상표), Belo·Bello·Mela(생존, 차점).
