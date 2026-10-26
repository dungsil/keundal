import { type AgentMessage } from '@keundal/core'
import { assemblePrompt, parsePromptPreset, type PromptPreset } from '@keundal/prompt'
import { expect, test } from 'vitest'

const preset: PromptPreset = {
  id: 'review',
  name: 'Review',
  variables: { language: 'Korean', literal: '{{language}} $&' },
  blocks: [
    {
      id: 'before',
      type: 'text',
      name: 'Before',
      role: 'user',
      enabled: true,
      content: 'Use {{ language }}; {{literal}}'
    },
    { id: 'history', type: 'history', name: 'History', enabled: true },
    { id: 'after', type: 'text', name: 'After', role: 'assistant', enabled: true, content: 'Review carefully.' },
    { id: 'off', type: 'text', name: 'Off', role: 'system', enabled: false, content: '{{missing}}' }
  ]
}

test('기본 지침을 보존하고 역할과 순서에 따라 기록과 변수를 한 번만 조립한다', () => {
  const messages: AgentMessage[] = [
    { id: 'base', role: 'system', content: 'Base instructions' },
    { id: 'question', role: 'user', content: [{ type: 'text', text: 'Inspect' }] },
    {
      id: 'call',
      role: 'assistant',
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{}' } }]
    },
    { id: 'result', role: 'tool', toolCallId: 'call-1', content: 'Result' }
  ]
  const original = structuredClone({ messages, preset })
  expect(assemblePrompt(messages, preset)).toEqual([
    messages[0],
    { id: 'keundal:prompt:before', role: 'user', content: 'Use Korean; {{language}} $&' },
    ...messages.slice(1),
    { id: 'keundal:prompt:after', role: 'assistant', content: 'Review carefully.' }
  ])
  expect({ messages, preset }).toEqual(original)
  expect(() => assemblePrompt([], { ...preset, variables: {} })).toThrow('Unknown prompt variable: language')
})

test('문자열 조건은 정확히 비교하고 숫자 조건은 경계와 유효한 숫자를 구분한다', () => {
  const cases = [
    ['eq', '02', '2', false],
    ['ne', '02', '2', true],
    ['gt', '10', '2', true],
    ['gt', '2', '2', false],
    ['gte', '2', '2', true],
    ['lt', '-3', '-2', true],
    ['lt', '2', '2', false],
    ['lte', '2', '2', true],
    ['gte', '', '0', false],
    ['lt', 'abc', '2', false],
    ['gt', 'Infinity', '2', false]
  ] as const
  for (const [operator, actual, value, included] of cases) {
    const conditional: PromptPreset = {
      ...preset,
      variables: { score: actual },
      blocks: [
        { id: 'history', name: 'History', type: 'history', enabled: true },
        {
          id: 'condition',
          name: 'Condition',
          type: 'text',
          role: 'system',
          enabled: true,
          content: 'Included',
          condition: { variable: 'score', operator, value }
        }
      ]
    }
    expect(assemblePrompt([], conditional), `${operator}: ${actual}, ${value}`).toHaveLength(included ? 1 : 0)
  }
})

test('기록 누락과 중복 및 비활성 기록을 거부해 도구 대화의 무결성을 유지한다', () => {
  const history = preset.blocks[1]!
  for (const blocks of [[], [history, { ...history, id: 'other' }], [{ ...history, enabled: false }]]) {
    expect(() => parsePromptPreset({ ...preset, blocks })).toThrow()
  }
  expect(() => parsePromptPreset({ ...preset, blocks: [history, history] })).toThrow()
  expect(() => parsePromptPreset({ ...preset, variables: { 'invalid-key': 'value' } })).toThrow()
})
