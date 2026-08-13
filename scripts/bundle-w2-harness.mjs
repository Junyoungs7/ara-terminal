// W2 스크린샷 하네스가 require 할 ssh2 테스트 서버를 CJS 단일 파일로 번들한다(W1B 번들러와 같은 설정).
import esbuild from 'esbuild'
import { resolve } from 'node:path'

await esbuild.build({
  entryPoints: ['tests/w2-harness-main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'tests/.w2-harness-main.cjs',
  external: ['electron', 'node-pty', 'ssh2'],
  alias: { '@shared': resolve('src/shared') },
  logLevel: 'info'
})
console.log('W2 harness bundle OK')
