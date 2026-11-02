@echo off
rem M14 R2 `ara` CLI - port of Orca resources/win32/bin/orca.cmd. Settings > Skills [Install CLI] adds this folder (resources\bin) to the user PATH.
rem ASCII only: cmd.exe reads batch files in the console code page (CP949 on Korean Windows).
rem  - no arguments: open ARA in this folder (same as the Explorer address bar `ara` via App Paths, even if PATH finds this file first).
rem  - arguments: run the CLI with the ARA executable in node mode (ELECTRON_RUN_AS_NODE) - works on PCs without node.
rem Like orca.cmd, cmd's %%* cannot carry newlines - pass multi-line prompts on one line.
setlocal
set "BIN=%~dp0"
set "EXE=%BIN%..\..\ARA.exe"
set "CLI=%BIN%..\app.asar.unpacked\out\main\araCli.js"
if not exist "%EXE%" (
  echo Unable to locate ARA.exe at "%EXE%" 1>&2
  exit /b 1
)
if "%~1"=="" (
  set "ELECTRON_RUN_AS_NODE="
  start "" "%EXE%"
  exit /b 0
)
set "ELECTRON_RUN_AS_NODE=1"
"%EXE%" "%CLI%" %*
exit /b %ERRORLEVEL%
