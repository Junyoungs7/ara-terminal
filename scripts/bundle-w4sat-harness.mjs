// W4sat E2E 하네스가 require 할 실(real) main 모듈을 CJS 단일 파일로 번들한다(F7 패턴 재사용,
// scripts/bundle-f7-harness.mjs). electron/node-pty/ssh2 는 런타임 external.
import esbuild from 'esbuild'
import { resolve } from 'node:path'

await esbuild.build({
  entryPoints: ['tests/w4sat-harness-main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'tests/.w4sat-harness-main.cjs',
  external: ['electron', 'node-pty', 'ssh2'],
  alias: { '@shared': resolve('src/shared') },
  logLevel: 'info'
})
console.log('W4sat harness bundle OK')
