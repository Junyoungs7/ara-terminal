/**
 * AISESS 하네스 러너 — 다섯 변형을 돌리고 **기계가 판정한다**.
 *
 * 왜 러너가 따로 있나: ⑥(부트 복원)은 **3회 연속**이 합격선인데 앱을 세 번 띄워야 해서 프로브
 * 파일 안에서는 못 돈다. 그 반복을 밖에 두면 다음 사람이 1회로 판정한다 — 2026-09-10 에 실제로
 * 그랬고, 한 번 통과한 판이 경합이었다(같은 코드가 돌릴 때마다 다른 결과를 냈다). 그래서 반복을
 * **커밋되는 자리**에 둔다.
 *
 * 돌리는 법: npm run probe:aisess   (electron-vite build 가 앞에 붙는다)
 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const probe = join(here, 'aisess-probe.cjs')

/** ⑥ 은 3회 연속 — 경합은 1회로 안 드러난다. */
const RUNS = [
  { name: '① ②③④⑤ 기본', env: {} },
  { name: '분할 + 끊김 카드', env: { SPLIT: '1' } },
  { name: '옛 기준선(AI 필드 없음)', env: { AICLI: '0' } },
  { name: '⑥ 부트 복원 1/3', env: { RESTORE3: '1' } },
  { name: '⑥ 부트 복원 2/3', env: { RESTORE3: '1' } },
  { name: '⑥ 부트 복원 3/3', env: { RESTORE3: '1' } }
]

/**
 * 🔴 **띄우기 전에 문법부터 본다.**
 *
 * 2026-09-11: 이 프로브에 문법 오류(정규식 리터럴의 백슬래시)가 들어간 채로 electron 을 띄웠더니
 * **준영님 화면에 "A JavaScript error occurred in the main process" 모달이 떴다.**
 * `_harnessGuard.cjs` 의 uncaughtException 리스너가 바로 그 모달을 막으려고 있는데,
 * **SyntaxError 는 파싱 단계라 그 require 가 실행되기도 전**이라 못 막는다.
 * 런타임 가드로는 닫을 수 없는 구멍이고, 여기서 닫는다 — 하네스는 어떤 경우에도 사람의 화면을
 * 건드리면 안 된다(그게 이 하네스가 offscreen 인 이유 전부다).
 */
const chk = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' })
if (chk.status !== 0) {
  console.log('🔴 프로브에 문법 오류가 있다 — electron 을 띄우지 않는다(띄우면 사용자 화면에 모달이 뜬다).')
  console.log(chk.stderr ?? '')
  process.exit(1)
}

let bad = 0
for (const r of RUNS) {
  const p = spawnSync('npx', ['electron', probe], {
    env: { ...process.env, ...r.env },
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  const out = (p.stdout ?? '') + (p.stderr ?? '')
  // RESTORE3 은 프로브가 종료 코드를 안 내므로(측정 한 줄뿐) 출력으로 판정한다.
  const ok = r.env.RESTORE3 === '1' ? out.includes('layout.restore 가 이긴다') : p.status === 0
  if (!ok) {
    bad += 1
    console.log(`\n🔴 ${r.name}\n${out.split('\n').slice(-25).join('\n')}`)
  }
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${r.name}`)
}

console.log(bad === 0 ? '\nAISESS 프로브 전부 통과' : `\n🔴 ${bad}건 실패`)
process.exit(bad === 0 ? 0 : 1)
