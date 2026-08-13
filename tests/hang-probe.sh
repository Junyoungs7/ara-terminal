#!/usr/bin/env bash
# #64 — "앱이 안 내려간다" 빈도 측정 + 어디서 멈추는지 기록. 2026-08-13.
#
# 재는 것 셋:
#   ① preview.spec 회차별 성공/실패
#   ② 실패했을 때 main 이 종료 단계 어디까지 갔는지(ARA_EXIT_TRACE)
#   ③ 회차가 끝난 뒤 electron 프로세스가 남아 있는지
#      — 이게 "앱이 안 죽었다"와 "Playwright 가 파이프를 기다렸다"를 가른다.
#
# 준영님 PC 를 침범하지 않는다: 창은 e2e 가 원래 띄우는 것뿐이고(자리 비우신 동안 돌린다),
# 클립보드·포커스는 건드리지 않는다.
set -u
cd /d/AI/OFA

N="${1:-15}"
OUT="$2"
mkdir -p "$OUT"
: > "$OUT/summary.txt"

for i in $(seq 1 "$N"); do
  trace="$OUT/trace-$i.txt"
  : > "$trace"
  start=$(date +%s)
  ARA_EXIT_TRACE="$trace" npx playwright test tests/e2e/preview.spec.ts > "$OUT/run-$i.log" 2>&1
  code=$?
  dur=$(( $(date +%s) - start ))

  # 남은 electron 프로세스(회차 종료 직후). tasklist 는 없으면 헤더만 낸다.
  left=$(tasklist //FI "IMAGENAME eq electron.exe" //NH 2>/dev/null | grep -c "electron.exe")
  # 남아 있으면 다음 회차를 오염시키므로 치운다.
  if [ "$left" -gt 0 ]; then taskkill //F //IM electron.exe >/dev/null 2>&1; fi

  # 종료 추적의 마지막 단계(있으면).
  last=$(tail -1 "$trace" 2>/dev/null | awk '{print $2}')
  [ -z "$last" ] && last="(추적없음)"
  # 매달림 판정: 실패했고 로그에 teardown 초과가 있으면.
  hang="no"
  grep -q "Tearing down" "$OUT/run-$i.log" 2>/dev/null && hang="yes"

  printf '%2d  exit=%d  %3ds  hang=%-3s  남은electron=%s  마지막단계=%s\n' \
    "$i" "$code" "$dur" "$hang" "$left" "$last" | tee -a "$OUT/summary.txt"
done

echo "" | tee -a "$OUT/summary.txt"
echo "=== 집계 ===" | tee -a "$OUT/summary.txt"
echo "총 $N 회 · 매달림 $(grep -c 'hang=yes' "$OUT/summary.txt") 회" | tee -a "$OUT/summary.txt"
echo "--- 마지막 단계 분포" | tee -a "$OUT/summary.txt"
awk '{for(i=1;i<=NF;i++) if($i ~ /^마지막단계=/) print $i}' "$OUT/summary.txt" | sort | uniq -c | tee -a "$OUT/summary.txt"
