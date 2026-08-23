/**
 * 렌더 설정.
 * `concurrency` 를 절반으로 묶는다 — 렌더가 이 PC 의 CPU 를 다 잡아먹으면 준영님이 쓰던 일이 멈춘다.
 * (도구가 사용자 PC 를 침범하지 않는다는 규칙은 렌더에도 적용된다.)
 */
import { Config } from '@remotion/cli/config'
import os from 'node:os'

Config.setVideoImageFormat('jpeg')
Config.setConcurrency(Math.max(2, Math.floor(os.cpus().length / 2)))
Config.setChromiumOpenGlRenderer('angle')
