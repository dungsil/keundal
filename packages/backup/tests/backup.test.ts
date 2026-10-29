import { parseHistoryBackup } from '@keundal/backup'
import { EventType, type AGUIEvent } from '@keundal/core'
import { expect, test } from 'vitest'

const fixture = () => ({
  threads: [
    {
      threadId: 'thread',
      revision: 2,
      state: { arbitrary: { enabled: true } },
      messages: [{ id: 'user', role: 'user', content: 'hello', metadata: { custom: 'retained' } }]
    }
  ],
  runs: [
    {
      request: {
        input: {
          threadId: 'thread',
          runId: 'run',
          state: { custom: 1 },
          tools: [],
          context: [],
          messages: [{ id: 'user', role: 'user', content: 'hello' }]
        },
        model: 'test',
        maxOutputTokens: 100,
        sessionRevision: 1,
        reasoning: 'medium'
      },
      status: 'completed',
      journal: [
        { sequence: 0, event: { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' } as AGUIEvent },
        { sequence: 1, event: { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run' } as AGUIEvent }
      ],
      messages: [{ id: 'reply', role: 'assistant', content: 'materialized independently' }]
    }
  ]
})

test('백업 검증은 임의의 상태와 독립적인 메시지 스냅숏을 정규화하지 않고 깊은 복사한다', () => {
  const original = fixture()
  const parsed = parseHistoryBackup(original)
  expect(parsed).toEqual({ ...original, runs: original.runs.map((run) => ({ ...run, state: { custom: 1 } })) })
  original.threads[0]!.state.arbitrary.enabled = false
  expect(parsed.threads[0]!.state).toEqual({ arbitrary: { enabled: true } })
})

test('백업은 metadata를 보존하고 입력 상태와 journal로 실행 상태를 다시 조립한다', () => {
  const data = fixture()
  const metadata = { web: { title: 'saved' } }
  data.runs[0]!.journal.splice(1, 0, {
    sequence: 1,
    event: { type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/custom', value: 2 }] }
  })
  data.runs[0]!.journal[2]!.sequence = 2
  const parsed = parseHistoryBackup({
    threads: [{ ...data.threads[0], metadata }],
    runs: [{ ...data.runs[0], state: { stale: true } }]
  })
  expect(parsed.runs[0]!.state).toEqual({ custom: 2 })
  expect(parsed.threads[0]!.metadata).toEqual(metadata)
  metadata.web.title = 'changed'
  expect(parsed.threads[0]!.metadata).toEqual({ web: { title: 'saved' } })
})

test('백업의 명시적인 null 입력 상태는 빈 객체로 바뀌지 않는다', () => {
  const data = fixture()
  const run = data.runs[0]!
  expect(
    parseHistoryBackup({
      ...data,
      runs: [
        {
          ...run,
          request: {
            ...run.request,
            input: { ...run.request.input, state: null }
          }
        }
      ]
    }).runs[0]!.state
  ).toBeNull()
})

test.each([null, [], 'invalid'])('객체가 아닌 백업 metadata는 거부한다: %j', (metadata) => {
  const data = fixture()
  expect(() => parseHistoryBackup({ ...data, threads: [{ ...data.threads[0], metadata }] })).toThrow('metadata')
})

const invalid: [string, (data: ReturnType<typeof fixture>) => void][] = [
  [
    '빈 threadId',
    (data) => {
      data.threads[0]!.threadId = ' '
    }
  ],
  [
    '음수 revision',
    (data) => {
      data.threads[0]!.revision = -1
    }
  ],
  [
    '소수 revision',
    (data) => {
      data.threads[0]!.revision = 1.5
    }
  ],
  [
    '중복 threadId',
    (data) => {
      data.threads.push(data.threads[0]!)
    }
  ],
  [
    '중복 runId',
    (data) => {
      data.runs.push(data.runs[0]!)
    }
  ],
  [
    '중복 메시지 ID',
    (data) => {
      data.threads[0]!.messages.push(data.threads[0]!.messages[0]!)
    }
  ],
  [
    '빈 메시지 ID',
    (data) => {
      data.runs[0]!.messages[0]!.id = ''
    }
  ],
  [
    '없는 스레드 참조',
    (data) => {
      data.runs[0]!.request.input.threadId = 'missing'
    }
  ],
  [
    '미래 revision 참조',
    (data) => {
      data.runs[0]!.request.sessionRevision = 3
    }
  ],
  [
    '실행 중 상태',
    (data) => {
      data.runs[0]!.status = 'running'
    }
  ],
  [
    '알 수 없는 상태',
    (data) => {
      data.runs[0]!.status = 'unknown'
    }
  ],
  [
    '잘못된 출력 한도',
    (data) => {
      data.runs[0]!.request.maxOutputTokens = 0
    }
  ],
  [
    '잘못된 reasoning',
    (data) => {
      data.runs[0]!.request.reasoning = 'unknown'
    }
  ],
  [
    '누락된 sequence',
    (data) => {
      data.runs[0]!.journal[1]!.sequence = 2
    }
  ],
  [
    '중복 sequence',
    (data) => {
      data.runs[0]!.journal[1]!.sequence = 0
    }
  ],
  [
    '다른 실행 이벤트',
    (data) => {
      data.runs[0]!.journal[0]!.event = { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'another' }
    }
  ],
  [
    '조립할 수 없는 journal',
    (data) => {
      data.runs[0]!.journal[0]!.event = { type: EventType.TOOL_CALL_ARGS, toolCallId: 'missing', delta: '{}' }
    }
  ],
  [
    '잘못된 CUSTOM 메시지',
    (data) => {
      data.runs[0]!.journal[0]!.event = { type: EventType.CUSTOM, name: 'keundal.steer.message', value: {} }
    }
  ],
  [
    'JSON이 아닌 숫자',
    (data) => {
      data.threads[0]!.revision = Number.NaN
    }
  ]
]

test.each(invalid)('%s이 포함된 백업을 거부한다', (_name, mutate) => {
  const data = fixture()
  mutate(data)
  expect(() => parseHistoryBackup(data)).toThrow()
})
