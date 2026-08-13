// F17 AI 부트스트랩 GUI — 폼 값을 아라에게 보낼 구조화된 질문으로 조립하는 순수 함수.
// 여기엔 전송이 없다(단위 테스트 대상). 전송·표시는 AiPanel/AraSession(F16)을 그대로 재사용한다 —
// 새 AI 스택을 만들지 않는다.

import { maskSecrets } from '../../shared/maskSecrets'

export type BootstrapKind = 'web' | 'cli' | 'script'
export type BootstrapTarget = 'local' | 'ssh'

export type BootstrapForm = {
  kind: BootstrapKind
  runtime: string
  target: BootstrapTarget
  name: string
  path: string
}

// 자유 입력 필드 하나의 길이 상한 — F16 AI_CONTEXT_LINES 와 같은 판단(설계 §3.5): 사용자 입력에
// 상한이 없으면 붙여넣기 실수 등으로 매우 긴 문자열이 그대로 API 로 나간다.
export const BOOTSTRAP_FIELD_MAX = 200

const KIND_LABEL: Record<BootstrapKind, string> = { web: '웹 프로젝트', cli: 'CLI 도구', script: '스크립트' }
const TARGET_LABEL: Record<BootstrapTarget, string> = { local: '로컬 PC', ssh: '현재 접속한 SSH 서버' }

// 자유 입력 필드를 프롬프트에 싣기 전 처리: 길이 상한 + 마스킹(붙여넣은 경로·이름에 비밀이 섞여도
// 방어). main 의 buildRequest 가 다시 마스킹하므로(멱등) 이중 방어다(설계 §3.3과 같은 판단).
function clean(field: string): string {
  return maskSecrets(field.trim().slice(0, BOOTSTRAP_FIELD_MAX))
}

// F17 폼 값 → 아라에게 보낼 구조화된 질문 한 통. 경로가 비면 그 줄은 아예 싣지 않는다.
export function buildBootstrapPrompt(form: BootstrapForm): string {
  const lines = [
    '새 프로젝트를 시작하려고 합니다. 아래 조건에 맞는 시작 명령을 순서대로, 각 단계를 별도의 셸 코드블록으로 알려주세요.',
    '',
    `- 종류: ${KIND_LABEL[form.kind]}`,
    `- 언어/런타임: ${clean(form.runtime) || '미지정'}`,
    `- 대상 환경: ${TARGET_LABEL[form.target]}`,
    `- 프로젝트 이름: ${clean(form.name) || '미지정'}`
  ]
  const path = clean(form.path)
  if (path) lines.push(`- 경로: ${path}`)
  return lines.join('\n')
}
