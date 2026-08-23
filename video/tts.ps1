# 나레이션 음성 만들기 — narration.json 의 문장마다 wav 하나. `npm run tts` 로 부른다.
#
# **스피커로 소리를 내지 않는다.** SetOutputToWaveFile 로 파일에만 쓴다 — 이 PC 에서 도는 도구가
# 사용자의 화면·소리를 건드리지 않는다는 규칙을 여기서도 지킨다.
#
# 음성 고르기: 이름에 'Natural'/'자연' 이 든 한국어 음성이 있으면 그것을 먼저 쓴다.
# (윈도우 설정 > 접근성 > 내레이터 > '자연스러운 음성 추가' 로 받으면 목록에 생긴다.)
# 없으면 기본 한국어 음성(Heami)으로 떨어진다 — 같은 대본으로 언제든 다시 만들 수 있다.
param(
  [string]$Out = "$PSScriptRoot\public\vo",
  [int]$Rate = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$korean = $synth.GetInstalledVoices() |
  Where-Object { $_.VoiceInfo.Culture.Name -eq 'ko-KR' } |
  Sort-Object { if ($_.VoiceInfo.Name -match 'Natural|자연') { 0 } else { 1 } }

if (-not $korean) { throw '한국어 음성이 없습니다. 윈도우 설정에서 한국어 음성을 추가하세요.' }
$voice = $korean[0].VoiceInfo.Name
$synth.SelectVoice($voice)
$synth.Rate = $Rate
"음성: $voice"

if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Path $Out -Force | Out-Null }

$data = Get-Content "$PSScriptRoot\narration.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$n = 0
foreach ($key in $data.PSObject.Properties.Name) {
  if ($key -eq '_') { continue }
  foreach ($scene in $data.$key.scenes) {
    $path = Join-Path $Out ($scene.id + '.wav')
    $synth.SetOutputToWaveFile($path)
    $synth.Speak($scene.text)
    $n++
  }
}
$synth.SetOutputToNull()
$synth.Dispose()
"만든 파일 $n 개 → $Out"
