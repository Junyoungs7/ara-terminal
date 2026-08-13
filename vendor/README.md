# vendor/iron-remote-desktop-rdp — 다중 모니터 포크

앱이 쓰는 RDP 클라이언트(`@devolutions/iron-remote-desktop-rdp`)를 **우리가 직접 빌드한 것**으로 갈아끼운
자리다. npm 에 올라온 것과 다른 점은 하나뿐이다: **모니터 경계를 서버에 알릴 수 있다.**

## 왜 포크했나

RDP 의 다중 모니터는 화면을 여러 개 보내는 게 아니다. 서버는 **모니터 전체를 감싸는 사각형 하나**를
프레임버퍼로 그리고, 경계는 `TS_UD_CS_MONITOR`([MS-RDPBCGR] 2.2.1.3.6)라는 메타데이터로 따로 알린다.
경계를 안 보내면 서버는 그 큰 사각형을 **모니터 한 장**으로 본다 — 원격에서 창을 최대화하면 두 모니터를
다 덮고, 작업표시줄이 전체 폭으로 늘어나고, 창 스냅이 경계를 무시한다.

IronRDP 는 그 PDU 인코더를 **이미 갖고 있는데**(`ironrdp-pdu` 의 `gcc/monitor_data.rs`) 아무도 채워
넣지 않는다 — `connection.rs` 가 `monitor: None` 으로 하드코딩한다. wasm 쪽에도 값을 넣을 구멍이 없다
(확장 ident 목록에 monitor 계열이 없다). 그래서 세 줄기를 이었다:

1. `ironrdp-connector` — `Config` 에 `monitors: Vec<gcc::Monitor>` 추가, GCC 요청에 실어 보냄
2. `ironrdp-web` — `monitors` 확장 ident 신설 + 평평한 숫자 배열 파서(검증 포함)
3. `web-client/iron-remote-desktop-rdp` — `monitorLayout(MonitorRect[])` TS 팩토리

전부 `ara-multimonitor.patch` 에 들어 있다(207줄).

## 다시 빌드하려면

```bash
git clone https://github.com/Devolutions/IronRDP.git
cd IronRDP
git checkout 210f1d3c2a5fb54aa295e1c0170e4b35fb68a8b7   # 이 포크의 기준 커밋
git apply /path/to/vendor/ara-multimonitor.patch

# Rust 1.94.1 + wasm32 타깃 (rust-toolchain.toml 이 알아서 받는다)
export RUSTFLAGS='-Ctarget-feature=+simd128,+bulk-memory --cfg getrandom_backend="wasm_js" -Copt-level=s -Ccodegen-units=1'
cargo build --release --target wasm32-unknown-unknown -p ironrdp-web --lib

cd crates/ironrdp-web
wasm-bindgen --target web --out-dir pkg --out-name ironrdp_web \
  ../../target/wasm32-unknown-unknown/release/ironrdp_web.wasm

cd ../../web-client/iron-remote-desktop-rdp
npm install && npm run build-alone
# dist/iron-remote-desktop-rdp.js 와 dist/index.d.ts 를 이 폴더로 복사
```

`wasm-bindgen` 버전은 **0.2.126** 이어야 한다(크레이트와 CLI 버전이 다르면 거부한다).
`cargo install wasm-bindgen-cli --version 0.2.126 --locked`.

공식 `cargo xtask web build` 는 wasm-pack 을 요구하는데, 위 두 줄이 같은 일을 하고 설치할 게 하나 적다.
wasm-opt 를 안 거쳐서 번들이 npm 판(6.09MB)보다 조금 크다(6.97MB) — 동작 차이는 없다.

## 업스트림으로 돌아가려면

`package.json` 의 `file:vendor/iron-remote-desktop-rdp` 를 버전 번호로 되돌리면 된다. 다중 모니터
경계만 사라지고 나머지는 그대로 동작한다(`monitorLayout` 호출부가 없는 함수를 부르지 않도록
`RdpView.tsx` 가 존재 여부를 확인하고 쓴다).

업스트림에 같은 기능이 들어오면 이 폴더를 통째로 지우는 게 맞다. 관련 이슈를 올릴 때 이 패치를
그대로 첨부할 수 있게 커밋 기준을 위에 적어 뒀다.
