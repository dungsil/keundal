import type { ExecutableTool } from '@keundal/tools'
import { z } from 'zod'

export const metadata = {
  name: { en: 'TODO', ko: 'TODO' },
  description: {
    en: 'Tracks the agent’s task list and progress in conversations.',
    ko: '대화에서 에이전트의 작업 목록과 진행 상태를 기록합니다.'
  }
}

const todoSchema = z.strictObject({
  todos: z.array(
    z.strictObject({
      id: z.string().trim().min(1),
      content: z.string().trim().min(1),
      status: z.enum(['pending', 'in_progress', 'completed'])
    })
  )
})

export function createTodoTools(): ExecutableTool[] {
  return [
    {
      name: 'todo_write',
      description:
        'Create or replace the task list for a multi-step request. Send the complete list on every update, keeping stable IDs and completed items. Use pending, in_progress, or completed; at most one task may be in_progress. Send an empty list to clear it. The latest successful tool result in this conversation is the current list; there is no separate task store. Update progress as you work, and do not use this for simple one-step requests.',
      parameters: z.toJSONSchema(todoSchema),
      execute: (args, context) => {
        context.signal.throwIfAborted()
        const result = todoSchema.parse(args)
        if (new Set(result.todos.map((todo) => todo.id)).size !== result.todos.length)
          throw new TypeError('TODO IDs must be unique')
        if (result.todos.filter((todo) => todo.status === 'in_progress').length > 1)
          throw new TypeError('Only one TODO may be in_progress')
        return JSON.stringify(result)
      }
    }
  ]
}

export default createTodoTools
