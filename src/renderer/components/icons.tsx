import type { ReactNode } from 'react'

// 공용 라인 아이콘 (design-system §8.4 — R8 아이콘 일관성 패스).
// 규격 하나만 쓴다: 24 viewBox · stroke 2 · round cap/join · fill 없음 → 12~16px 로 그리면 1~1.3px 선.
// 크기는 호출측 CSS(.sb-act svg 등)가 정한다. 여기서 px 를 박지 않는다.
function line(children: ReactNode) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

// 상위 폴더로(↰ 글리프 대체 — 폰트마다 모양·정렬이 달라 선 아이콘으로 통일).
export const IconUp = () => line(<path d="M9 14l-4-4 4-4M5 10h9a4 4 0 014 4v5" />)
export const IconFolder = () => line(<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />)
export const IconFile = () =>
  line(
    <>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
      <path d="M14 3v5h5" />
    </>
  )
// 심볼릭 링크 — 폴더/파일 아이콘 안에 화살표를 겹치지 않고 별도 아이콘으로 쓴다(작게 그리면
// 겹친 배지가 뭉개진다). 링크가 폴더를 가리키는지 파일을 가리키는지는 화살표 뒤 모양으로 나눈다.
export const IconLinkFolder = () =>
  line(
    <>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
      <path d="M9 15l6-4M12 11h3v3" />
    </>
  )
export const IconLinkFile = () =>
  line(
    <>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
      <path d="M9 17l6-5M12 12h3v3" />
    </>
  )
// 미니 프리뷰 — 작은 화면 여러 장이 겹친 모양(세션 썸네일 목록).
export const IconPreview = () =>
  line(
    <>
      <rect x="3" y="4" width="12" height="9" rx="1.5" />
      <rect x="9" y="11" width="12" height="9" rx="1.5" />
    </>
  )
export const IconRefresh = () => line(<path d="M21 2v6h-6M3 12a9 9 0 0115-6.7L21 8M3 22v-6h6M21 12a9 9 0 01-15 6.7L3 16" />)
// 탐색기 툴바 — 복사/붙여넣기/이름 바꾸기/삭제.
export const IconCopy = () =>
  line(
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </>
  )
export const IconPaste = () =>
  line(
    <>
      <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
    </>
  )
export const IconPencil = () => line(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />)
export const IconTrash = () =>
  line(<path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />)
export const IconUpload = () => line(<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />)
export const IconFolderPlus = () =>
  line(
    <>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </>
  )
// 닫기 — 모달·드로어·탭·전송 항목이 쓰던 ✕/× 텍스트 글리프를 대체한다(폰트 폴백 편차 제거).
export const IconClose = () => line(<path d="M6 6l12 12M18 6L6 18" />)
export const IconPlus = () => line(<path d="M12 5v14M5 12h14" />)
// 탭바 오버플로 드롭다운 버튼(FB-tabs).
export const IconChevronDown = () => line(<path d="M6 9l6 6 6-6" />)
// 되돌아가기(디스크 창 방문 이력). IconUp 은 "한 단계 위"라 뜻이 다르다 — 같이 두고 갈라 쓴다.
export const IconBack = () => line(<path d="M15 18l-6-6 6-6" />)
// #88 R2 파일 관리자. 앞으로는 뒤로의 거울, 나머지는 24 viewBox·stroke 2 규격 그대로.
export const IconForward = () => line(<path d="M9 18l6-6-6-6" />)
export const IconSearch = () =>
  line(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  )
export const IconCut = () =>
  line(
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1l2.6 2.6" />
    </>
  )
export const IconFilePlus = () =>
  line(
    <>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
      <path d="M14 3v5h5M12 12v5M9.5 14.5h5" />
    </>
  )

// FB-ui2 우측 액티비티 바 4종. 타이틀바 기어(strokeWidth 2)·아라 마크(strokeWidth 1.7)를 그대로
// 옮겨 왔다(기존 인라인 SVG 스타일 재사용 — 새 아이콘 라이브러리 금지).
export const IconGear = () =>
  line(
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3L4.9 4.9M19.1 19.1l-1.4-1.4M17.7 6.3l1.4-1.4M4.9 19.1l1.4-1.4" />
    </>
  )
// 사이드바 [모니터] 탭이 쓰던 것과 같은 바 그래프 글리프.
export const IconMonitor = () => line(<path d="M3 12h4l3 7 4-14 3 7h4" />)
// 로그(세션 CLI 내역) — 두루마리처럼 쌓인 줄. 파일 아이콘과 헷갈리지 않게 접힌 모서리를 빼고 줄만 둔다.
export const IconLog = () =>
  line(
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  )
// 아라(AI) 마크 — tb-ai 와 같은 3중 원(투명도로 심도), stroke 1.7.
export const IconAra = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <circle cx="12" cy="12" r="8.5" opacity="0.4" />
    <circle cx="12" cy="12" r="5" opacity="0.7" />
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
)
