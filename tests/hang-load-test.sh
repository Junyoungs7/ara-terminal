#!/usr/bin/env bash
# #64 — "부하가 있을 때만 매달린다" 통제 실험. 2026-08-13.
#
# 16회 자연 관측에서 6회 매달렸는데(37.5%), 매달린 회차가 전부 내가 다른 일을 돌리던 때와
# 겹쳤다. 상관인지 인과인지 가르려면 부하를 **내가 켜고 끄면서** 재야 한다.
#
# 부하: node 로 바쁜 루프 4개. 화면·클립보드·포커스는 건드리지 않는다(2026-08-11 규칙).
# 어떤 경로로 끝나든 반드시 정리한다(trap).
set -u
cd /d/AI/OFA

OUT="$1"
mkdir -p "$OUT"
: > "$OUT/load-result.txt"

PIDS=()
burn_start() {
  for _ in 1 2 3 4; do
    node -e 'const t=Date.now()+600000; while(Date.now()<t){Math.sqrt(Math.random())}' &
    PIDS+=($!)
  done
}
burn_stop() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done
  PIDS=()
}
trap 'burn_stop' EXIT INT TERM

run_once() {  # $1 = 라벨
  local label="$1" start dur code hang
  start=$(date +%s)
  npx playwright test tests/e2e/preview.spec.ts > "$OUT/lt-$label.log" 2>&1
  code=$?
  dur=$(( $(date +%s) - start ))
  hang="no"; grep -q "Tearing down" "$OUT/lt-$label.log" 2>/dev/null && hang="yes"
  printf '%-16s exit=%d  %3ds  hang=%s\n' "$label" "$code" "$dur" "$hang" | tee -a "$OUT/load-result.txt"
  taskkill //F //IM electron.exe >/dev/null 2>&1
}

# 번갈아 돌린다 — 시간에 따른 다른 요인(디스크 캐시 등)이 한쪽에만 몰리지 않게.
for i in 1 2 3; do
  burn_start
  run_once "부하있음-$i"
  burn_stop
  sleep 3
  run_once "한가함-$i"
done

echo "" | tee -a "$OUT/load-result.txt"
echo "=== 집계 ===" | tee -a "$OUT/load-result.txt"
echo "부하있음: $(grep -c '부하있음.*hang=yes' "$OUT/load-result.txt")/3 매달림" | tee -a "$OUT/load-result.txt"
echo "한가함  : $(grep -c '한가함.*hang=yes' "$OUT/load-result.txt")/3 매달림" | tee -a "$OUT/load-result.txt"
