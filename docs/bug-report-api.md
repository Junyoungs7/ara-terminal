# 오류 신고 API 계약 (#206)

서버(`server/reports/`) · 사이트(`site/reports.html`) · 아라(`src/`) **세 갈래가 이 문서 하나에 맞춘다.**
바꾸려면 세 쪽을 함께 바꾼다 — 한쪽만 고치면 그게 곧 다음 제보다.
기획: `docs/plan-bug-report.md`

---

## 자리

- 서버: `http://192.168.100.56:8897` (환경변수 `ARA_REPORTS_PORT`, 기본 **8897**)
  ⚠️ 그 포트가 서버에서 비어 있는지는 **준영님이 확인**한다(에이전트는 실서버에 붙지 않는다)
- 아라: `src/shared/links.ts` 에 `REPORTS_API = 'http://192.168.100.56:8897'`
- 사이트: `location.hostname` + `:8897` 로 조립(사이트가 8899 에서 뜨므로 **교차 출처** — 서버가 CORS 를 연다)

## 인증 — 둘뿐이다

| 누구 | 어떻게 | 무엇을 할 수 있나 |
|---|---|---|
| **관리자**(준영님) | `Authorization: Bearer <비밀번호>` — 서버 환경변수 `ARA_REPORTS_ADMIN_PW` 와 `timingSafeEqual` 로 대조 | 전부 |
| **신고자** | `X-ARA-Device: <기기 ID>` — 신고할 때 보낸 값과 같으면 | **자기 신고의** 첨부 보기 · 코멘트 |
| 그 밖 | 없음 | 목록 · 상세의 공개 필드만 |

🔴 `ARA_REPORTS_ADMIN_PW` 가 **비어 있으면 관리 기능을 전부 거절**한다(빈 비밀번호로 열리는 문을 만들지 않는다).
🔴 기기 ID 는 사실상 **열쇠**다 — 응답·목록·로그 어디에도 **돌려주지 않는다.**

## 상태

`open`(접수) · `investigating`(확인 중) · `fixed`(고침) · `closed`(닫힘) ·
`wontrepro`(재현 안 됨) · `intended`(의도된 동작) · `duplicate`(중복)

---

## 엔드포인트

### `POST /api/reports` — 신고
```jsonc
// 요청 (Content-Type: application/json, 본문 상한 12MB)
{
  "title": "떼어낸 창에서 재접속이 안 됨",      // 1~200자, 필수
  "what": "SSH 탭을 새 창으로 뺀 뒤 …",         // 무엇을 했나, 0~5000자
  "happened": "…",                              // 무엇이 일어났나, 1~5000자, 필수
  "expected": "…",                              // 선택, 0~5000자
  "name": "홍길동",                              // 선택, 0~50자
  "deviceId": "uuid",                           // 필수 — 저장만 하고 돌려주지 않는다
  "env": {                                      // 공개 필드(목록·상세에 뜬다)
    "version": "1.0.13", "os": "Windows 11 10.0.26200",
    "electron": "31.7.7", "gpu": "…", "sessions": { "ssh": 2, "local": 1, "rdp": 0, "windows": 1 }
  },
  "attachments": [                              // 비공개(관리자·신고자만)
    { "name": "capture.png",          "mime": "image/png",        "base64": "…" },
    { "name": "main-error.log",       "mime": "text/plain",       "base64": "…" },
    { "name": "renderer-errors.json", "mime": "application/json", "base64": "…" },
    { "name": "settings.json",        "mime": "application/json", "base64": "…" }
  ]
}
// 응답 201
{ "id": "r-20260928-0001", "number": 1,
  "hashes": { "capture.png": "<sha256 hex>", "main-error.log": "…" } }   // 🔴 받은 그대로의 해시
```
- 첨부 이름은 **위 넷만** 받는다(허용 목록). 그 밖은 400 — 파일명으로 폴더를 벗어나지 못하게
- 아라는 `hashes` 를 **자기가 보낸 것과 대조**한다(DLP 가 바꿨는지 — 기획 §4)

### `GET /api/reports?status=open` — 목록(공개)
```jsonc
[{ "id": "…", "number": 1, "title": "…", "status": "open", "version": "1.0.13",
   "name": "홍길동", "createdAt": 1790000000000, "updatedAt": …, "comments": 2, "fixedIn": null }]
```
최신이 위. `status` 를 안 주면 전부.

### `GET /api/reports/:id` — 상세
공개 필드(`title·what·happened·expected·name·env·status·fixedIn·createdAt·comments[]`) +
`attachments: [{ name, mime, size }]` (**내용은 없다**).

### `GET /api/reports/:id/files/:name` — 첨부 본문
관리자 또는 그 신고의 기기 → 원본 바이트(`Content-Type` 은 저장된 mime). 그 밖 **403**.

### `POST /api/reports/:id/comments` — 코멘트
관리자 또는 그 신고의 기기. `{ "body": "…" }`(1~5000자) → 201 `{ comment }`.
`comment = { at, author: "admin" | "reporter", body }` — 🔴 관리자 코멘트의 작성자는 서버가 정한다(요청값을 믿지 않는다).

### `PATCH /api/reports/:id` — 상태·고친 판
관리자만. `{ "status"?: …, "fixedIn"?: "1.0.13" | null }` → 200 `{ report }`.
`fixedIn` 은 `^\d+\.\d+\.\d+$` 만.

### `GET /api/admin/check` — 관리자 비밀번호 확인 (R14)
관리자면 200 `{ "ok": true }`, 아니면 403. 서버에 비밀번호가 비어 있으면 **늘 403**. 사이트의 [관리자 로그인]이
이걸 먼저 부르고 200 일 때만 `sessionStorage` 에 저장한다(틀린 비밀번호로 "관리자로 보는 중"이 뜨지 않게).

---

## 공통 규칙

- 오류 응답은 늘 `{ "error": "사람이 읽을 한국어 한 문장" }` — 화면이 그대로 보여 준다
- CORS: `Access-Control-Allow-Origin` 은 **`http://192.168.100.56:8899` 하나**(+ 개발용 환경변수 `ARA_REPORTS_ORIGIN`).
  아라(main 프로세스)는 CORS 와 무관하다
- 저장: `/data/reports/<id>/report.json` + 첨부 파일. 코멘트는 `report.json` 안 배열.
  원자적 쓰기(임시 파일 → rename). 서버를 다시 띄워도 **목록이 그대로**여야 한다
- 속도 제한: 같은 기기 **분당 5건**(실수로 연타해도 신고가 쌓이지 않게)
