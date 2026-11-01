// 원격 CWD 추적 — 셸에 아무것도 타이핑하지 않고 작업 디렉토리를 알아낸다.
//
// 왜 이렇게까지 하나: 예전에는 접속 직후 셸 통합 스니펫을 stdin 으로 밀어 넣어 OSC7 을 유도했는데,
// 대화형 bash/zsh 는 readline/zle 이 입력을 **직접 그려서** 그 스니펫이 화면에 그대로 보였다
// (stty -echo 로도 안 지워진다 — readline 이 termios 를 자기 걸로 바꾼다). 준영님 제보로 확인.
//
// MobaXterm 도 같은 문제를 같은 방식으로 피한다(바이너리 내부 디버그 문자열로 확인:
// "(CWD) Trying to determine shell PID" / "echo $$;ps -ef" / "(CWD) Reading symlink /proc/…/cwd"
// / "pwdx" / "ls -lad"). 다만 MobaXterm 은 "같은 조부모·다른 pts·비슷한 시작 시각" 같은 휴리스틱으로
// 셸 PID 를 **추정**한다 — 그래서 공식 문서도 experimental 이라고 적어 뒀다.
//
// 우리는 추정할 필요가 없다: 셸 채널과 이 exec 채널은 **같은 SSH 커넥션**이라 원격에서 둘 다 같은
// sshd 세션 프로세스의 자식이다. 그래서 $PPID(= 그 sshd) 의 자식 중 tty 를 가진 놈 = 우리 셸이다.

/** 셸 PID 질의. tty 없는 형제(이 exec 채널·sftp 채널)는 제외한다. 한 줄, 숫자 하나만 돌려준다. */
export const SHELL_PID_CMD =
  "ps -eo pid=,ppid=,tty= 2>/dev/null | awk -v P=$PPID '$2==P && $3!=\"?\" {print $1; exit}'"

/** 질의 출력 → PID. 셸이 $PPID 를 안 주거나(fish) ps 가 없으면(임베디드) 빈 값 → null = 추적 포기. */
export function parseShellPid(out: string): number | null {
  const n = Number(out.trim().split('\n')[0]?.trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 이 PID 의 작업 디렉토리 심볼릭 링크. sftp readlink 로 읽는다(원격 프로세스를 안 띄운다). */
export function cwdLink(pid: number): string {
  return `/proc/${pid}/cwd`
}
