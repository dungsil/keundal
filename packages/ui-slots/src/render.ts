import {
  computed,
  defineComponent,
  Fragment,
  h,
  inject,
  onErrorCaptured,
  provide,
  shallowRef,
  type Component,
  type InjectionKey,
  type PropType,
  type VNode
} from 'vue'

import type { FactoryName, SlotEntry, SlotEntryInfo, SlotName, SlotService } from './registry'

interface Scope {
  service: SlotService
  /** Slot names the nearest entry declared; only these may render below it. */
  children: ReadonlySet<string>
  /** Entry that owns this subtree, used in error messages. */
  owner: string
}

const SCOPE: InjectionKey<Scope> = Symbol('keundal-slot-scope')

function useScope(name: string): Scope {
  const scope = inject(SCOPE, undefined)
  if (!scope) throw new Error(`slot "${name}" is rendered outside <SlotRoot>`)
  if (!scope.children.has(name)) throw new Error(`slot "${name}" is not declared by ${scope.owner}`)
  return scope
}

function propNames(component: Component): readonly string[] | undefined {
  const props: unknown = 'props' in component ? component.props : undefined
  if (Array.isArray(props)) return props
  return props && typeof props === 'object' ? Object.keys(props) : undefined
}

const SlotEntryHost = defineComponent({
  name: 'SlotEntryHost',
  props: {
    slot: { type: String, required: true },
    entry: { type: Object as PropType<SlotEntry>, required: true },
    owner: { type: Object, required: true },
    matched: { type: null, default: undefined }
  },
  setup(props) {
    const parent = inject(SCOPE)!
    provide(SCOPE, {
      service: parent.service,
      children: new Set(Object.keys(props.entry.children)),
      owner: `an entry of "${props.slot}"`
    })
    // The face is built once per mount, so state it creates survives owner updates.
    const face = props.entry.inject?.(props.owner) ?? {}
    const accepted = propNames(props.entry.component)
    const failed = shallowRef(false)
    onErrorCaptured((error) => {
      console.error(`slot "${props.slot}" entry failed`, error)
      failed.value = true
      return false
    })
    return () => {
      if (failed.value) return null
      const values: Record<string, unknown> = {
        ...props.owner,
        ...face,
        ...(props.matched === undefined ? {} : { matched: props.matched })
      }
      const passed = accepted
        ? Object.fromEntries(accepted.filter((name) => name in values).map((name) => [name, values[name]]))
        : {}
      return h(props.entry.component, passed)
    }
  }
})

/**
 * Render a slot the surrounding entry declared. A `fallback` Vue slot renders when no entry applies.
 *
 * Rendering a slot that the nearest entry did not declare throws: declaration also authorizes rendering.
 */
export const SlotOutlet = defineComponent({
  name: 'SlotOutlet',
  props: {
    name: { type: String as PropType<SlotName>, required: true },
    /** Key selected for a `keyed` slot. */
    entryKey: { type: String, default: undefined },
    /** Values every entry receives as props. */
    owner: { type: Object, default: () => ({}) }
  },
  setup(props, { slots }) {
    const scope = useScope(props.name)
    const service = scope.service
    return () => {
      void service.version.value
      const fallback = () => slots.fallback?.() ?? null
      const host = (entry: SlotEntry, matched?: unknown): VNode =>
        h(SlotEntryHost, {
          key: entry.id ?? entry.key ?? 'entry',
          slot: props.name,
          entry,
          owner: props.owner,
          matched
        })
      const entries = service.entries(props.name)
      switch (service.kind(props.name)) {
        case 'single':
          return entries[0] ? host(entries[0]) : fallback()
        case 'list':
          return entries.length
            ? h(
                Fragment,
                entries.map((entry) => host(entry))
              )
            : fallback()
        case 'keyed': {
          const entry = entries.find((item) => item.key === props.entryKey)
          return entry ? host(entry) : fallback()
        }
        case 'chain':
          for (const entry of entries) {
            const matched = entry.select!(props.owner)
            if (matched !== undefined && matched !== null) return host(entry, matched)
          }
          return fallback()
        default:
          return fallback()
      }
    }
  }
})

/**
 * Render a factory registered with `registerFactory`. Any entry may render a factory; the factory's own children
 * apply inside it. A `fallback` Vue slot renders while no definition is registered.
 */
export const SlotFactory = defineComponent({
  name: 'SlotFactory',
  props: {
    name: { type: String as PropType<FactoryName | (string & {})>, required: true },
    owner: { type: Object, default: () => ({}) }
  },
  setup(props, { slots }) {
    const scope = inject(SCOPE, undefined)
    if (!scope) throw new Error(`slot factory "${props.name}" is rendered outside <SlotRoot>`)
    const service = scope.service
    return () => {
      void service.version.value
      const entry = service.factory(props.name)
      return entry
        ? h(SlotEntryHost, { key: props.name, slot: `factory:${props.name}`, entry, owner: props.owner })
        : (slots.fallback?.() ?? null)
    }
  }
})

/** Render the built-in `root` slot of a {@link SlotService}. Place it once at the top of the application. */
export const SlotRoot = defineComponent({
  name: 'SlotRoot',
  props: {
    service: { type: Object as PropType<SlotService>, required: true }
  },
  setup(props) {
    provide(SCOPE, { service: props.service, children: new Set(['root']), owner: 'SlotRoot' })
    return () => h(SlotOutlet, { name: 'root' })
  }
}) as Component

/**
 * Describe the entries of a slot the surrounding entry declared, for owners that build navigation from entry
 * metadata. The result follows registration changes.
 */
export function useSlotEntries<K extends SlotName>(name: K) {
  const { service } = useScope(name)
  return computed<SlotEntryInfo<K>[]>(() => {
    void service.version.value
    return service.describe(name)
  })
}
