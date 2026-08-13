// 종료 회귀 하네스가 require 할 실(real) main 모듈을 CJS 단일 파일로 번들한다(fixdestroy 번들러와 같은 설정).
import esbuild from 'esbuild'
import { resolve } from 'node:path'

await esbuild.build({
  entryPoints: ['tests/shutdown-harness-main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'tests/.shutdown-harness-main.cjs',
  external: ['electron', 'node-pty', 'ssh2'],
  alias: { '@shared': resolve('src/shared') },
  logLevel: 'info'
})
console.log('shutdown harness bundle OK')
