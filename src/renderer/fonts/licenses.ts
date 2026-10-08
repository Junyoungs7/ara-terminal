// 번들 폰트 OFL 라이선스 고지 데이터 (GAP-OFL). 원문 라이선스 파일: resources/fonts/OFL-*.txt.
// 재배포 법적 준수 — 설정 드로어 하단 About 섹션에 표기.
export type FontLicense = { name: string; copyright: string; source: string }

export const LICENSES: FontLicense[] = [
  {
    name: '나눔고딕코딩 (Nanum Gothic Coding)',
    copyright: 'Copyright (c) 2010, NHN Corporation',
    source: 'Google Fonts'
  },
  {
    name: 'D2Coding',
    copyright: 'Copyright (c) 2015, NAVER Corporation',
    source: 'naver/d2codingfont'
  },
  {
    name: 'JetBrains Mono',
    copyright: 'Copyright 2020 The JetBrains Mono Project Authors',
    source: 'Google Fonts'
  },
  {
    name: 'SUIT',
    copyright: 'Copyright (c) 2022, SUNN',
    source: 'sunn-us/SUIT'
  },
  // FINISH-M6(2026-08-30): FINISH-M4 가 심볼 폰트를 번들에 실으면서(styles/fonts.css 의
  // 'ARA Nerd Font Symbols' @font-face + resources/fonts/OFL-SymbolsNerdFontMono.txt) 이 표만
  // 넷에 멈춰 있었다 — 화면의 고지가 실제 배포물보다 낡으면 그건 법적 고지가 아니라 장식이다.
  // tests/fontLicenses.test.ts 가 resources/fonts/OFL-*.txt 와 이 표를 맞춰 다시 벌어지지 않게 한다.
  {
    name: 'Symbols Nerd Font Mono',
    copyright: 'Copyright (c) 2014, Ryan L McIntyre',
    source: 'ryanoasis/nerd-fonts'
  }
]
