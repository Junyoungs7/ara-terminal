/**
 * 컴포지션 등록 — 광고 1편 + 챕터 6편.
 *
 * 길이를 코드에 적지 않는다: 나레이션 음성의 실제 길이(src/durations.json)를 더해서 정한다.
 * 대본을 고치고 `npm run tts && npm run measure` 만 다시 돌리면 영상 길이가 알아서 맞는다.
 */
import React from 'react'
import { AbsoluteFill, Audio, Composition, Sequence, staticFile } from 'remotion'
import narration from '../narration.json'
import durations from './durations.json'
import { C, FPS, H, W } from './theme'
import { Caption, Stage, TitleCard } from './ui'
import { SCENES, TEXT_ONLY, fallbackScene } from './scenes'

type Scene = { id: string; text: string }
type Chapter = { title: string; scenes: Scene[] }

const D: Record<string, number> = durations
const TITLE_FRAMES = 66 // 타이틀 카드 2.2초 — 말이 시작되기 전에 어디인지 알려 주는 시간
const dur = (id: string): number => D[id] ?? 90

/** 챕터 한 편: 타이틀 카드 → 씬들(음성 + 화면 + 자막). */
const Film: React.FC<{ chapter: Chapter; withTitle: boolean }> = ({ chapter, withTitle }) => {
  // 씬 시작 프레임을 **미리** 계산한다. 예전엔 JSX 안에서 `{withTitle && (at = TITLE_FRAMES)}` 로
  // 값을 옮겼는데, 그 식의 결과(66)가 화면 왼쪽 위에 글자로 찍혔다 — JSX 는 표현식의 값을 그린다.
  let cursor = withTitle ? TITLE_FRAMES : 0
  const starts = chapter.scenes.map((s) => {
    const from = cursor
    cursor += dur(s.id)
    return from
  })
  return (
    <Stage>
      {withTitle && (
        <Sequence durationInFrames={TITLE_FRAMES}>
          <TitleCard title={chapter.title} sub="A.R.A 사용 설명" />
        </Sequence>
      )}
      {chapter.scenes.map((s, i) => {
        const from = starts[i]
        return (
          <Sequence key={s.id} from={from} durationInFrames={dur(s.id)}>
            <Audio src={staticFile(`vo/${s.id}.wav`)} />
            <AbsoluteFill>{SCENES[s.id] ?? fallbackScene}</AbsoluteFill>
            {!TEXT_ONLY.has(s.id) && <Caption>{s.text}</Caption>}
          </Sequence>
        )
      })}
    </Stage>
  )
}

const total = (c: Chapter, withTitle: boolean): number =>
  (withTitle ? TITLE_FRAMES : 0) + c.scenes.reduce((n, s) => n + dur(s.id), 0)

const CHAPTERS: [string, Chapter][] = (
  ['install', 'connect', 'files', 'tools', 'ai', 'windows'] as const
).map((k) => [k, (narration as unknown as Record<string, Chapter>)[k]])

export const RemotionRoot: React.FC = () => {
  const ad = (narration as unknown as Record<string, Chapter>).ad
  return (
    <>
      <Composition
        id="ad"
        component={Film}
        durationInFrames={total(ad, false) + 30}
        fps={FPS}
        width={W}
        height={H}
        defaultProps={{ chapter: ad, withTitle: false }}
      />
      {CHAPTERS.map(([key, c]) => (
        <Composition
          key={key}
          id={key}
          component={Film}
          durationInFrames={total(c, true) + 24}
          fps={FPS}
          width={W}
          height={H}
          defaultProps={{ chapter: c, withTitle: true }}
        />
      ))}
    </>
  )
}

/** 렌더 대상 목록 — render.mjs 가 읽는다. */
export const IDS = ['ad', ...CHAPTERS.map(([k]) => k)]
export const BRAND = C.accent
