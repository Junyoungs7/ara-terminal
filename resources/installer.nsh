; R14 — 탐색기 주소창에 `아라`(또는 `ara`)를 치면 그 폴더에서 아라가 뜬다(cmd 처럼).
;
; 왜 PATH 가 아니라 App Paths 인가:
;  · 탐색기 주소창·Win+R 은 ShellExecute 라 **App Paths 를 먼저 본다** — 이름 하나에 실행 파일 하나를
;    걸 뿐이라 남의 PATH 를 안 건드린다. PATH 에 설치 폴더를 넣으면 그 폴더의 dll·exe 가 **모든 셸의
;    검색 경로**에 끼고(이름 충돌), 제거 때 문자열을 잘라 내다 사용자의 PATH 를 망가뜨리는 사고가 흔하다.
;  · 대가: App Paths 는 cmd·PowerShell 에 친 `ara` 는 못 찾는다(그쪽은 PATH 만 본다). 요청이 탐색기라 둔다.
;  · App Paths 에는 인자 칸이 없다 — 그래서 아라는 **작업 폴더**로 "탐색기가 띄웠나"를 가른다
;    (src/main/windows/openHere.ts).
;
; `Path` 값은 일부러 안 건다 — 걸면 그 폴더가 아라의 PATH 앞에 붙고, 아라가 여는 **모든 로컬 셸**이 물려받는다.
; SHELL_CONTEXT = 이 설치의 범위(나만 → HKCU, 모든 사용자 → HKLM). electron-builder 의 다른 키와 같은 자리다.
; ⚠️ 이 파일은 **BOM 있는 UTF-8** 이다. BOM 이 있으면 makensis 가 코드페이지 추측 없이 UTF-8 로 읽는다(3.04 에서
;    `${U+C544}${U+B77C}.exe` 와 비교해 확인 — 한 글자 틀린 대조는 !error 로 떨어졌다). 편집기가 BOM 을 떼지 않게.
; 검사: tests/openHere.test.ts(이 파일이 두 이름을 걸고 지우는지)

!define ARA_APP_PATHS "Software\Microsoft\Windows\CurrentVersion\App Paths"

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${ARA_APP_PATHS}\아라.exe" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHELL_CONTEXT "${ARA_APP_PATHS}\ara.exe" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ; 신고 #4·#5: 탐색기 주소창은 App Paths 보다 **바탕화면 항목**을 먼저 본다. 바탕화면에 `ARA.lnk` 가 있으면
  ; `ara` 가 그 바로가기(작업 폴더 = 설치 폴더)로 떠서 openHere 가 셸을 안 연다. 그래서 바탕화면 것만 `A.R.A`.
  ; 시작 메뉴는 `ARA` 그대로 — 윈도우 검색은 거기를 보고, `ara` 로 찾혀야 한다(주소창은 시작 메뉴를 안 본다).
  ; 업데이트는 shortcuts 를 그대로 두거나(옛 이름 → ARA.lnk 로 되돌린 뒤) 여기로 온다 — 둘 다 이 한 번의 Rename 이 정리한다.
  ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$DESKTOP\A.R.A.lnk"
    Rename "$DESKTOP\${SHORTCUT_NAME}.lnk" "$DESKTOP\A.R.A.lnk"
  ${EndIf}
!macroend

; 업데이트도 옛 버전의 제거를 먼저 지난다 — 여기서 지워도 새 설치의 customInstall 이 곧바로 다시 건다.
!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "${ARA_APP_PATHS}\아라.exe"
  DeleteRegKey SHELL_CONTEXT "${ARA_APP_PATHS}\ara.exe"
  ; 이름을 바꾼 바탕화면 바로가기는 electron-builder 가 모른다 — 진짜 제거일 때만 지운다
  ; (업데이트는 --keep-shortcuts 로 온다. 거기서 지우면 새 설치가 다시 만들지 않아 아이콘이 사라진다).
  ${IfNot} ${isKeepShortcuts}
    Delete "$DESKTOP\A.R.A.lnk"
  ${EndIf}
!macroend
