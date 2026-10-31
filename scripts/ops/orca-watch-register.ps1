# 작업 스케줄러 ARA-Orca-Watch 등록 (매주 월요일 09:07). -Unregister 로 삭제.
# 창 방지: `conhost.exe --headless <명령>` — 콘솔 호스트를 창 없이 띄우므로 powershell.exe 가
#   콘솔 창을 만들지 않는다 (Windows 11 에서 확실. -WindowStyle Hidden 은 창이 잠깐 깜박이므로 쓰지 않음).
#   wscript 래퍼는 별도 .vbs 파일이 하나 더 필요해 채택하지 않음.
param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$name = 'ARA-Orca-Watch'
if ($Unregister) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; return }
$script = 'D:\AI\OFA\scripts\ops\orca-watch.ps1'
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
  -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '09:07'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
