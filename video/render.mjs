/**
 * 영상 렌더 — `npm run render` (한 편만: `npm run render -- ad`).
 *
 * 결과는 `site/video/` 로 바로 나간다. 사이트가 그 파일을 그대로 담고,
 * `npm run site:deploy` 가 다른 파일과 함께 서버로 올린다.
 *
 * CPU 는 절반만 쓴다(remotion.config.ts) — 렌더 도는 동안에도 이 PC 로 일할 수 있어야 한다.
 */
import { bundle } from '@remotion/bundler'
import { getCompositions, renderMedia } from '@remotion/renderer'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const only = process.argv.slice(2)
const OUT = join(process.cwd(), '..', 'site', 'video')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

console.log('번들 만드는 중…')
const serveUrl = await bundle({ entryPoint: join(process.cwd(), 'src', 'index.ts') })

const comps = await getCompositions(serveUrl)
const targets = comps.filter((c) => only.length === 0 || only.includes(c.id))
if (!targets.length) {
  console.error(`렌더할 것이 없습니다. 있는 것: ${comps.map((c) => c.id).join(', ')}`)
  process.exit(1)
}

const concurrency = Math.max(2, Math.floor(os.cpus().length / 2))
for (const c of targets) {
  const outputLocation = join(OUT, `ara-${c.id}.mp4`)
  const seconds = (c.durationInFrames / c.fps).toFixed(1)
  process.stdout.write(`\n${c.id} (${seconds}초) `)
  let last = -1
  await renderMedia({
    composition: c,
    serveUrl,
    codec: 'h264',
    outputLocation,
    concurrency,
    // 사내망에서 배포할 파일이라 용량을 아낀다. 텍스트 위주 화면이라 이 정도면 눈에 손해가 없다.
    crf: 23,
    audioCodec: 'aac',
    onProgress: ({ progress }) => {
      const pct = Math.round(progress * 100)
      if (pct >= last + 10) {
        last = pct
        process.stdout.write(`${pct}% `)
      }
    }
  })
  console.log(`→ site/video/ara-${c.id}.mp4`)
}
console.log('\n끝. 사이트에 담으려면 `npm run site:deploy` (저장소 루트에서).')
