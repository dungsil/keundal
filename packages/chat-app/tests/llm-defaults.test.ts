import { defaultLLMSettings, registeredProviders } from '@keundal/llm-settings'
import { expect, test, vi } from 'vitest'

test('문자열 코드 생성이 금지된 환경에서도 등록된 공급자 없이 기본 설정을 준비한다', () => {
  const blocked = vi.spyOn(globalThis, 'Function').mockImplementation(() => {
    throw new EvalError('Code generation from strings disallowed for this context')
  })
  try {
    expect(registeredProviders(defaultLLMSettings())).toEqual([])
  } finally {
    blocked.mockRestore()
  }
})
