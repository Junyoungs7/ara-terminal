/**
 * 아라 문지기(#135) — **무엇을 그냥 통과시키고 무엇을 막을 것인가.**
 *
 * 준영님 결정(2026-08-25): ②(아라가 막는다)로 가되, 등급을 **사용자가 고른다**.
 *
 * ── 실측이 정한 모양 (2026-08-25, claude 2.1.220) ─────────────────────────────
 * ① `--disallowedTools Write Edit` 은 실제로 막고, 막힌 것이 **기계가 알아볼 모양**으로 온다:
 *    `tool_result(is_error) = "No such tool available: Write. Write is disabled for this session…"`
 * ② **그런데 모델이 셸로 우회한다.** Write 를 막았더니 `Bash` 로 `printf … > hello.txt` 를 돌려
 *    파일을 만들었다. 즉 **셸을 통과시키면 파일 차단은 차단이 아니다.**
 * ③ 도는 중에 허용을 되돌릴 수 없다. `control_request(set_permission_mode)` 는 먹지만 그것은
 *    모드일 뿐이고, `--disallowedTools` 는 프로세스에 붙박이다 → 허용하려면 `--resume` 재기동.
 *
 * ②가 이 파일의 존재 이유다: 등급을 자유 조합으로 두되, **뚫린 조합을 뚫렸다고 말한다.**
 */

/** 통과(true) = 아라가 막지 않는다. 막으면 Claude Code 쪽에서 그 도구가 사라진다. */
export type AraGate = {
  /** 파일을 고치는 도구. */
  write: boolean
  /** 셸 명령. **이걸 통과시키면 write 차단은 의미가 없다**(실측 ②). */
  exec: boolean
}

/** 아무것도 막지 않는다 = 0.1.0 까지의 행동. 기본값은 여기다(설계 §6 확정 1). */
export const GATE_ALL_PASS: AraGate = { write: true, exec: true }

/** 파일을 고치는 도구들. MultiEdit 처럼 판마다 있고 없고 하는 것도 함께 적는다(없으면 무시된다). */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

/** 셸. BashOutput·KillShell 까지 같이 막지 않으면 돌던 명령을 계속 쓸 수 있다. */
export const EXEC_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'KillBash'] as const

/** 저장값 → 등급. 신뢰 경계 밖이라 불리언이 아닌 것은 **통과**로 떨어뜨린다(기본이 통과다). */
export function gateOf(raw: unknown): AraGate {
  const o = (raw ?? {}) as Record<string, unknown>
  return { write: o['write'] !== false, exec: o['exec'] !== false }
}

/** `--disallowedTools` 에 실을 목록. 통과만 있으면 빈 배열 = 플래그 자체를 안 붙인다. */
export function disallowedTools(g: AraGate): string[] {
  return [...(g.write ? [] : WRITE_TOOLS), ...(g.exec ? [] : EXEC_TOOLS)]
}

/**
 * **뚫린 조합인가.** 셸은 통과인데 파일은 막은 판 — 모델이 `printf > file` 로 그냥 쓴다(실측 ②).
 * 막는 흉내만 내는 설정을 조용히 두면 사람이 지켜진다고 믿는다. 화면에서 그대로 말한다.
 */
export function gateLeaks(g: AraGate): boolean {
  return g.exec && !g.write
}

/** 막힌 도구 이름을 도구 결과에서 뽑는다. 아니면 null(보통 결과다). */
export function blockedToolOf(brief: string): string | null {
  const m = /No such tool available: (\w+)\. \1 is disabled/.exec(brief)
  return m ? (m[1] ?? null) : null
}

/** 그 도구가 어느 등급에 속하나 — 허용은 **등급 단위**다(Write 만 열고 Edit 를 닫아 둘 이유가 없다). */
export function classOfTool(tool: string): keyof AraGate | null {
  if ((WRITE_TOOLS as readonly string[]).includes(tool)) return 'write'
  if ((EXEC_TOOLS as readonly string[]).includes(tool)) return 'exec'
  return null
}
