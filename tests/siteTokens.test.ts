// 사이트(site/assets/site.css)와 앱(src/renderer/styles/tokens.css)의 토큰 드리프트 시험.
// 사이트는 앱 토큰을 import 할 수 없다(정적 배포) — 값을 베껴 두므로, 이름이 같은 토큰은 값도 같아야 한다.
// 한계: 첫 :root 블록만 본다. 사이트 본문에 박힌 리터럴 색은 안 본다(이름 붙은 토큰만).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const rootVars = (file: string): Map<string, string> => {
  const css = readFileSync(join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const body = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().toLowerCase()]))
}
const site = rootVars('site/assets/site.css')
const app = rootVars('src/renderer/styles/tokens.css')

const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

describe('site.css ↔ tokens.css', () => {
  it('이름이 같은 토큰은 값이 같다', () => {
    const shared = [...site.keys()].filter((k) => app.has(k))
    // 양성 대조: 핵심 토큰이 실제로 양쪽에서 읽혀야 "0 건 불일치"가 의미가 있다.
    for (const k of ['--text-mid', '--text-lo', '--accent', '--bg-canvas', '--radius', '--ui', '--focus-ring-offset'])
      expect(shared).toContain(k)
    const diff = shared.filter((k) => site.get(k) !== app.get(k)).map((k) => `${k}: site ${site.get(k)} / app ${app.get(k)}`)
    expect(diff).toEqual([])
  })

  it('사이트 글자색(hi·mid·lo·accent·info)은 모든 표면에서 4.5 이상', () => {
    const bgs = ['--bg-abyss', '--bg-canvas', '--bg-surface', '--bg-raised', '--bg-overlay']
    const bad: string[] = []
    for (const fg of ['--text-hi', '--text-mid', '--text-lo', '--accent', '--info'])
      for (const bg of bgs) {
        const r = contrast(site.get(fg)!, site.get(bg)!)
        if (r < 4.5) bad.push(`${fg} × ${bg} = ${r.toFixed(2)}`)
      }
    expect(bad).toEqual([])
  })
})
