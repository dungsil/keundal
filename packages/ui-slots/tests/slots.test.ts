import { Context } from 'cordis'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, test } from 'vitest'

import { SlotFactory, SlotOutlet, SlotRoot, SlotService, useSlotEntries } from '../src/index'

declare module '../src/index' {
  interface SlotMap {
    'test.frame': { kind: 'single'; owner: Record<string, never> }
    'test.items': { kind: 'list'; owner: { prefix: string }; meta: { label: string } }
    'test.view': { kind: 'keyed'; owner: { value: string } }
    'test.part': { kind: 'chain'; owner: { type: string } }
    'test.factory.action': { kind: 'list'; owner: { disabled: boolean } }
  }
  interface FactoryMap {
    'test.composer': { owner: { placeholder: string } }
  }
}

const Text = defineComponent({
  props: { text: { type: String, required: true } },
  setup: props => () => h('span', props.text)
})

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SlotService)
  return ctx
}

async function render(ctx: Context) {
  return await renderToString(createSSRApp({ render: () => h(SlotRoot, { service: ctx.slots }) }))
}

describe('슬롯 레지스트리', () => {
  test('선언 전 등록은 거부하고 inject는 선언된 뒤 등록하며 선언이 사라지면 해제한다', async () => {
    const ctx = await setup()
    expect(() => ctx.slots.register({ name: 'test.items', id: 'a', meta: { label: 'A' } }, Text)).toThrow('not declared')
    const feature = ctx.plugin({
      inject: ['slots'],
      apply(child: Context) {
        child.slots.inject('test.items', () =>
          child.slots.register({ name: 'test.items', id: 'a', meta: { label: 'A' }, inject: owner => ({ text: `${owner.prefix}A` }) }, Text))
      }
    })
    await feature
    expect(ctx.slots.declared('test.items')).toBe(false)

    const Frame = defineComponent({ setup: () => () => h('main', h(SlotOutlet, { name: 'test.items', owner: { prefix: '>' } })) })
    const frame = ctx.plugin({
      inject: ['slots'],
      apply(child: Context) {
        child.slots.register({ name: 'root', children: { 'test.frame': 'single' } }, defineComponent({ setup: () => () => h(SlotOutlet, { name: 'test.frame' }) }))
        child.slots.inject('test.frame', () => child.slots.register({ name: 'test.frame', children: { 'test.items': 'list' } }, Frame))
      }
    })
    await frame
    expect(await render(ctx)).toBe('<main><!--[--><span>&gt;A</span><!--]--></main>')

    await frame.dispose()
    expect(ctx.slots.declared('test.items')).toBe(false)
    expect(ctx.slots.describe('test.items')).toEqual([])

    // Declaring again replays the contribution of the still-active feature plugin.
    const again = ctx.plugin({
      inject: ['slots'],
      apply(child: Context) {
        child.slots.register({ name: 'root', children: { 'test.items': 'list' } }, Frame)
      }
    })
    await again
    expect(await render(ctx)).toBe('<main><!--[--><span>&gt;A</span><!--]--></main>')
    await feature.dispose()
    expect(await render(ctx)).toBe('<main><!----></main>')
  })

  test('선언하지 않은 하위 슬롯을 그리면 오류이고, 실패한 항목만 비운다', async () => {
    const ctx = await setup()
    ctx.slots.register({ name: 'root', children: { 'test.items': 'list' } }, defineComponent({
      setup: () => () => h('div', [h(SlotOutlet, { name: 'test.items', owner: { prefix: '' } })])
    }))
    ctx.slots.register({ name: 'test.items', id: 'bad', meta: { label: 'bad' } }, defineComponent({
      setup: () => () => h(SlotOutlet, { name: 'test.view' })
    }))
    ctx.slots.register({ name: 'test.items', id: 'good', order: 1, meta: { label: 'good' }, inject: () => ({ text: 'ok' }) }, Text)
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args) => errors.push(args)
    try {
      expect(await render(ctx)).toBe('<div><!--[--><!----><span>ok</span><!--]--></div>')
    } finally {
      console.error = original
    }
    expect(String((errors[0] as unknown[])[1])).toContain('slot "test.view" is not declared')
  })

  test('kind별로 우선순위·키·선택 결과에 맞는 항목을 그린다', async () => {
    const ctx = await setup()
    const Entries = defineComponent({
      setup() {
        const entries = useSlotEntries('test.items')
        return () => h('nav', entries.value.map(entry => entry.meta.label).join(','))
      }
    })
    ctx.slots.register({ name: 'root', children: { 'test.items': 'list', 'test.view': 'keyed', 'test.part': 'chain' } }, defineComponent({
      setup: () => () => h('div', [
        h(Entries),
        h(SlotOutlet, { name: 'test.items', owner: { prefix: '' } }),
        h(SlotOutlet, { name: 'test.view', entryKey: 'b', owner: { value: 'v' } }),
        h(SlotOutlet, { name: 'test.view', entryKey: 'missing', owner: { value: 'v' } }, { fallback: () => 'none' }),
        h(SlotOutlet, { name: 'test.part', owner: { type: 'tool-chart' } })
      ])
    }))
    ctx.slots.register({ name: 'test.items', id: 'x', order: 2, meta: { label: 'X' }, inject: () => ({ text: 'x' }) }, Text)
    ctx.slots.register({ name: 'test.items', id: 'y', order: 1, meta: { label: 'Y' }, inject: () => ({ text: 'y' }) }, Text)
    ctx.slots.register({ name: 'test.items', id: 'x', priority: -1, order: 2, meta: { label: 'X2' }, inject: () => ({ text: 'x2' }) }, Text)
    expect(() => ctx.slots.register({ name: 'test.items', id: 'y', order: 1, meta: { label: 'Y' } }, Text)).toThrow('already has an entry')
    ctx.slots.register({ name: 'test.view', key: 'b', inject: owner => ({ text: `b:${owner.value}` }) }, Text)
    ctx.slots.register({ name: 'test.part', select: owner => owner.type === 'tool-weather' ? 'weather' : null }, Text)
    ctx.slots.register({
      name: 'test.part',
      priority: 1,
      select: owner => owner.type.startsWith('tool-') ? owner.type.slice(5) : null
    }, defineComponent({ props: { matched: { type: String, required: true } }, setup: props => () => h('i', props.matched) }))

    expect(await render(ctx)).toBe(
      '<div><nav>Y,X2</nav><!--[--><span>y</span><span>x2</span><!--]--><span>b:v</span><!--[-->none<!--]--><i>chart</i></div>'
    )
  })

  test('팩터리는 선언 없이 여러 소유자가 그리고, 정의를 해제하면 하위 슬롯도 접는다', async () => {
    const ctx = await setup()
    const Composer = defineComponent({
      props: { placeholder: { type: String, required: true } },
      setup: props => () => h('form', [props.placeholder, h(SlotOutlet, { name: 'test.factory.action', owner: { disabled: false } })])
    })
    ctx.slots.register({ name: 'root' }, defineComponent({
      setup: () => () => h('div', [
        h(SlotFactory, { name: 'test.composer', owner: { placeholder: 'home' } }),
        h(SlotFactory, { name: 'test.composer', owner: { placeholder: 'chat' } }, { fallback: () => 'no composer' })
      ])
    }))
    const definition = ctx.plugin({
      inject: ['slots'],
      apply(child: Context) {
        child.slots.registerFactory({ name: 'test.composer', children: { 'test.factory.action': 'list' } }, Composer)
      }
    })
    await definition
    ctx.slots.register({ name: 'test.factory.action', id: 'send', inject: owner => ({ text: String(owner.disabled) }) }, Text)
    expect(await render(ctx)).toBe('<div><form>home<!--[--><span>false</span><!--]--></form><form>chat<!--[--><span>false</span><!--]--></form></div>')
    expect(() => ctx.slots.registerFactory({ name: 'test.composer' }, Composer)).toThrow('already has a definition')

    await definition.dispose()
    expect(ctx.slots.declared('test.factory.action')).toBe(false)
    expect(await render(ctx)).toBe('<div><!----><!--[-->no composer<!--]--></div>')
  })
})
