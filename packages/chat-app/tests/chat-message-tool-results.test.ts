import { EventType, type AGUIEvent } from '@keundal/core'
import { expect, test } from 'vitest'
import { ChatMessageAssembly } from '@keundal/chat/chat-message'

type ToolResult = Extract<AGUIEvent, { type: typeof EventType.TOOL_CALL_RESULT }>

function projectResult(name: string, content: ToolResult['content']) {
  const assembly = new ChatMessageAssembly('run-1')
  assembly.apply({ type: EventType.TOOL_CALL_START, toolCallId: 'call-1', toolCallName: name })
  assembly.apply({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'call-1', delta: '{}' })
  assembly.apply({ type: EventType.TOOL_CALL_END, toolCallId: 'call-1' })
  assembly.apply({ type: EventType.TOOL_CALL_RESULT, toolCallId: 'call-1', messageId: 'result-1', content })
  assembly.apply({ type: EventType.TEXT_MESSAGE_START, messageId: 'answer-1', role: 'assistant' })
  assembly.apply({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer-1', delta: 'Done' })
  assembly.apply({ type: EventType.TEXT_MESSAGE_END, messageId: 'answer-1' })
  assembly.finish('openai/test-model')
  return assembly.message
}

test.each(['Found 3 files', '', '{incomplete'])('JSON이 아닌 도구 결과 %j를 원문으로 보존하고 후속 응답을 조립한다', (content) => {
  const message = projectResult('search_files', content)

  expect(message.parts).toContainEqual({ type: 'tool-search_files', toolCallId: 'call-1', state: 'output-available', input: {}, output: content })
  expect(message.parts).toContainEqual({ type: 'text', text: 'Done' })
  expect(message.parts).toContainEqual(expect.objectContaining({
    type: 'data-keundal',
    data: expect.objectContaining({ messages: expect.arrayContaining([{ id: 'result-1', role: 'tool', toolCallId: 'call-1', content }]) })
  }))
})

test.each<{ content: ToolResult['content'] }>([
  { content: [] },
  { content: [{ type: 'text', text: 'Found an image', metadata: { source: 'files' } }, { type: 'image', source: { type: 'url', value: 'https://example.com/image.png', mimeType: 'image/png' } }] }
])('도구 결과의 콘텐츠 배열을 변환하지 않고 보존한다: $content', ({ content }) => {
  const message = projectResult('search_files', content)

  expect(message.parts).toContainEqual({ type: 'tool-search_files', toolCallId: 'call-1', state: 'output-available', input: {}, output: content })
  expect(message.parts).toContainEqual(expect.objectContaining({
    type: 'data-keundal',
    data: expect.objectContaining({ messages: expect.arrayContaining([{ id: 'result-1', role: 'tool', toolCallId: 'call-1', content }]) })
  }))
})

test.each([
  { name: 'chart', output: { title: 'Files', data: [{ name: 'TypeScript', count: 3 }], xKey: 'name', series: [{ key: 'count', name: 'Files', color: '#123456' }] } },
  { name: 'weather', output: { location: 'Seoul', temperature: 20, dailyForecast: [] } }
])('$name 도구의 JSON 결과를 기존 표시용 객체로 변환한다', ({ name, output }) => {
  const content = JSON.stringify(output)
  const message = projectResult(name, content)

  expect(message.parts).toContainEqual({ type: `tool-${name}`, toolCallId: 'call-1', state: 'output-available', input: {}, output })
  expect(message.parts).toContainEqual(expect.objectContaining({
    type: 'data-keundal',
    data: expect.objectContaining({ messages: expect.arrayContaining([{ id: 'result-1', role: 'tool', toolCallId: 'call-1', content }]) })
  }))
})

test('skill 도구의 결과가 JSON이어도 원문을 보존한다', () => {
  const content = '{"instructions":"Follow the skill"}'
  const message = projectResult('skill', content)

  expect(message.parts).toContainEqual({ type: 'tool-skill', toolCallId: 'call-1', state: 'output-available', input: {}, output: content })
})
