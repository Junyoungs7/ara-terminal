// M12 R2 머지 충돌 3-way(대응표 RV-01) — 충돌 표시 줄 찾기·Monaco 장식. stablyai/orca @fdfcfb3551 (MIT)
// src/renderer/src/components/editor/monaco-conflict-decorations.ts + text-line-offsets.ts(forEachLine) + ConflictComponents.tsx
// (getNextConflictNavigationIndex)를 거의 그대로. 바뀐 것: 라벨은 부르는 쪽이 넘긴다(i18n — 기본값은 Orca 영어, Orca 시험 그대로 돈다).
// 3-way = 현재(ours) · 공통 조상(base, diff3/zdiff3 일 때) · 들어오는(theirs) 세 구역을 색으로 가른다(Orca 방식 — 3칸 병합 편집기가 아니다).
// monaco 는 타입만 — 이 파일은 단위 시험(node)에서도 돈다.
import type { editor, IRange } from 'monaco-editor'

type ConflictBlock = {
  startLine: number
  baseLine?: number
  separatorLine: number
  endLine: number
}

type ParsedConflictBlock = ConflictBlock & {
  startText: string
  baseText?: string
  separatorText: string
  endText: string
}

type ConflictSection = 'current' | 'base' | 'incoming'

function getLineEndColumn(line: string): number {
  return line.length + 1
}

function makeWholeLineRange(startLineNumber: number, endLineNumber: number): IRange {
  return {
    startLineNumber,
    startColumn: 1,
    endLineNumber,
    endColumn: 1
  }
}

function makeMarkerRange(lineNumber: number, line: string): IRange {
  return {
    startLineNumber: lineNumber,
    startColumn: 1,
    endLineNumber: lineNumber,
    endColumn: getLineEndColumn(line)
  }
}

function makeMarkerDecoration(
  lineNumber: number,
  line: string,
  label: string
): editor.IModelDeltaDecoration {
  return {
    range: makeMarkerRange(lineNumber, line),
    options: {
      isWholeLine: true,
      className: 'orca-conflict-marker-line',
      linesDecorationsClassName: 'orca-conflict-line-decoration',
      marginClassName: 'orca-conflict-margin',
      hoverMessage: { value: label },
      linesDecorationsTooltip: label,
      after: {
        content: ` ${label}`,
        inlineClassName: 'orca-conflict-marker-label'
      }
    }
  }
}

function makeSectionDecoration(
  startLineNumber: number,
  endLineNumber: number,
  section: ConflictSection
): editor.IModelDeltaDecoration | null {
  if (startLineNumber > endLineNumber) {
    return null
  }

  return {
    range: makeWholeLineRange(startLineNumber, endLineNumber),
    options: {
      isWholeLine: true,
      className: `orca-conflict-section-line orca-conflict-${section}-line`
    }
  }
}

export function findGitConflictBlocks(content: string): ConflictBlock[] {
  return parseGitConflictBlocks(content).map(({ startLine, baseLine, separatorLine, endLine }) => ({
    startLine,
    ...(baseLine === undefined ? {} : { baseLine }),
    separatorLine,
    endLine
  }))
}

export function getGitConflictMarkerLineLength(content: string, lineNumber: number): number {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    return 0
  }
  let foundLength = 0
  forEachLine(content, (lineStart, lineEnd, currentLineNumber) => {
    if (currentLineNumber !== lineNumber) {
      return
    }
    foundLength = lineEnd - lineStart
    return false
  })
  return foundLength
}

function parseGitConflictBlocks(content: string): ParsedConflictBlock[] {
  const blocks: ParsedConflictBlock[] = []
  let current: {
    startLine: number
    startText: string
    baseLine?: number
    baseText?: string
    separatorLine?: number
    separatorText?: string
  } | null = null

  forEachLine(content, (lineStart, lineEnd, lineNumber) => {
    if (lineStartsWith(content, lineStart, lineEnd, '<<<<<<<')) {
      current = { startLine: lineNumber, startText: content.slice(lineStart, lineEnd) }
      return
    }

    if (!current) {
      return
    }

    if (lineStartsWith(content, lineStart, lineEnd, '|||||||')) {
      current.baseLine = lineNumber
      current.baseText = content.slice(lineStart, lineEnd)
      return
    }

    if (lineEquals(content, lineStart, lineEnd, '=======')) {
      current.separatorLine = lineNumber
      current.separatorText = '======='
      return
    }

    if (lineStartsWith(content, lineStart, lineEnd, '>>>>>>>')) {
      if (current.separatorLine && current.separatorText) {
        blocks.push({
          startLine: current.startLine,
          startText: current.startText,
          baseLine: current.baseLine,
          baseText: current.baseText,
          separatorLine: current.separatorLine,
          separatorText: current.separatorText,
          endLine: lineNumber,
          endText: content.slice(lineStart, lineEnd)
        })
      }
      current = null
    }
  })

  return blocks
}

export function hasGitConflictMarkers(content: string): boolean {
  let found = false
  forEachLine(content, (lineStart, lineEnd) => {
    found =
      lineStartsWith(content, lineStart, lineEnd, '<<<<<<<') ||
      lineStartsWith(content, lineStart, lineEnd, '|||||||') ||
      lineEquals(content, lineStart, lineEnd, '=======') ||
      lineStartsWith(content, lineStart, lineEnd, '>>>>>>>')
    return found ? false : undefined
  })
  return found
}

export type ConflictLabels = { current: string; base: string; incoming: string; end: string }
const ORCA_LABELS: ConflictLabels = { current: 'Current change', base: 'Common ancestor', incoming: 'Incoming change', end: 'End conflict' }

export function buildGitConflictDecorations(content: string, labels: ConflictLabels = ORCA_LABELS): editor.IModelDeltaDecoration[] {
  const decorations: editor.IModelDeltaDecoration[] = []

  for (const block of parseGitConflictBlocks(content)) {
    const currentEndLine = (block.baseLine ?? block.separatorLine) - 1
    const baseStartLine = block.baseLine ? block.baseLine + 1 : null
    const sectionDecorations = [
      makeSectionDecoration(block.startLine + 1, currentEndLine, 'current'),
      baseStartLine ? makeSectionDecoration(baseStartLine, block.separatorLine - 1, 'base') : null,
      makeSectionDecoration(block.separatorLine + 1, block.endLine - 1, 'incoming')
    ]

    for (const decoration of sectionDecorations) {
      if (decoration) {
        decorations.push(decoration)
      }
    }

    decorations.push(
      makeMarkerDecoration(
        block.startLine,
        block.startText,
        labels.current
      ),
      ...(block.baseLine
        ? [
            makeMarkerDecoration(
              block.baseLine,
              block.baseText ?? '',
              labels.base
            )
          ]
        : []),
      makeMarkerDecoration(
        block.separatorLine,
        block.separatorText,
        labels.incoming
      ),
      makeMarkerDecoration(
        block.endLine,
        block.endText,
        labels.end
      )
    )
  }

  return decorations
}

function lineStartsWith(
  content: string,
  lineStart: number,
  lineEnd: number,
  prefix: string
): boolean {
  return lineEnd - lineStart >= prefix.length && content.startsWith(prefix, lineStart)
}

function lineEquals(content: string, lineStart: number, lineEnd: number, value: string): boolean {
  return lineEnd - lineStart === value.length && content.startsWith(value, lineStart)
}

/** Visit [start, end) lines without trailing CR or per-line substring allocation; false stops the whole-document scan. */
function forEachLine(
  content: string,
  visit: (lineStart: number, lineEnd: number, lineNumber: number) => boolean | void
): void {
  let lineStart = 0
  let lineNumber = 1
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue
    }
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    if (visit(lineStart, lineEnd, lineNumber) === false) {
      return
    }
    lineStart = index + 1
    lineNumber += 1
  }
}

/** Orca ConflictComponents getNextConflictNavigationIndex — 처음 누르면 첫(이전이면 끝) 충돌, 그다음은 돌아가며. */
export function getNextConflictNavigationIndex({
  currentIndex,
  direction,
  total
}: {
  currentIndex: number | null
  direction: 'previous' | 'next'
  total: number
}): number | null {
  if (total <= 0) {
    return null
  }
  if (currentIndex === null || currentIndex < 0 || currentIndex >= total) {
    return direction === 'previous' ? total - 1 : 0
  }
  return direction === 'previous' ? (currentIndex + total - 1) % total : (currentIndex + 1) % total
}
