import { execFile } from 'node:child_process'

/**
 * 이 PC 에 그 명령이 있는가. **셸을 거치지 않는 execFile** 로 where/which 를 부른다 —
 * 셸을 태우면 bin 이 명령줄에 섞인다(#90 이 그렇게 정해 뒀고 여기는 그 함수를 꺼내 온 것이다).
 *
 * 왜 꺼냈나: #126 에서 `claude` 유무를 **엔진을 띄우기 전에** 알아야 하는데, 그 판정이 IPC
 * 핸들러 안에만 있으면 main 안에서 부를 방법이 없어 같은 코드를 한 벌 더 쓰게 된다.
 *
 * 판정을 종료코드와 출력 **둘 다** 로 하는 이유: `where` 는 못 찾아도 0 을 주는 경우가 있고,
 * 찾았는데 빈 줄만 주는 경우도 봤다(원격 cliInstalled 와 같은 판정).
 */
export function hasLocalCli(bin: string, timeoutMs = 4000): Promise<boolean> {
  const file = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) => {
    execFile(file, [bin], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout.trim() !== '')
    })
  })
}
