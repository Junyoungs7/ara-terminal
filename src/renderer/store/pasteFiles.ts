// 클립보드 **파일** 붙여넣기 — 브라우저의 진짜 paste 이벤트에서 받는다.
//
// 왜 이렇게 바꿨나(2026-08-09): 지금까지는 Ctrl+V 키다운을 가로채 Electron clipboard API 로 경로를
// 읽었는데, Windows 에서 그 API 는 **파일 하나만** 준다(CF_HDROP 은 번호 형식이라 못 집고 경로 한 개짜리
// FileNameW 로 대신 읽는다 — util/clipboardFiles.ts). 그래서 여러 개를 복사해도 첫 개만 올라갔다(A-3).
//
// 실측해 보니 브라우저의 paste 이벤트는 CF_HDROP 을 **전부** 풀어 준다. 파일 2개를 복사해 확인:
//   · clipboardData.files → [one.txt, two.txt]  (Electron 이라 File.path 로 실경로까지 온다)
//   · 편집 불가 요소(우리 트리)에서는 요소가 아니라 **document** 로만 온다 → 여기서 받는다
//   · availableFormats() 는 'text/uri-list' 를 광고하지만 읽으면 비어 있다(그 길은 막혀 있다)
// PowerShell(Get-Clipboard -Format FileDropList, 실측 367ms)도 네이티브 애드온도 필요 없다.
//
// 캡처 단계에서 받는 이유: xterm 은 자기 textarea 에 paste 리스너를 달아 둔다. 버블에서 받으면
// 그쪽이 먼저 돌아 preventDefault 가 늦는다.

export type PasteTarget = {
  el: HTMLElement
  /**
   * 이 대상으로 온 붙여넣기. files 가 비어 있으면 텍스트(또는 앱 내부 클립보드) 붙여넣기다.
   * 처리했으면 true — 기본 동작(xterm 텍스트 붙여넣기 등)을 막는다.
   * 편집 불가 요소는 paste 이벤트가 요소가 아니라 document 로만 오므로(실측) 이 경로가 유일하다.
   */
  onFiles: (files: File[]) => boolean
  /**
   * 안쪽 입력칸(input/textarea)에 포커스가 있어도 이 대상이 받는가.
   * 터미널은 true — xterm 의 숨은 textarea 가 곧 터미널이다.
   * 파일 트리는 false — 이름 변경 입력칸에 붙여넣는 것은 그 칸의 몫이다.
   */
  allowEditable?: boolean
}

const targets: PasteTarget[] = []

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true
}

/**
 * 어느 대상이 이 붙여넣기를 받을지(순수 — 단위 테스트 대상).
 * 포커스가 그 대상 안에 있어야 한다. 나중에 등록된 것이 먼저다(중첩 시 안쪽이 이긴다).
 */
export function pickPasteTarget(list: readonly PasteTarget[], active: Element | null): PasteTarget | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]
    if (!t.el.contains(active) && t.el !== active) continue
    if (isEditable(active) && !t.allowEditable) continue
    return t
  }
  return null
}

function onPaste(e: ClipboardEvent): void {
  const t = pickPasteTarget(targets, document.activeElement)
  if (!t) return
  if (t.onFiles(Array.from(e.clipboardData?.files ?? []))) e.preventDefault()
}

let installed = false

export function registerPasteTarget(t: PasteTarget): () => void {
  if (!installed) {
    installed = true
    document.addEventListener('paste', onPaste, true)
  }
  targets.push(t)
  return () => {
    const i = targets.indexOf(t)
    if (i >= 0) targets.splice(i, 1)
  }
}

/** Electron 은 File 에 실경로를 실어 준다 — 업로드·복사는 경로로 돈다. 경로가 없는 항목은 버린다. */
export function filePaths(files: readonly File[]): string[] {
  return files.map((f) => (f as File & { path?: string }).path ?? '').filter((p) => p !== '')
}

// 테스트 전용 — 등록 목록을 비운다(모듈 스코프라 테스트끼리 샌다).
export function __resetPasteTargets(): void {
  targets.length = 0
}
