import {
  RequestContextService,
  SessionReferenceService,
  decodeSessionReferenceUri,
  encodeSessionReferenceUri
} from '@keundal/context'
import type { RunAgentInput } from '@keundal/core'
import { Context } from 'cordis'
import { expect, test } from 'vitest'

test('서비스 계약의 대체 구현을 같은 Cordis 이름으로 등록한다', async () => {
  class CustomContext extends RequestContextService {
    async prepare(input: RunAgentInput) {
      return input
    }
  }
  class CustomReferences extends SessionReferenceService {
    async listCandidates() {
      return []
    }
    async prepare(input: RunAgentInput) {
      return input
    }
  }
  const ctx = new Context()
  const [context, references] = await Promise.all([ctx.plugin(CustomContext), ctx.plugin(CustomReferences)])
  expect(ctx.requestContext).toBeInstanceOf(CustomContext)
  expect(ctx.sessionReferenceResolver).toBeInstanceOf(CustomReferences)
  await Promise.all([context.dispose(), references.dispose()])
})

test('세션 URI는 유니코드와 단독 surrogate를 기존 UTF-8 base64url 형식으로 보존한다', () => {
  for (const id of ['', '세션😀', '\ud800', '\udfff', 'a'.repeat(100_000)]) {
    const uri = encodeSessionReferenceUri(id)
    expect(uri).toBe(`keundal-session:${Buffer.from(JSON.stringify(id), 'utf8').toString('base64url')}`)
    expect(decodeSessionReferenceUri(uri)).toBe(id)
  }
})
