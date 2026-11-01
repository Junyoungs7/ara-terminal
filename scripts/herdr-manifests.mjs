// herdr 화면 매니페스트(TOML 22종) → src/shared/agentManifests.json. 새 의존 없이(TOML 라이브러리 없음).
// 출처: herdrdev/herdr src/detect/manifests/*.toml (Apache-2.0). 자동 갱신(herdr.dev)은 쓰지 않는다 — 갱신은 이 스크립트를 손으로 다시 돌린다
// (월요일 점검 orca-watch.ps1 이 herdr 매니페스트 diff 를 알려 준다).
//
//   node scripts/herdr-manifests.mjs D:/herdr-src/herdr
//
// 파서는 매니페스트가 쓰는 TOML 만 읽는다: `키 = 값`, `[[rules]]`, 문자열("…" 기본 · '…' 리터럴), 정수, 참/거짓,
// 여러 줄 배열, 인라인 표 { … }, `#` 주석. 그 밖의 문법(여러 줄 문자열·[표]·날짜 등)을 만나면 멈춘다 — 조용히 틀리게 읽지 않는다.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function parseManifestToml(text) {
  let i = 0
  const fail = (msg) => {
    const line = text.slice(0, i).split('\n').length
    throw new Error(`${msg} (줄 ${line})`)
  }
  const skipWs = (newlines) => {
    for (;;) {
      const c = text[i]
      if (c === ' ' || c === '\t' || c === '\r' || (newlines && c === '\n')) i++
      else if (c === '#') while (i < text.length && text[i] !== '\n') i++
      else return
    }
  }
  const key = () => {
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i))
    if (!m) fail('키가 아님')
    i += m[0].length
    return m[0]
  }
  const value = () => {
    const c = text[i]
    if (c === "'") {
      if (text.startsWith("'''", i)) fail('여러 줄 문자열은 모름')
      const end = text.indexOf("'", i + 1)
      if (end < 0 || text.slice(i + 1, end).includes('\n')) fail('닫히지 않은 문자열')
      const s = text.slice(i + 1, end)
      i = end + 1
      return s
    }
    if (c === '"') {
      if (text.startsWith('"""', i)) fail('여러 줄 문자열은 모름')
      let s = ''
      i++
      for (;;) {
        const d = text[i++]
        if (d === undefined || d === '\n') fail('닫히지 않은 문자열')
        if (d === '"') return s
        if (d !== '\\') {
          s += d
          continue
        }
        const e = text[i++]
        const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
        if (e in simple) s += simple[e]
        else if (e === 'u' || e === 'U') {
          const n = e === 'u' ? 4 : 8
          s += String.fromCodePoint(parseInt(text.slice(i, i + n), 16))
          i += n
        } else fail(`모르는 이스케이프 \\${e}`)
      }
    }
    if (c === '[') {
      i++
      const out = []
      for (;;) {
        skipWs(true)
        if (text[i] === ']') {
          i++
          return out
        }
        out.push(value())
        skipWs(true)
        if (text[i] === ',') i++
        else if (text[i] !== ']') fail('배열에 , 나 ] 가 없음')
      }
    }
    if (c === '{') {
      i++
      const out = {}
      for (;;) {
        skipWs(false)
        if (text[i] === '}') {
          i++
          return out
        }
        const k = key()
        skipWs(false)
        if (text[i++] !== '=') fail('= 가 없음')
        skipWs(false)
        out[k] = value()
        skipWs(false)
        if (text[i] === ',') i++
        else if (text[i] !== '}') fail('인라인 표에 , 나 } 가 없음')
      }
    }
    const m = /^(true|false|-?\d+)(?![\w.:-])/.exec(text.slice(i))
    if (!m) fail('모르는 값')
    i += m[0].length
    return m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1])
  }

  const root = {}
  let table = root
  for (;;) {
    skipWs(true)
    if (i >= text.length) return root
    if (text.startsWith('[[', i)) {
      const end = text.indexOf(']]', i)
      const name = text.slice(i + 2, end).trim()
      if (name !== 'rules') fail(`모르는 표 [[${name}]]`)
      i = end + 2
      table = {}
      ;(root.rules ??= []).push(table)
      continue
    }
    if (text[i] === '[') fail('[표] 는 모름')
    const k = key()
    skipWs(false)
    if (text[i++] !== '=') fail('= 가 없음')
    skipWs(false)
    table[k] = value()
  }
}

function main() {
  const repo = process.argv[2]
  if (!repo) throw new Error('사용법: node scripts/herdr-manifests.mjs <herdr 저장소>')
  const dir = join(repo, 'src', 'detect', 'manifests')
  let commit = 'unknown'
  try {
    commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    // 저장소가 아니면(압축본) 커밋을 모른다 — 그대로 적는다.
  }
  const manifests = {}
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.toml')).sort()) {
    const m = parseManifestToml(readFileSync(join(dir, f), 'utf8'))
    manifests[m.id] = m
  }
  const out = { source: `herdrdev/herdr src/detect/manifests/*.toml@${commit} (Apache-2.0)`, manifests }
  writeFileSync('src/shared/agentManifests.json', JSON.stringify(out, null, 1) + '\n')
  console.log(`${Object.keys(manifests).length}종 → src/shared/agentManifests.json (${commit})`)
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) main()
