import { expect, test } from 'vitest'
import { reasoningLevels, selectedReasoning } from '../src/reasoning-settings'

test('모델이 지원하는 추론 수준만 선택할 수 있다', () => {
  expect(reasoningLevels('openai/gpt-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(reasoningLevels('openai/gpt-4.1')).toEqual([])
  expect(reasoningLevels('google/gemini-3-flash')).toEqual(['low', 'medium', 'high'])
  expect(reasoningLevels('google/gemini-3-pro-preview')).toEqual(['low', 'high'])
})

test('기존 쿠키와 모델 전환 시 지원하지 않는 값을 유효한 수준으로 변환한다', () => {
  const levels = reasoningLevels('openai/gpt-5')
  expect(selectedReasoning(true, levels)).toBe('medium')
  expect(selectedReasoning(false, levels)).toBe('low')
  expect(selectedReasoning('high', levels)).toBe('high')
  expect(selectedReasoning('invalid', levels)).toBe('medium')
  expect(selectedReasoning('medium', ['low', 'high'])).toBe('high')
})
