// F6 E2E 하네스가 require 할 실(real) main 모듈을 CJS 단일 파일로 번들한다.
// electron/node-pty/ssh2 는 런타임 external(하네스 프로세스에서 해석).
import esbuild from 'esbuild'
import { resolve } from 'node:path'

await esbuild.build({
  entryPoints: ['tests/f6-harness-main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'tests/.f6-harness-main.cjs',
  external: ['electron', 'node-pty', 'ssh2'],
  alias: { '@shared': resolve('src/shared') },
  logLevel: 'info'
})
console.log('F6 harness bundle OK')
