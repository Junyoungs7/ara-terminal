// M12 R3 RV-03 AI 작성 줄 — main 원장(규칙은 @shared/aiLines). 에이전트 훅(agents/feature.ts)이 쓰기 도구의 끝을 넘기면
// 그 파일을 읽어 표시를 갱신하고 창에 'code:aiLinesChanged' { path } 를 민다. 보기(에디터·diff)는 지금 보이는 글을 주고 범위를 받는다.
// 메모리에만(앱을 끄면 사라진다 — Orca 도 "아라 안에만"). 원격 작업 단위는 훅이 서버에서 이 PC 로 안 와서 표시가 없다.
// ponytail: 파일 수 상한 LRU(Map 순서) · 파일당 4MB. 다시 켜도 남기려면 userData 에 글 해시+표시만 남기는 쪽으로.
import { BrowserWindow } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { AI_LINES_MAX_BYTES, AI_LINES_MAX_FILES, aiWriteOf, applyWrite, carryMask, rangesOf, splitLines, type AiMask } from '@shared/aiLines'
import { handle } from '../ipc/handle'
import { pushSend } from '../util/windowPush'

const keyOf = (p: string): string => {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

export function createAiLines(read: (path: string) => Promise<string | null> = readSmall) {
  const files = new Map<string, AiMask>()
  /** 같은 파일의 쓰기가 겹치면 순서대로(앞 결과 위에 다음). */
  const queue = new Map<string, Promise<void>>()
  return {
    /** 훅 본문 하나. 쓰기 도구가 아니면 아무것도 안 한다. 끝나면 바뀐 파일 경로(아니면 null). */
    ingest(payload: Record<string, unknown>): Promise<string | null> {
      const w = aiWriteOf(payload)
      if (!w) return Promise.resolve(null)
      const cwd = typeof payload['cwd'] === 'string' ? payload['cwd'] : undefined
      if (!isAbsolute(w.path) && !cwd) return Promise.resolve(null)
      const path = isAbsolute(w.path) ? resolve(w.path) : resolve(cwd!, w.path)
      const key = keyOf(path)
      const run = (queue.get(key) ?? Promise.resolve()).then(async () => {
        const text = await read(path)
        if (text === null) return void files.delete(key)
        const prev = files.get(key) ?? null
        files.delete(key) // 맨 뒤로(최근)
        files.set(key, applyWrite(prev, text, w.written))
        while (files.size > AI_LINES_MAX_FILES) files.delete(files.keys().next().value!)
      })
      queue.set(key, run)
      return run.then(
        () => {
          if (queue.get(key) === run) queue.delete(key)
          return path
        },
        () => null
      )
    },
    /** 지금 보이는 글 기준 AI 줄 범위. 원장에 없으면 []. 원장은 바꾸지 않는다(사람이 고친 줄은 맞춰지지 않아 사람 것으로 보인다). */
    ranges(path: string, text: string): [number, number][] {
      const m = files.get(keyOf(path))
      if (!m || text.length > AI_LINES_MAX_BYTES) return []
      return rangesOf(carryMask(m, splitLines(text)))
    }
  }
}

async function readSmall(path: string): Promise<string | null> {
  try {
    const st = await stat(path)
    return st.isFile() && st.size <= AI_LINES_MAX_BYTES ? await readFile(path, 'utf8') : null
  } catch {
    return null
  }
}

const ledger = createAiLines()

/** 에이전트 훅 하나(agents/feature.ts 의 훅 받기에서). 바뀌면 모든 창에 알린다. */
export function ingestAiWrite(payload: Record<string, unknown>): void {
  void ledger.ingest(payload).then((path) => {
    if (path) for (const win of BrowserWindow.getAllWindows()) pushSend(win.webContents, 'code:aiLinesChanged', { path })
  })
}

export function registerAiLines(): void {
  handle('code:aiLines', ({ path, text }) => (typeof path === 'string' && isAbsolute(path) && typeof text === 'string' ? ledger.ranges(path, text) : []))
}
