// OR-1 — 설치본에 Oriel 동봉(electron-builder beforePack 훅). 결정: 브라우저는 무조건 Oriel·설치 파일에 동봉·Electron 공유.
// Oriel 원본(기본 D:/AI/ai-browser, env ORIEL_SRC 로 바꿈)의 앱 폴더만 .oriel-stage/ 로 복사한다 → electron-builder.yml
// extraResources 가 resources/oriel 로 싣는다 → main/oriel 감지 후보 첫째(`<resources>/oriel`)가 바로 맞는다.
//  · 싣는 것: bin·src·vendor·package.json(Oriel 세션: 런타임 npm 의존성 0, 네이티브 없음). node_modules(=Oriel 자기 Electron 45)는 안 싣는다 — 아라 Electron 으로 뜬다.
//  · 원본이 없거나 Oriel 이 아니면 **경고만** 하고 빈 폴더(동봉 없이 빌드 — 감지는 bin/oriel.mjs 가 없으면 건너뛴다).
//  · 동봉판 기록: resources/oriel/ara-bundle.json { oriel 판·커밋, 아라 Electron 판 }.
//  · 릴리스 점검: 아라 Electron 판이 scripts/ops/oriel-compat.json 의 마지막 점검 판과 다르면 경고(scripts/ops/oriel-compat.ps1 을 돌릴 것).
const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const DEST = join(ROOT, '.oriel-stage')
const PARTS = ['bin', 'src', 'vendor', 'package.json']

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')) // PowerShell 5.1 Set-Content UTF8 은 BOM 을 붙인다
  } catch {
    return null
  }
}

function stageOriel(src = process.env.ORIEL_SRC || 'D:/AI/ai-browser') {
  rmSync(DEST, { recursive: true, force: true })
  mkdirSync(DEST, { recursive: true })
  const araElectron = readJson(join(ROOT, 'node_modules', 'electron', 'package.json'))?.version ?? null
  const checked = readJson(join(ROOT, 'scripts', 'ops', 'oriel-compat.json'))
  if (araElectron && checked?.electron !== araElectron) {
    console.warn(`[stage-oriel] ⚠ 아라 Electron ${araElectron} 으로 Oriel e2e 를 돌린 기록이 없다(마지막 점검: ${checked?.electron ?? '없음'}) — scripts/ops/oriel-compat.ps1`)
  }
  const pkg = readJson(join(src, 'package.json'))
  if (pkg?.name !== 'oriel' || PARTS.some((p) => !existsSync(join(src, p)))) {
    console.warn(`[stage-oriel] ⚠ Oriel 원본이 없다(${src}) — Oriel 없이 빌드한다. ORIEL_SRC 로 위치를 줄 수 있다.`)
    return null
  }
  for (const p of PARTS) cpSync(join(src, p), join(DEST, p), { recursive: true })
  let commit = null
  try {
    commit = execFileSync('git', ['-C', src, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
  } catch {}
  const record = { oriel: pkg.version, commit, src, araElectron, stagedAt: new Date().toISOString() }
  writeFileSync(join(DEST, 'ara-bundle.json'), JSON.stringify(record, null, 2) + '\n')
  console.log(`[stage-oriel] Oriel ${pkg.version} (${commit ?? '?'}) → .oriel-stage`)
  return record
}

module.exports = async function beforePack() {
  stageOriel()
}
module.exports.stageOriel = stageOriel
if (require.main === module) stageOriel(process.argv[2])
