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

;
; M14 R2 `ara` CLI — 설정에서 [CLI 설치]를 누르면 사용자 PATH 에 "$INSTDIR\resources\bin" 이 붙는다(main/cli/install.ts).
; 앱을 지우면 그 한 줄도 뺀다 — Orca config/nsis/orca-user-path-cleanup.nsh(orcaRef ec112c6b01)를 이름만 바꿔 그대로:
; 다른 항목은 바이트 그대로, 값 종류(REG_EXPAND_SZ/REG_SZ)도 그대로, NSIS 문자열 한도에 걸려 잘렸을 수 있으면 손대지 않는다.
; PowerShell·reg.exe 없이 레지스트리 API 만(제거 때 보안 제품 규칙에 걸리지 않게 — Orca 주석).
!define ARA_HKEY_CURRENT_USER 0x80000001
!define ARA_KEY_QUERY_VALUE 0x20019
!define ARA_REG_SZ 1
!define ARA_REG_EXPAND_SZ 2

!macro ARA_REMOVE_USER_PATH_ENTRY DIR
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  StrCpy $R9 "${DIR}"
  ReadRegStr $R0 HKCU "Environment" "Path"
  StrLen $R1 $R0
  IntOp $R2 ${NSIS_MAX_STRLEN} - 1
  ${If} $R0 != ""
  ${AndIf} $R1 < $R2
    StrCpy $R8 ""
    System::Call 'advapi32::RegOpenKeyEx(p ${ARA_HKEY_CURRENT_USER}, t "Environment", i 0, i ${ARA_KEY_QUERY_VALUE}, *p .R6) i .R7'
    ${If} $R7 == 0
      System::Call 'advapi32::RegQueryValueEx(p R6, t "Path", p 0, *i .R4, p 0, p 0) i .R7'
      System::Call 'advapi32::RegCloseKey(p R6)'
      ${If} $R7 == 0
        StrCpy $R8 $R4
      ${EndIf}
    ${EndIf}
    StrCpy $R3 ""
    StrCpy $R4 ""
    StrCpy $R5 0
    StrCpy $R2 1
    StrCpy $R7 0
    ${Do}
      StrCpy $R6 $R0 1 $R5
      ${If} $R6 == ";"
      ${OrIf} $R6 == ""
        ${If} $R4 == $R9
        ${OrIf} $R4 == "$R9\"
          StrCpy $R7 1
        ${ElseIf} $R2 == 1
          StrCpy $R3 $R4
          StrCpy $R2 0
        ${Else}
          StrCpy $R3 "$R3;$R4"
        ${EndIf}
        StrCpy $R4 ""
        ${If} $R6 == ""
          ${ExitDo}
        ${EndIf}
      ${Else}
        StrCpy $R4 "$R4$R6"
      ${EndIf}
      IntOp $R5 $R5 + 1
    ${Loop}
    ${If} $R7 == 1
    ${AndIf} $R8 != ""
      ${If} $R3 == ""
        DeleteRegValue HKCU "Environment" "Path"
      ${ElseIf} $R8 == ${ARA_REG_EXPAND_SZ}
        WriteRegExpandStr HKCU "Environment" "Path" $R3
      ${ElseIf} $R8 == ${ARA_REG_SZ}
        WriteRegStr HKCU "Environment" "Path" $R3
      ${EndIf}
      SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

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
  ; M4 DM-01 로컬 터미널 데몬 — 진짜 제거일 때만(업데이트는 ${isUpdated} 라 건너뛴다: 업데이트 뒤에도 에이전트가 살아야 한다).
  ; 데몬은 설치 폴더 밖 %LOCALAPPDATA%\ARA\daemon-host\<판> 에서 돈다(main/daemon/launcher.ts — NSIS 의 설치 폴더 프로세스 정리를 피하려고).
  ; 그래서 electron-builder 의 정리가 못 본다 — 그 경로에서 도는 프로세스를 끄고 폴더를 지운다. 자리는 main/agents/feature.ts 의 hostRoot 와 같아야 한다.
  ${IfNot} ${isUpdated}
    SetShellVarContext current
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$LOCALAPPDATA\ARA\daemon-host', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force }"`
    Pop $0
    Sleep 500
    RMDir /r "$LOCALAPPDATA\ARA\daemon-host"
    RMDir "$LOCALAPPDATA\ARA"
    ; M14 R2 `ara` CLI — [CLI 설치]로 붙인 사용자 PATH 한 줄(업데이트는 같은 자리라 둔다).
    !insertmacro ARA_REMOVE_USER_PATH_ENTRY "$INSTDIR\resources\bin"
  ${EndIf}
!macroend
