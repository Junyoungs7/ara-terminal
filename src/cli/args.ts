// M14 R2 `ara` 인자 읽기 — Orca src/cli/args.ts(parseArgs·findCommandSpec·isCommandGroup·validateCommandAndFlags, orcaRef ec112c6b01)의 1차 몫.
// 뺀 것: 위치 인자(positionalArgs)·반복 플래그·원격(--environment) — 아라 명령은 전부 --플래그로 받는다.
import { unknownCommandData, unknownFlagData } from './commandSuggestion'
import { BOOLEAN_FLAGS, GLOBAL_FLAGS, specPaths, type CommandSpec } from './specs'

export type ParsedArgs = { commandPath: string[]; flags: Map<string, string | boolean> }

/** 잘못 친 명령·플래그 — 제안(nextSteps)을 함께 싣는다. */
export class CliUsageError extends Error {
  constructor(
    readonly code: 'unknown_command' | 'unknown_flag' | 'invalid_argument',
    message: string,
    readonly nextSteps: string[] = []
  ) {
    super(message)
  }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const commandPath: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }
    const body = token.slice(2)
    // --flag=value 는 -- 로 시작하는 값도 받는다(Orca).
    const eq = body.indexOf('=')
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (BOOLEAN_FLAGS.has(body) || next === undefined || next.startsWith('--')) {
      flags.set(body, true)
      continue
    }
    flags.set(body, next)
    i += 1
  }
  return { commandPath, flags }
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])

export function findCommandSpec(specs: readonly CommandSpec[], path: readonly string[]): CommandSpec | undefined {
  return specs.find((s) => specPaths(s).some((p) => same(p, path)))
}

export function isCommandGroup(specs: readonly CommandSpec[], path: readonly string[]): boolean {
  return path.length > 0 && specs.some((s) => !s.hidden && specPaths(s).some((p) => p.length > path.length && same(p.slice(0, path.length), path)))
}

/** help 를 보일 자리 — `ara help worktree` · `ara worktree --help`. null 이면 명령 실행. */
export function resolveHelpPath(parsed: ParsedArgs): string[] | null {
  if (parsed.commandPath[0] === 'help') return parsed.commandPath.slice(1)
  if (parsed.flags.has('help')) return parsed.commandPath
  return null
}

export function validateCommandAndFlags(specs: CommandSpec[], parsed: ParsedArgs): CommandSpec {
  const spec = findCommandSpec(specs, parsed.commandPath)
  if (!spec) {
    const data = unknownCommandData(specs, parsed.commandPath)
    throw new CliUsageError('unknown_command', `모르는 명령: ara ${parsed.commandPath.join(' ')}`, [...data.nextSteps, 'ara --help'])
  }
  const allowed = [...GLOBAL_FLAGS, ...spec.allowedFlags]
  for (const flag of parsed.flags.keys()) {
    if (!allowed.includes(flag)) {
      const data = unknownFlagData(flag, allowed)
      throw new CliUsageError('unknown_flag', `ara ${spec.path.join(' ')} 은(는) --${flag} 를 받지 않습니다.`, data.nextSteps)
    }
  }
  for (const [flag, v] of parsed.flags) {
    if (v === true && !BOOLEAN_FLAGS.has(flag)) throw new CliUsageError('invalid_argument', `--${flag} 에 값이 없습니다.`, [spec.usage])
  }
  return spec
}

/** --base-branch → baseBranch(아라 요청 칸 이름). */
export const camel = (flag: string): string => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
