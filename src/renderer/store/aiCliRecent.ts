// F27 AI CLI 최근 목록 — workProfiles 와 같은 결(스냅샷에서 1회 하이드레이트 + 바뀔 때마다 즉시 영속).
//
// 작업 프로필과 결정적으로 다른 점 하나: **저장이 전제가 아니다.** 사용자는 아무것도 저장해 두지
// 않은 상태에서 창을 열어 바로 시작할 수 있고, 이 목록은 시작한 뒤에 저절로 쌓인다. 그래서 여기에는
// 이름 붙이기·수정·삭제가 없다 — 목록을 관리하는 화면이 생기면 그 순간 "먼저 저장부터"가 된다.
//
// 중복 제거·상한은 순수 함수(shared/aiCli.pushRecent)가 하고 이 훅은 배선만 한다.
import { useCallback, useEffect, useState } from 'react'
import { pushRecent, type AiCliRecent } from '../../shared/aiCli'

export function useAiCliRecent() {
  const [list, setList] = useState<AiCliRecent[]>([])

  useEffect(() => {
    void window.ev?.workspace
      .load()
      .then((snap) => setList(snap.ui.aiCliRecent ?? []))
      .catch(() => {})
  }, [])

  // 시작에 성공했을 때만 부른다 — 실패한 조합이 목록 맨 위에 앉아 다음 실행을 오염시키면 안 된다.
  const record = useCallback((entry: AiCliRecent) => {
    setList((cur) => {
      const next = pushRecent(cur, entry)
      void window.ev?.ui.setAiCliRecent(next).catch(() => {})
      return next
    })
  }, [])

  return { list, record }
}
