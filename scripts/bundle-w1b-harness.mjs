// W1B E2E 하네스가 require 할 실(real) main 모듈을 CJS 단일 파일로 번들한다(F7 번들러와 같은 설정).
import esbuild from 'esbuild'
import { resolve } from 'node:path'

await esbuild.build({
  entryPoints: ['tests/w1b-harness-main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'tests/.w1b-harness-main.cjs',
  external: ['electron', 'node-pty', 'ssh2'],
  alias: { '@shared': resolve('src/shared') },
  logLevel: 'info'
})
console.log('W1B harness bundle OK')
