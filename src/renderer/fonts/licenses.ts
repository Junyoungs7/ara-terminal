// 번들 폰트 OFL 라이선스 고지 데이터 (GAP-OFL). 원문 라이선스 파일: resources/fonts/OFL-*.txt.
// 재배포 법적 준수 — 설정 드로어 하단 About 섹션에 표기.
export type FontLicense = { name: string; copyright: string; source: string }

/**
 * M0 — 옮겨 온 **코드**의 고지(폰트 표와 같은 모양으로 설정 › 정보에 그린다). 원문은 저장소 루트 NOTICE 이고
 * electron-builder 가 설치 폴더 resources/NOTICE 로 싣는다. tests/fontLicenses.test.ts 가 NOTICE 와 이 표를 맞춘다.
 * herdr(Apache-2.0)는 아직 옮기지 않았다 — 옮길 때 NOTICE 의 자리를 채우고 여기에 한 줄 더한다.
 */
export const CODE_NOTICES: { name: string; copyright: string; license: string }[] = [
  { name: 'Orca (stablyai/orca)', copyright: 'Copyright (c) 2026 Lovecast Inc.', license: 'MIT License' }
]

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
    name: 'Pretendard',
    copyright: 'Copyright (c) 2021, Kil Hyung-jin',
    source: 'orioncactus/pretendard'
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
