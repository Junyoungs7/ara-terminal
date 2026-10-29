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
export const IconRefresh = () => line(<path d="M21 2v6h-6M3 12a9 9 0 0115-6.7L21 8M3 22v-6h6M21 12a9 9 0 01-15 6.7L3 16" />)
// 지난 대화 목록(2026-08-26) — 되감는 화살표 + 시계바늘.
export const IconHistory = () =>
  line(<path d="M3 3v6h6M3.5 13a9 9 0 105-8.5L3 9M12 8v5l3.5 2" />)
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
export const IconFolderUpload = () =>
  line(
    <>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
      <path d="M12 16v-5M9.5 13.5L12 11l2.5 2.5" />
    </>
  )
export const IconFolderPlus = () =>
  line(
    <>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </>
  )
// 닫기 — 모달·드로어·탭·전송 항목이 쓰던 ✕/× 텍스트 글리프를 대체한다(폰트 폴백 편차 제거).
export const IconClose = () => line(<path d="M6 6l12 12M18 6L6 18" />)
// 비밀번호 표시/숨김 (2026-08-21 준영님 요청 — "입력창에 눈 표시를 둬서 실제 값 보여주게").
// 2.0 앱 잠금 — 자물쇠(잠금 화면 머리·설정 › 보안).
export const IconLock = () =>
  line(
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </>
  )
export const IconEye = () =>
  line(
    <>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  )
export const IconEyeOff = () =>
  line(
    <>
      <path d="M2 12s3.6-6 10-6c1.4 0 2.6.3 3.7.7M22 12s-3.6 6-10 6c-1.4 0-2.6-.3-3.7-.7" />
      <path d="M9.6 9.6a3.4 3.4 0 004.8 4.8M3 3l18 18" />
    </>
  )
// 터미널(>_). 파일 트리의 [터미널도 여기로] 버튼(2026-09-28 — 자동 cd 를 끄고 버튼으로 바꿨다).
export const IconTerminal = () => line(<path d="M4 17l6-5-6-5M12 19h8" />)
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

