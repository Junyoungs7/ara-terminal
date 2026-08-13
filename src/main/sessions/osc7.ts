// OSC7 CWD 파서 (F6 MS-3). 셸이 방출하는 `ESC ] 7 ; file://<host>/<path> (BEL|ST)` 에서 경로를 뽑는다.
// 로컬 셸은 아래 SHELL_INTEGRATION 을 주입해 OSC7 을 확실히 방출시키고, 원격은 방출 셸이면 best-effort.
// 한 청크에 여러 OSC7 이 있으면 마지막(가장 최근 cwd)을 쓴다. 파싱 실패 시 null → 호출부가 cwd 유지.

// ESC ] 7 ; <payload> (BEL=\x07 또는 ST=ESC \)
const OSC7_RE = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g

// file://host/path → path. Windows 는 file:///C:/... → C:/... 로 되돌린다(URL 디코드 포함).
function fileUrlToPath(url: string): string | null {
  if (!url.startsWith('file://')) return null
  const afterScheme = url.slice('file://'.length)
  const slash = afterScheme.indexOf('/') // host 다음 첫 슬래시
  if (slash < 0) return null
  let p = afterScheme.slice(slash) // "/C:/Users/..." 또는 "/home/..."
  try {
    p = decodeURIComponent(p)
  } catch {
    // 잘못된 인코딩: 원문 유지
  }
  // Windows 드라이브: "/C:/x" → "C:/x"
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
  return p
}

// data 청크에서 마지막 OSC7 cwd 를 반환. 없으면 null.
export function parseOsc7Cwd(data: string): string | null {
  let last: string | null = null
  let m: RegExpExecArray | null
  OSC7_RE.lastIndex = 0
  while ((m = OSC7_RE.exec(data)) !== null) {
    const path = fileUrlToPath(m[1])
    if (path) last = path
  }
  return last
}

// 셸 통합 — 프롬프트가 그려질 때마다 OSC7 로 현재 cwd 를 방출하게 한다(계획서 MS-3).
// 주입은 "셸이 시작할 때" 경로로만 한다: pty.write() 로 stdin 에 밀어넣으면 tty 에코 때문에
// 정의문이 첫 프롬프트에 그대로 보인다. PtyBackend 가 셸 종류에 따라 골라 쓴다.
export const SHELL_INTEGRATION = {
  // PowerShell: powershell.exe -NoExit -EncodedCommand 로 전달(에코 없음, 프로필 로드 후 실행).
  // 기존 prompt 함수를 잡아뒀다가 호출 — 사용자 커스텀 프롬프트를 그대로 보존한다.
  powershell: [
    '$global:__ARA_PROMPT = $function:prompt',
    'function global:prompt {',
    '  $p = (Get-Location).Path',
    "  Write-Host -NoNewline ([char]27 + ']7;file://' + $env:COMPUTERNAME + '/' + ($p -replace '\\\\', '/') + [char]7)",
    '  if ($global:__ARA_PROMPT) { & $global:__ARA_PROMPT } else { "PS $p> " }',
    '}'
  ].join('\n'),
  // bash: PROMPT_COMMAND 를 환경변수로 넘긴다(셸이 직접 읽으므로 에코 없음).
  bashPromptCommand: 'printf \'\\033]7;file://%s%s\\a\' "$HOSTNAME" "$PWD"',
  // zsh 등 나머지 POSIX 셸: 시작 인자/환경 경로가 없어 stdin 폴백. 에코가 한 줄 남는다.
  // ponytail: 무음화하려면 ZDOTDIR 임시 .zshrc 가 필요 — 배포 대상(Windows) 밖이라 보류.
  posix:
    'if [ -n "$ZSH_VERSION" ]; then precmd() { printf "\\033]7;file://%s%s\\a" "$HOST" "$PWD"; }; fi\n',
  // SSH 주입문은 **없앴다**(백로그 M-9). 대화형 bash/zsh 는 readline/zle 이 입력을 직접 그려서
  // 무슨 짓을 해도 화면에 보였다 — 지금은 셸을 건드리지 않고 원격 /proc 에서 cwd 를 읽는다
  // (ssh/remoteCwd.ts). 원격이 OSC7 을 스스로 방출하면 그것도 그대로 반영된다(parseOsc7Cwd).
} as const
