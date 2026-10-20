/**
 * 위험 명령 거르개(아라 채팅 v2, 2026-10-20 준영님 결정).
 *
 * 지금 보는 세션에 아라가 치는 글은 묻지 않고 실행된다(approval.ts) — **단 이 목록에 걸리면 승인 창으로 간다.**
 * 줄 단위로 보고, 대소문자는 가리지 않는다. 명령어 앞은 단어 경계(`/sbin/reboot`·`xargs rm -rf` 도 걸린다).
 *
 * ponytail: 짧은 목록일 뿐 보안 경계가 아니다 — 별칭(alias)·함수·스크립트 파일·변수 치환·base64 같은 우회는
 * 못 막는다. 막아야 할 모양이 새로 보이면 PATTERNS 에 한 줄 더한다.
 */

/** 명령어 앞: 글자·점·대시가 아니면 된다(`foo-reboot`·`--su` 는 명령어가 아니다). */
const B = '(?<![\\w.-])'
/** 같은 명령 안(`;`·`&`·`|` 를 넘지 않는다). */
const SAME = '[^;&|\\n]*'

const PATTERNS: readonly RegExp[] = [
  `${B}sudo\\b`,
  `${B}su(?:\\s|$)`,
  // rm -r / -rf / -fr / -Rf … / --recursive. rmdir 은 `rm\\b` 에 안 걸린다.
  `${B}rm\\s${SAME}(?<!\\S)(?:-(?!-)[a-z]*r[a-z]*|--recursive)\\b`,
  `${B}mkfs\\b`,
  `${B}dd\\s${SAME}\\bif=`,
  `${B}(?:shutdown|reboot|poweroff|halt)\\b`,
  `${B}init\\s+[06]\\b`,
  `${B}systemctl\\s${SAME}\\b(?:stop|restart|disable|kill|mask)\\b`,
  `${B}service\\s+\\S+\\s+(?:stop|restart)\\b`,
  `${B}kill\\s${SAME}(?<!\\S)-(?:9|kill|sigkill)\\b`,
  `${B}(?:killall|pkill)\\b`,
  `${B}docker\\s+(?:rm|rmi|kill|stop|exec|system\\s+prune)\\b`,
  `${B}docker(?:\\s+|-)compose\\s${SAME}\\bdown\\b`,
  `${B}kubectl\\s${SAME}\\b(?:delete|drain|exec)\\b`,
  `${B}(?:chmod|chown)\\s${SAME}(?<!\\S)(?:-(?!-)[a-z]*r[a-z]*|--recursive)\\b`,
  `${B}git\\s+push\\s${SAME}(?<!\\S)(?:--force(?:-with-lease)?|-f)(?=\\s|$)`,
  `${B}git\\s+reset\\s${SAME}--hard\\b`,
  '\\bdrop\\s+(?:table|database)\\b',
  '\\btruncate\\b',
  '\\bdelete\\s+from\\b',
  '>\\s*/dev/sd',
  ':\\(\\)\\s*\\{'
].map((s) => new RegExp(s, 'i'))

/** 이 입력에 위험 명령 줄이 있나. */
export function isDangerousInput(text: string): boolean {
  return text.split(/\r\n|\r|\n/).some((line) => PATTERNS.some((re) => re.test(line)))
}
