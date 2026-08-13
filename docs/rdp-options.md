# A.R.A 내장 RDP — 선택지 조사

작성 2026-08-05. 준영님 요구: **"RDP를 OS 클라이언트 외부 실행이 아니라 A.R.A 안에서 직접 쓰고 싶다. 특히 macOS에서도."**
조사는 메인 세션이 직접 수행(에이전트 2회가 API 과부하로 중단돼 인계). 근거 URL은 문서 끝 참고.

## 1. 현재 A.R.A 상태

F21에서 **RDP 프로토콜 내장을 명시적 Non-Goal로 두고** OS 클라이언트를 외부 실행한다 — Windows `mstsc`, macOS `open`(Microsoft Remote Desktop). 즉 macOS도 "불가"는 아니고, **별도 앱 설치가 필요하고 A.R.A 밖의 창이 뜬다**는 것이 제약이다. 이번 요구는 그 Non-Goal을 뒤집는 것이다.

## 2. 경쟁 제품은 어떻게 하는가

| 제품 | RDP 구현 | 앱 내 임베드 | macOS | 근거 |
|---|---|---|---|---|
| **MobaXterm** | **FreeRDP 번들** | 예(탭 안) | **없음 — Windows 전용** | Devolutions 비교글이 "MobaXterm은 FreeRDP의 크로스플랫폼 구현을 쓴다"고 명시. 제품 자체는 Windows 전용 배포 |
| **electerm** (Electron 터미널) | **IronRDP(Rust)를 WASM으로 컴파일** + WebSocket 프록시 | 예 | **예**(Win/Mac/Linux) | electerm이 `ironrdp-wasm` 저장소·npm 패키지를 직접 유지 |
| **Apache Guacamole** | guacd(C 데몬)가 FreeRDP 사용, 브라우저는 HTML5 캔버스 | 웹앱 | 브라우저라 무관 | 공식 문서·Docker 이미지 |
| **Devolutions RDM** | 자사 IronRDP(Rust) 등 | 예 | 예(RDM for Mac) | IronRDP는 Devolutions가 개발 |

**핵심**: MobaXterm 방식(FreeRDP 번들)은 **Windows 전용 제품의 답**이라 우리 요구(맥)를 그대로 풀지 못한다. 반면 **electerm은 우리와 같은 Electron 스택에서 크로스플랫폼 내장 RDP를 이미 하고 있다** — 가장 참고할 선례.

## 3. 선택지 평가

| 방식 | 앱 내 임베드 | macOS | NLA(CredSSP) | 외부 인프라 | 규모·리스크 |
|---|---|---|---|---|---|
| **A. IronRDP WASM + 앱 내부 WS↔TCP 릴레이** | ✅ | ✅ | ✅ 지원 | **불필요**(릴레이를 main 프로세스에 둠) | 중간. npm 패키지 존재 |
| B. Guacamole 게이트웨이(guacd) | ✅(캔버스) | ✅ | ✅ | **필요** — guacd는 리눅스 C 데몬. 사내 서버 또는 각 PC에 Docker | 인프라 운영 부담. 데스크톱 앱에 번들하기 부적합 |
| C. FreeRDP 바이너리 번들 | ❌ 별도 창 | ✅ | ✅ | 불필요 | Electron 창 안에 네이티브 화면을 그릴 깔끔한 방법이 없음 |
| D. 순수 JS(node-rdpjs·mstsc.js) | ✅ | ✅ | **❌ 미지원** | 불필요 | **탈락** — 저장소 로드맵에 NLA가 "미래 과제"로 남아 있고 "SSL 보안 계층만 지원". 요즘 Windows 서버는 NLA 기본 요구 |

### A안이 성립하는 이유 (이 조사의 핵심)
IronRDP WASM은 브라우저용이라 **WebSocket 프록시가 필요**하다(브라우저가 생 TCP를 못 열기 때문). electerm도 예제 프록시(`example/lib/rdp-proxy.js`, Node)를 함께 둔다.
그런데 **우리는 Electron이다** — 그 프록시를 별도 서버로 둘 필요 없이 **main 프로세스(Node) 안에서 WS↔TCP 릴레이로 돌리면 된다.** F8에서 이미 SSH 포트포워딩용 로컬 리스너를 main에 만들어 본 경험이 그대로 재사용된다. 결과적으로 **외부 인프라 0, 사용자 설치 0, Windows·macOS 동일**.

- 패키지: `ironrdp-wasm` (npm, v1.1.0, 2026-04-17 갱신, MIT, electerm 관리)
- 기능: 키보드·마우스, 클립보드 동기화, 파일 전송, CredSSP(NLA) 옵션, RemoteFX 등 코덱

## 4. 권고

**A안(IronRDP WASM + 앱 내부 릴레이)으로 진행하되, 착수 전 짧은 기술 검증(스파이크)을 먼저 한다.**
검증할 것: ①사내 실제 Windows 서버에 NLA로 붙는가 ②체감 성능(화면 갱신·입력 지연) ③클립보드·파일전송 실제 동작 ④번들 용량 증가 ⑤macOS 빌드에서 동일 동작.
스파이크가 통과하면 설계 → 구현, 실패하면 B안(사내 guacd 게이트웨이)으로 선회한다. **기존 외부 실행 경로는 스파이크 통과 후에도 폴백으로 남긴다**(RDP 파일 연동·다중 모니터 등은 OS 클라이언트가 여전히 강하다).

## 5. 미확인 항목 (추측하지 않고 남김)

- IronRDP WASM의 **실사용 성능**(고해상도·다중 모니터에서의 프레임률) — 실측 필요
- **H.264/AVC444 코덱** 지원 범위. RemoteFX·비트맵 계열은 문서에 명시돼 있으나 최신 코덱은 미확인
- 사내 Windows 서버의 **정확한 보안 정책**(NLA 강제 여부, 인증서, RDP 게이트웨이 유무)
- `ironrdp-wasm` 패키지의 **장기 유지보수 보장**(현재 1인 메인테이너, 상위 IronRDP는 Devolutions가 유지)
- MobaXterm의 FreeRDP 임베드 **내부 구조**(공식 문서 없음 — 우리 방향과 무관해 더 파지 않음)

## 참고
- MobaXterm vs RDM 비교(FreeRDP 사용 언급): https://blog.devolutions.net/2023/07/rdp-management-showdown-mobaxterm-vs-devolutions-rdm/
- MobaXterm 공식(다운로드/기능): https://mobaxterm.mobatek.net/
- electerm(크로스플랫폼 Electron 터미널, RDP 내장): https://github.com/electerm/electerm
- ironrdp-wasm: https://github.com/electerm/ironrdp-wasm
- IronRDP 아키텍처: https://github.com/Devolutions/IronRDP/blob/master/ARCHITECTURE.md
- node-rdpjs(NLA 미지원 확인): https://github.com/citronneur/node-rdpjs
- Apache Guacamole 공식 Docker 문서: https://guacamole.apache.org/doc/gug/guacamole-docker.html
