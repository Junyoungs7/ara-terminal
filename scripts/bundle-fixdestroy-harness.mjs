// FIX-destroyed E2E 하네스가 require 할 실(real) main 모듈을 CJS 단일 파일로 번들한다(F7/W1B 번들러와 같은 설정).
import esbuild from 'esbuild'
import { resolve } from 'node:path'

await esbuild.build({
  entryPoints: ['tests/fixdestroy-harness-main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'tests/.fixdestroy-harness-main.cjs',
  external: ['electron', 'node-pty', 'ssh2'],
  alias: { '@shared': resolve('src/shared') },
  logLevel: 'info'
})
console.log('FIX-destroyed harness bundle OK')
