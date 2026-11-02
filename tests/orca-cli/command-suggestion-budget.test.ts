import { afterEach, describe, expect, it, vi } from 'vitest'
// Orca src/cli/command-suggestion-budget.test.ts(orcaRef ec112c6b01) — 경로만 바꿨다. 아라 명령 표에는 emulator 가 없어 그 줄은 worktree 로.
import * as distance from '../../src/cli/editDistance'
import { suggestCommands, unknownFlagData } from '../../src/cli/commandSuggestion'
import type { CommandSpec } from '../../src/cli/specs'
import { COMMAND_SPECS } from '../../src/cli/specs'

const specs: CommandSpec[] = [
  { path: ['list'], summary: '', usage: '', allowedFlags: [] },
  { path: ['remove'], summary: '', usage: '', allowedFlags: [], destructive: true }
]

afterEach(() => vi.restoreAllMocks())

describe('suggestion distance work', () => {
  it('does no distance calculations for a long command, including destructive intent', () => {
    const spy = vi.spyOn(distance, 'levenshtein')
    expect(suggestCommands(specs, ['x'.repeat(32_768)])).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the live destructive alias registry out of long-input distance work', () => {
    const spy = vi.spyOn(distance, 'levenshtein')
    expect(suggestCommands(COMMAND_SPECS, ['worktree', 'x'.repeat(32_768)])).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('does no distance calculations for a long flag but still lists valid flags', () => {
    const spy = vi.spyOn(distance, 'levenshtein')
    expect(unknownFlagData('x'.repeat(32_768), ['worktree', 'json'])).toEqual({
      validFlags: ['json', 'worktree'],
      suggestions: [],
      nextSteps: ['Valid flags: --json, --worktree']
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the inclusive three-edit suggestion boundary', () => {
    expect(suggestCommands(specs, ['listxxx'])).toEqual(['list'])
    expect(unknownFlagData('jsonxxx', ['json']).suggestions).toEqual(['json'])
  })

  it('keeps the inclusive one-edit destructive intent boundary', () => {
    expect(suggestCommands(specs, ['remov'])).toEqual(['remove'])
    expect(suggestCommands(specs, ['remo'])).toEqual([])
  })

  it('retains UTF-16 distance semantics at the length boundary', () => {
    expect(unknownFlagData('json😀x', ['json']).suggestions).toEqual(['json'])
    expect(unknownFlagData('json😀😀', ['json']).suggestions).toEqual([])
  })
})
