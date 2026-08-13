// 비밀 마스킹 — 세션 로그(F12)와 명령어 히스토리(F11)가 **같은 함수**를 쓴다.
// 히스토리 쪽은 별건 결함 수정이다: `mysql -pSECRET` 가 history.json 에 평문으로 저장되고 있었다.
//
// 전제 정정: tee 하는 것은 **출력** 스트림이다. 대화형 비밀번호 프롬프트는 원격이 echo 를 끄므로
// 비밀번호가 애초에 출력에 나타나지 않는다. 실제 유출 경로는 아래 넷이다.
//   1. 명령줄 인자      `-pSECRET` · `--password=… ` · `--token` · `--api-key` · `--secret`
//   2. 환경변수 대입    `TOKEN=abc` · URL 인증정보 `scheme://user:pass@host` · `Authorization: Bearer …`
//   3. 개인키 블록      `-----BEGIN … PRIVATE KEY-----` ~ `-----END …-----`
//   4. 프롬프트 인접    echo 가 켜진 `read -p "Password: "` 류 — 같은 줄 뒤 / 다음 줄 전체
//
// 마스킹은 **기록 전에** 적용된다 — 원문이 잠깐이라도 파일에 닿지 않는다.

export const MASK = '****'
export const KEY_REDACTED = '[PRIVATE KEY REDACTED]'

// ⚠️ 이 정규식들은 **원격이 보낸 출력**에 돌아간다 = 신뢰 경계 밖의 입력이다.
// 접두사를 `[\w]*` 처럼 무제한 반복으로 두면 긴 한 줄(로그 덤프 1MB)에서 백트래킹이 폭발해
// main 프로세스가 멈춘다(실측: 1MB 줄에서 무한 대기). 반복은 전부 상한을 두거나 아예 없앤다.
//
// 1. 명령줄 인자. `-pVALUE`(mysql·redis 관례)와 `--password[= ]VALUE` 계열.
const ARG_SHORT_P = /(^|\s)-p(\S+)/g
const ARG_LONG = /(--(?:password|passwd|token|api-?key|secret|access-?key))([= ])(\S+)/gi
// sshpass -p <값> — 현실에서 가장 흔한 평문 유출 경로(W2 보안 리뷰 L1). `-p` 앞에 `sshpass` 키워드를
// 요구해 `ssh -p 22`(포트 옵션)와 겹치지 않는다.
const SSHPASS = /(^|\s)(sshpass\s+-p\s+)(\S+)/gi
// 2. 환경변수 대입. 접두사(MY_API_KEY=…)는 **먹지 않는다** — 키워드부터 매칭해도 앞부분이 그대로
//    남아 결과가 같고(`MY_API_KEY=****`), 접두사 반복이 없어야 긴 줄에서 선형으로 끝난다.
const ENV_ASSIGN = /(PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|ACCESS_?KEY)(\s*=\s*)(\S+)/gi
// URL 인증정보의 비밀번호 부분만. 스킴 길이를 묶어 스킴이 없는 긴 줄에서 재스캔이 누적되지 않게 한다.
const URL_CRED = /([A-Za-z][\w+.-]{0,15}:\/\/[^\s:/@]+):([^\s@/]+)@/g
const AUTH_HEADER = /(authorization\s*:\s*(?:bearer|basic|token)\s+)(\S+)/gi
// 3. 개인키 블록 경계.
const KEY_BEGIN = /-----BEGIN [^-]*PRIVATE KEY-----/
const KEY_END = /-----END [^-]*PRIVATE KEY-----/
// 4. 프롬프트. 줄이 프롬프트로 끝나면 다음 비어 있지 않은 줄이 비밀이고,
//    프롬프트 뒤에 같은 줄에서 값이 이어지면 그 뒤가 비밀이다(echo 가 켜진 read -p).
const PROMPT_TAIL = /(password|passphrase|비밀번호|암호)\s*:?\s*$/i
const PROMPT_INLINE = /^(.*?(?:password|passphrase|비밀번호|암호)\s*:\s*)(\S.*)$/i

// 한 줄 안에서 규칙 1·2 를 적용한다. 이미 마스킹된 값(****)에 다시 걸려도 결과는 같다(멱등).
function maskLine(line: string): string {
  let out = line.replace(ARG_SHORT_P, `$1-p${MASK}`)
  out = out.replace(SSHPASS, `$1$2${MASK}`)
  out = out.replace(ARG_LONG, `$1$2${MASK}`)
  out = out.replace(ENV_ASSIGN, `$1$2${MASK}`)
  out = out.replace(URL_CRED, `$1:${MASK}@`)
  out = out.replace(AUTH_HEADER, `$1${MASK}`)
  const inline = PROMPT_INLINE.exec(out)
  if (inline) out = inline[1] + MASK
  return out
}

// 스트리밍 마스커. 개인키 블록과 프롬프트 인접 규칙은 줄을 넘나들므로 상태가 필요하다
// (세션 로그는 청크 단위로 들어온다). 상태는 세션당 하나다.
export function createMasker(): { mask(text: string): string } {
  let inKey = false
  let awaitingSecret = false
  return {
    mask(text: string): string {
      const lines = text.split('\n')
      const out: string[] = []
      for (const line of lines) {
        if (inKey) {
          // 블록 본문은 통째로 버린다(BEGIN 자리에 이미 표식을 남겼다).
          if (KEY_END.test(line)) inKey = false
          out.push('')
          continue
        }
        if (KEY_BEGIN.test(line)) {
          inKey = !KEY_END.test(line) // 한 줄에 BEGIN·END 가 다 있으면 그 자리에서 끝난다
          awaitingSecret = false
          out.push(KEY_REDACTED)
          continue
        }
        if (awaitingSecret && line.trim() !== '') {
          awaitingSecret = false
          out.push(MASK)
          continue
        }
        // 빈 줄은 플래그를 건드리지 않는다. SessionLog 는 '\n' 로 끝나는 완성 줄만 넘기므로
        // split 이 만드는 **마지막 빈 요소**가 매번 플래그를 지웠고, 그래서 청크를 넘는 "다음 줄"
        // 규칙이 프로덕션에서 한 번도 발동하지 못했다(에코된 비밀번호가 평문으로 기록됨).
        if (line.trim() !== '') awaitingSecret = PROMPT_TAIL.test(line)
        out.push(maskLine(line))
      }
      // 개인키 본문을 '' 로 바꾸면 빈 줄이 남는다 — 로그 가독성만 해치므로 연속 빈 줄을 접는다.
      return out.join('\n').replace(/\n{3,}/g, '\n\n')
    }
  }
}

// 한 번에 마스킹(히스토리 한 줄 · 단위 테스트). 상태를 남기지 않는다.
export function maskSecrets(text: string): string {
  return createMasker().mask(text)
}
