import { Context, Service } from 'cordis'
import { SlotService } from '@keundal/ui-slots'
import { expect, test } from 'vitest'
import * as media from '../../ui-media/app/plugin'

test('미디어 UI 등록은 서버에서 플랫폼을 읽지 않고 해제할 때 모든 항목을 정리한다', async () => {
  const ctx = new Context()
  let reads = 0
  class ServerRuntime extends Service {
    constructor(scope: Context) { super(scope, 'chatRuntime') }
    get platform(): never {
      reads++
      throw new Error('The server has no platform')
    }
  }
  const slots = await ctx.plugin(SlotService)
  const runtime = await ctx.plugin(ServerRuntime)
  ctx.slots.register({ name: 'root', children: {
    'page.library': 'single', 'settings.section': 'keyed', 'layout.sidebar': 'list'
  } }, {})
  const feature = await ctx.plugin(media)
  try {
    expect(reads).toBe(0)
    expect(ctx.slots.describe('page.library')).toHaveLength(1)
    expect(ctx.slots.describe('settings.section').map(entry => entry.key)).toEqual(['media'])
    expect(ctx.slots.describe('layout.sidebar').map(entry => entry.id)).toEqual(['library'])
    await feature.dispose()
    for (const slot of ['page.library', 'settings.section', 'layout.sidebar'] as const) {
      expect(ctx.slots.describe(slot)).toEqual([])
    }
    expect(reads).toBe(0)
  } finally {
    await feature.dispose()
    await runtime.dispose()
    await slots.dispose()
  }
})
