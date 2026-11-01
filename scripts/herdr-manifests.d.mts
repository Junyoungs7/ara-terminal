/** herdr 매니페스트 TOML(쓰는 문법만) → 객체. 모르는 문법이면 던진다. */
export function parseManifestToml(text: string): Record<string, unknown>
