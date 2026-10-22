import type { SteerQueue } from './steer.js'

export interface ExecutionOptions {
  readonly signal?: AbortSignal
  /**
   * 에이전트 실행에만 적용합니다. 실행 중인 모델 요청과 이미 시작한 도구 실행은 중단하지 않고,
   * 다음 모델 요청을 만들기 전의 안전한 경계에서 지시를 반영합니다.
   */
  readonly steer?: SteerQueue
}
