import { EventType, type RunAgentInput } from '@keundal/core'
import { LLMService, type LLMRequest, type LLMEvent } from '@keundal/llm'
import { retrieveMemories } from '@keundal/memory/retrieval'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStore from '@keundal/plugin-store-memory'
import { Context } from 'cordis'
import { expect, test } from 'vitest'

test('새 대화는 의미가 같은 프로젝트 기억을 출처와 함께 받고 다른 범위와 삭제한 기억은 받지 않는다', async () => {
  const ctx = new Context()
  const searched: string[] = []
  const generated: LLMRequest[] = []
  let selection: string[] = []
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 32000, maxOutputTokens: 4096 }
    }
    async countTokens(request: LLMRequest) {
      return JSON.stringify(request.input).length
    }
    async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
      const search = request.input.messages[0]?.id === 'memory-search-instructions'
      if (search) searched.push(JSON.stringify(request.input.messages))
      else generated.push(structuredClone(request))
      const messageId = `answer-${request.input.runId}`
      yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: search ? JSON.stringify(selection) : 'Use the stored stack.'
      }
      yield { type: EventType.TEXT_MESSAGE_END, messageId }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStore)
  const agent = await ctx.plugin(agentPlugin, { model: 'test', maxOutputTokens: 512 })
  try {
    const relevant = await ctx.memory.create('keundal', {
      title: 'Architecture decision',
      content: 'The application uses Vue and Nuxt.',
      sources: [{ label: 'Architecture decision', uri: 'keundal://threads/earlier-chat/runs/decision' }]
    })
    const other = await ctx.memory.create('private-project', {
      title: 'private',
      content: 'Secret React application',
      sources: [{ uri: 'file:///private' }]
    })
    await ctx.scopedMemory.save({
      scope: { type: 'conversation', id: 'earlier-chat' },
      title: 'private',
      content: 'Confidential conversation details',
      sources: [{ uri: 'keundal://threads/earlier-chat' }]
    })
    selection = [relevant.id, other.id, relevant.id, 'invented-id']
    const request: RunAgentInput = {
      threadId: 'new-chat',
      runId: 'first',
      state: {},
      tools: [],
      context: [],
      forwardedProps: { memoryProjectId: 'keundal' },
      messages: [{ id: 'question', role: 'user', content: 'Which frontend framework should I use here?' }]
    }
    expect(await ctx.scopedMemory.search({ text: 'frontend framework', projectId: 'keundal' })).toEqual([])
    await Array.fromAsync(ctx.agent.run(request))
    expect(searched[0]).toContain(relevant.content)
    expect(searched[0]).not.toContain('Secret React')
    expect(searched[0]).not.toContain('Confidential')
    const context = JSON.stringify(generated[0]?.input.messages)
    expect(context).toContain(relevant.content)
    expect(context).toContain('Architecture decision')
    expect(context).toContain('earlier-chat')
    expect(context).not.toContain(other.id)
    await ctx.memory.delete('keundal', relevant.id, relevant.revision)
    await Array.fromAsync(ctx.agent.run({ ...request, runId: 'second' }))
    expect(JSON.stringify(generated[1]?.input.messages)).not.toContain(relevant.content)
    expect(searched).toHaveLength(1)
  } finally {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  }
})

test('의미 검색의 잘못된 JSON은 키워드 결과를 보존하고 취소는 모델 호출 전에 전달한다', async () => {
  const ctx = new Context()
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 32000, maxOutputTokens: 100 }
    }
    async countTokens() {
      return 50
    }
    async *stream(): AsyncGenerator<LLMEvent> {
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'result', delta: 'not JSON' }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStore)
  try {
    const saved = await ctx.scopedMemory.save({
      scope: { type: 'user' },
      title: 'User preference',
      content: 'Prefer TypeScript',
      sources: [{ label: 'User preference', uri: 'keundal://threads/preferences' }]
    })
    expect(await retrieveMemories(ctx.scopedMemory, ctx.llm, { text: 'TypeScript' }, 'test')).toEqual([saved])
    await expect(
      retrieveMemories(ctx.scopedMemory, ctx.llm, { text: 'TypeScript' }, 'test', { signal: AbortSignal.abort() })
    ).rejects.toThrow()
  } finally {
    await store.dispose()
    await llm.dispose()
  }
})
