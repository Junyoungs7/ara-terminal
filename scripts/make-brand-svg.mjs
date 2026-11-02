// 브랜드 마크 배포기 — ARA 별 마크 v3 (2026-11-02 준영님 확정 보드).
//
// **마크의 원본은 이 저장소 밖이다**: D:\AI\OFA\docs\brand\final\scripts\build_kit.py 가 보드
// (source-board.png)에 곡선을 맞춰 키트(SVG·PNG·ICO·ICNS)를 굽는다. 이 저장소에는 키트에서 고른 파일을
// 그대로 들여 둔다(assets/brand/ 와 resources/icons/ 의 PNG·ICO). 이 스크립트는 그 두 SVG 를 앱 안 자리로 퍼뜨린다:
//
//   assets/brand/ara-icon.svg     (키트 ara-color-dark.svg — 그라데이션, 바탕 모를 때 쓰는 밝은 변형)
//   assets/brand/ara-favicon.svg  (키트 ara-flat.svg — 48px 이하 평면 2톤, 접힘 유지)
//     → resources/icons/ara-icon.svg   같은 것(electron-builder 쪽 마스터 보관)
//     → src/renderer/components/brandMark.ts  BrandOrb(시작 화면·첫 인사)가 쓸 면 경로·그라데이션
//     → src/renderer/index.html  <link rel="icon"> href **한 줄**(파비콘 = 평면 판)
//     → site/assets/ara-icon.svg · video/public/logo.svg (그 폴더가 있을 때만 — 평면 판)
//
// 설치본 아이콘(resources/icons/ara-icon.ico · ara-icon.png)은 **키트에서 복사**한다 — 16~48px 은
// 픽셀 정렬한 평면 판이 크기마다 따로 들어 있다(kit\ara\ara.ico → ara-icon.ico, kit\ara\png\ara-macos-1024.png →
// ara-icon.png). 옛 Electron 래스터 스크립트(icons:png·icons:ico)는 정리 1 에서 지웠다 — 돌리면 맥 PNG 의 검은 판과
// 작은 크기 정렬이 빠졌다. 마크가 바뀌면 키트를 다시 굽고(build_kit.py) 그 두 파일을 복사한 뒤 이것을 돌린다.
//
// **왜 index.html 까지 여기서 쓰나.** 2026-08-27 리브랜드 때 index.html 만 생성기 밖에 있어서
// 걷어낸 마크가 파비콘으로 혼자 살아남았다(AUDIT-R4 ①). 마크는 한 곳에서 나와야 한다.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const write = (rel, body) => {
  writeFileSync(join(ROOT, rel), body, "utf8");
  console.log(`  ${rel}  ${(Buffer.byteLength(body) / 1024).toFixed(1)}KB`);
};

const full = read("assets/brand/ara-icon.svg");
const flat = read("assets/brand/ara-favicon.svg");

/** 키트 SVG → 면 a·b 경로와 그라데이션(축·정지점). 못 읽으면 죽는다 — 조용히 옛 마크를 남기지 않게. */
function parseMark(svg) {
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  const grads = [
    ...svg.matchAll(
      /<linearGradient[^>]*x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)">(.*?)<\/linearGradient>/g,
    ),
  ].map((m) => ({
    x1: +m[1],
    y1: +m[2],
    x2: +m[3],
    y2: +m[4],
    stops: [
      ...m[5].matchAll(/offset="([\d.]+)" stop-color="(#[0-9A-Fa-f]{6})"/g),
    ].map((s) => [+s[1], s[2]]),
  }));
  if (paths.length !== 2 || grads.length !== 2)
    throw new Error(
      "assets/brand/ara-icon.svg: 면 2개·그라데이션 2개를 못 찾았다",
    );
  return { paths, grads };
}

function dataUri(svg) {
  const body = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/"/g, "'")
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/&/g, "%26")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
  return `data:image/svg+xml,${body}`;
}

function patchFavicon(rel, svg) {
  const src = read(rel);
  const re = /(rel="icon"[^>]*?href=")[^"]*(")/;
  if (!re.test(src))
    throw new Error(
      `${rel}: <link rel="icon"> href 를 못 찾았다 — 표시를 확인해라`,
    );
  writeFileSync(
    join(ROOT, rel),
    src.replace(re, (_m, a, b) => a + dataUri(svg) + b),
    "utf8",
  );
  console.log(`  ${rel}  파비콘 href 갱신`);
}

const { paths, grads } = parseMark(full);
const markTs = `// **생성물이다 — 손으로 고치지 말 것**(scripts/make-brand-svg.mjs ← assets/brand/ara-icon.svg).
// ARA 별 마크: 접힌 두 면(a = 위·꼬리, b = 아래 갈래) + 면마다 선형 그라데이션. viewBox 0 0 1024 1024.
export const MARK_VIEWBOX = '0 0 1024 1024'
export const MARK_FACES = ${JSON.stringify(paths, null, 2)} as const
export const MARK_GRADS = [
${grads.map((g) => "  " + JSON.stringify(g)).join(",\n")}
] as const
`;

console.log("브랜드 마크 배포:");
write("resources/icons/ara-icon.svg", full);
write("src/renderer/components/brandMark.ts", markTs);
patchFavicon("src/renderer/index.html", flat);
for (const rel of ["site/assets/ara-icon.svg", "video/public/logo.svg"])
  if (existsSync(dirname(join(ROOT, rel)))) write(rel, flat);
