// M7 R1 WS-10 git **조회만**(읽기) — 변경 목록·분기 비교·파일 한 개의 양쪽 글. 쓰기(stage/commit/push)는 R2(main/scm).
// Orca src/main/git/source-control/{status-read,branch-compare,file-diff,branch-diff,diff-result}.ts(orcaRef fdfcfb3551)의 1차 판.
// 뺀 것: 상태 읽기 합치기·캐시·줄 수 통계·서브모듈·WSL·이미지 미리보기·충돌 작업 감지. 공유 API = agent_talk/m7-shared-api.md.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { git as localGit } from '../worktrees/git'
import { runProcess, type RunResult } from '../util/runProcess'
import {
  DEFAULT_BASE_REF_ARGS,
  DIFF_READ_MAX_BYTES,
  buildDiffResult,
  isSafeRelPath,
  parseNameStatusZ,
  parseStatusV2,
  pickDefaultBaseRef,
  type GitBranchCompareResult,
  type GitConflictOperation,
  type GitDiffArgs,
  type GitDiffImageResult,
  type GitDiffResult,
  type GitStatusResult
} from '@shared/gitDiff'

/**
 * M8 R5 — 조회가 쓰는 두 가지(git 한 번 · 작업 폴더의 파일 글). 로컬이 기본, 원격 작업 단위는 work/backend 가 SSH 판을 넘긴다.
 * readText: 없으면 '', DIFF_READ_MAX_BYTES 를 넘으면 null.
 */
export type InspectIO = {
  git: (args: string[], cwd: string) => Promise<RunResult>
  readText: (root: string, rel: string) => Promise<string | null>
  /** 3차 R2-B 그림 비교 — git 출력 바이트(cat-file blob). 실패면 null. */
  gitBytes?: (args: string[], cwd: string) => Promise<Buffer | null>
  /** 3차 R2-B 작업 폴더 파일 바이트. 없으면 null, max 를 넘으면 'tooLarge'. */
  readBytes?: (root: string, rel: string, max: number) => Promise<Uint8Array | null | 'tooLarge'>
}
export const LOCAL_INSPECT: InspectIO = {
  git: (args, cwd) => localGit(args, cwd),
  gitBytes: async (args, cwd) => {
    const r = await runProcess('git', args, { cwd, timeoutMs: 15_000, maxBuffer: DIFF_IMAGE_MAX_BYTES + 1024, raw: true })
    return r.code === 0 && r.stdoutBytes ? r.stdoutBytes : null
  },
  readBytes: async (root, rel, max) => {
    const st = await stat(join(root, rel)).catch(() => null)
    if (!st?.isFile()) return null
    return st.size > max ? 'tooLarge' : new Uint8Array(await readFile(join(root, rel)))
  },
  readText: async (root, rel) => {
    const p = join(root, rel)
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) return ''
    return st.size > DIFF_READ_MAX_BYTES ? null : readFile(p, 'utf8')
  }
}

const failed = (stderr: string, fallback: string): { ok: false; message: string } => ({ ok: false, message: stderr.trim() || fallback })

/** 작업 중 변경(스테이지됨·안 됨·추적 안 됨). Orca status-read 의 인자 그대로 + -z. ponytail: 출력은 runProcess 상한(16MB) 안에서 통째로 — 목록은 GIT_STATUS_LIMIT 에서 자른다. */
export async function readGitStatus(worktreePath: string, io: InspectIO = LOCAL_INSPECT): Promise<GitStatusResult> {
  const r = await io.git(['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], worktreePath)
  if (r.code !== 0) return failed(r.stderr, 'git status 실패')
  const out = parseStatusV2(r.stdout)
  // M12 R2 — 충돌이 있을 때만 어느 작업 중인지 본다(새로 고침마다 git 을 더 부르지 않게). [중단] 버튼이 이 값을 쓴다.
  if (out.entries.some((e) => e.status === 'conflicted')) out.operation = await detectConflictOperation(worktreePath, io)
  return out
}

/**
 * Orca git/source-control/git-conflict-operation.ts detectConflictOperation — 순서도 같다(merge → rebase → cherry-pick).
 * Orca 는 git 폴더의 파일·폴더를 직접 보지만, 원격(SSH)도 같은 길로 가게 git 에 묻는다(rev-parse --verify). 리베이스는 멈춘 커밋 REBASE_HEAD.
 */
export async function detectConflictOperation(worktreePath: string, io: InspectIO = LOCAL_INSPECT): Promise<GitConflictOperation> {
  const has = async (ref: string): Promise<boolean> => (await io.git(['rev-parse', '-q', '--verify', ref], worktreePath)).code === 0
  const [merge, rebase, pick] = await Promise.all(['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD'].map(has))
  return merge ? 'merge' : rebase ? 'rebase' : pick ? 'cherry-pick' : 'unknown'
}

/** 분기 기준 대비(갈림점 ↔ HEAD, 커밋된 것만). baseRef 를 안 주면 Orca 기본값(origin/HEAD → origin/main …). */
export async function readBranchCompare(worktreePath: string, baseRef?: string, io: InspectIO = LOCAL_INSPECT): Promise<GitBranchCompareResult> {
  const git = io.git
  let base = typeof baseRef === 'string' && baseRef.trim() ? baseRef.trim() : null
  if (base?.startsWith('-')) return { ok: false, message: `잘못된 기준: ${base}` }
  if (!base) {
    const d = await git([...DEFAULT_BASE_REF_ARGS], worktreePath)
    base = d.code === 0 ? pickDefaultBaseRef(d.stdout) : null
    if (!base) return { ok: false, message: '비교할 기준 브랜치(origin/main·main 등)를 찾지 못했습니다.' }
  }
  const mb = await git(['merge-base', base, 'HEAD'], worktreePath)
  if (mb.code !== 0) return failed(mb.stderr, `${base} 와의 갈림점을 찾지 못했습니다.`)
  const mergeBase = mb.stdout.trim()
  const r = await git(['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', '-M', mergeBase, 'HEAD', '--'], worktreePath)
  if (r.code !== 0) return failed(r.stderr, 'git diff 실패')
  return { ok: true, baseRef: base, mergeBase, ...parseNameStatusZ(r.stdout) }
}

type Side = { rev: string; path: string } | { disk: string }
/** 한쪽 글. 없으면 ''(추가·삭제), 상한을 넘으면 null(tooLarge). */
async function readSide(worktreePath: string, side: Side, io: InspectIO): Promise<string | null> {
  if ('disk' in side) return io.readText(worktreePath, side.disk)
  const git = io.git
  const spec = `${side.rev}:${side.path}`
  const size = await git(['cat-file', '-s', spec], worktreePath)
  if (size.code !== 0) return ''
  if (Number(size.stdout.trim()) > DIFF_READ_MAX_BYTES) return null
  const r = await git(['cat-file', 'blob', spec], worktreePath)
  return r.code === 0 ? r.stdout : ''
}

/** 비교 방식 → 양쪽(원래·바뀐 쪽). 잘못된 경로·방식이면 이유 글. */
function sidesOf(a: GitDiffArgs): [Side, Side] | string {
  if (!isSafeRelPath(a.filePath) || (a.oldPath !== undefined && !isSafeRelPath(a.oldPath))) return '잘못된 경로입니다.'
  const old = a.oldPath ?? a.filePath
  if (a.mode === 'unstaged') return [{ rev: '', path: a.filePath }, { disk: a.filePath }]
  if (a.mode === 'staged') return [{ rev: 'HEAD', path: old }, { rev: '', path: a.filePath }]
  if (a.mode === 'branch' && typeof a.mergeBase === 'string' && /^[0-9a-f]{7,64}$/i.test(a.mergeBase)) return [{ rev: a.mergeBase, path: old }, { rev: 'HEAD', path: a.filePath }]
  return '잘못된 비교 방식입니다.'
}

/** 파일 하나의 양쪽 글 — **연 파일만** 부른다(목록은 이름만). */
export async function readFileDiff(a: GitDiffArgs, io: InspectIO = LOCAL_INSPECT): Promise<GitDiffResult> {
  const sides = sidesOf(a)
  if (typeof sides === 'string') return { ok: false, message: sides }
  try {
    const [original, modified] = await Promise.all(sides.map((s) => readSide(a.worktreePath, s, io)))
    if (original === null || modified === null) return { ok: true, kind: 'tooLarge' }
    return buildDiffResult(original, modified)
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message ?? e) }
  }
}

/** 그림 비교 한쪽 상한(Orca 이미지 diff 도 바이너리 상한 안에서만). */
export const DIFF_IMAGE_MAX_BYTES = DIFF_READ_MAX_BYTES

async function readSideBytes(worktreePath: string, side: Side, io: InspectIO): Promise<Uint8Array | null | 'tooLarge'> {
  if ('disk' in side) return io.readBytes ? io.readBytes(worktreePath, side.disk, DIFF_IMAGE_MAX_BYTES) : null
  const spec = `${side.rev}:${side.path}`
  const size = await io.git(['cat-file', '-s', spec], worktreePath)
  if (size.code !== 0) return null // 그쪽에 없음(추가·삭제)
  if (Number(size.stdout.trim()) > DIFF_IMAGE_MAX_BYTES) return 'tooLarge'
  const b = io.gitBytes ? await io.gitBytes(['cat-file', 'blob', spec], worktreePath) : null
  return b ? new Uint8Array(b) : null
}

/**
 * 3차 R2-B 그림 비교(Orca EditorDiffFileSurface → ImageDiffViewer — binary 이고 isImage 면 양쪽 그림). Orca 는 diff 결과에 base64 를 싣지만,
 * 아라는 글 비교(git:diff)를 그대로 두고 그림 파일일 때만 이 조회로 양쪽 바이트를 따로 받는다. 없는 쪽 = null(그림 없음).
 */
export async function readFileDiffImage(a: GitDiffArgs, io: InspectIO = LOCAL_INSPECT): Promise<GitDiffImageResult> {
  const sides = sidesOf(a)
  if (typeof sides === 'string') return { ok: false, message: sides }
  try {
    const [original, modified] = await Promise.all(sides.map((s) => readSideBytes(a.worktreePath, s, io)))
    if (original === 'tooLarge' || modified === 'tooLarge') return { ok: false, tooLarge: true, message: '' }
    return { ok: true, original, modified }
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message ?? e) }
  }
}
