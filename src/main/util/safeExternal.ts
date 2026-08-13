// R3.3: 외부 브라우저로 넘겨도 되는 URL 인지. 터미널 출력은 원격 서버가 찍는 신뢰할 수 없는 입력이라
// shell.openExternal 에 그대로 넘기면 file:·ms-msdt: 같은 스킴이 임의 프로그램 실행 경로가 된다.
// electron 을 import 하지 않는 순수 함수로 둬 단위 테스트에서 그대로 부를 수 있게 한다.
export function isSafeExternal(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}
