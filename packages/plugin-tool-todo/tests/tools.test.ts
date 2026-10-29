import { createTodoTools } from '@keundal/plugin-tool-todo'
import { expect, test } from 'vitest'

const context = { threadId: 'thread', runId: 'run', toolCallId: 'call', signal: new AbortController().signal }

test('TODO 도구는 전체 작업 목록과 상태 변경·삭제·초기화를 독립된 결과로 반환한다', async () => {
  const tool = createTodoTools()[0]!
  expect(tool.name).toBe('todo_write')
  const todos = [
    { id: 'inspect', content: '코드 확인', status: 'completed' },
    { id: 'implement', content: '도구 구현', status: 'in_progress' },
    { id: 'verify', content: '결과 검증', status: 'pending' }
  ]
  const first = await tool.execute({ todos }, context)
  expect(JSON.parse(first)).toEqual({ todos })
  const updated = [todos[0], { ...todos[2], status: 'in_progress' }]
  expect(JSON.parse(await tool.execute({ todos: updated }, context))).toEqual({ todos: updated })
  expect(JSON.parse(await tool.execute({ todos: [] }, context))).toEqual({ todos: [] })
  expect(JSON.parse(first)).toEqual({ todos })
})

test('TODO 도구는 잘못된 항목·중복 ID·동시 진행과 취소된 실행을 거부한다', async () => {
  const tool = createTodoTools()[0]!
  const todo = { id: 'one', content: '구현', status: 'pending' }
  for (const args of [
    {},
    { todos: 'invalid' },
    { todos: [], extra: true },
    { todos: [{ ...todo, id: ' ' }] },
    { todos: [{ ...todo, content: '' }] },
    { todos: [{ ...todo, status: 'done' }] },
    { todos: [{ ...todo, extra: true }] },
    { todos: [todo, { ...todo, id: ' one ' }] },
    {
      todos: [
        { ...todo, status: 'in_progress' },
        { ...todo, id: 'two', status: 'in_progress' }
      ]
    }
  ])
    await expect(async () => tool.execute(args, context)).rejects.toThrow()
  await expect(async () =>
    tool.execute({ todos: [todo] }, { ...context, signal: AbortSignal.abort() })
  ).rejects.toThrow()
})
