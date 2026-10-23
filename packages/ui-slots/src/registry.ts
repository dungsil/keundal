import { Service, type Context } from 'cordis'
import { shallowRef, type Component } from 'vue'

declare module 'cordis' {
  interface Context {
    readonly slots: SlotService
  }
}

/**
 * How an owner renders the entries of one slot.
 *
 * - `single`: the entry with the lowest priority renders.
 * - `list`: every entry renders, ordered by `order` and then by registration.
 * - `keyed`: the owner names one key; the lowest-priority entry with that key renders.
 * - `chain`: each entry's `select(owner)` runs in priority order and the first non-nullish result wins.
 */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

/** One row of {@link SlotMap}. `owner` is what the declaring owner passes; `meta` is what each entry describes. */
export interface SlotDefinition {
  kind: SlotKind
  owner: object
  meta?: object
}

/**
 * Compile-time slot registry. A package that declares a slot merges its row here:
 *
 * ```ts
 * declare module '@keundal/ui-slots' {
 *   interface SlotMap {
 *     'chat.composer': { kind: 'single'; owner: ComposerOwner }
 *   }
 * }
 * ```
 *
 * `root` is the only built-in declaration.
 */
export interface SlotMap {
  root: { kind: 'single'; owner: Record<string, never> }
}

export type SlotName = keyof SlotMap & string
export type SlotOwner<K extends SlotName> = SlotMap[K]['owner']
export type SlotMeta<K extends SlotName> = SlotMap[K] extends { meta: infer M } ? M : undefined

/** The child slots an entry declares, mapped to the kind each one is declared with. */
export type SlotChildren = { readonly [K in SlotName]?: SlotMap[K]['kind'] }

type KindOptions<K extends SlotName> = SlotMap[K]['kind'] extends 'list'
  ? { id: string; order?: number }
  : SlotMap[K]['kind'] extends 'keyed'
    ? { key: string; order?: number }
    : SlotMap[K]['kind'] extends 'chain'
      ? { select: (owner: SlotOwner<K>) => unknown }
      : object

type MetaOptions<K extends SlotName> = SlotMeta<K> extends undefined ? { meta?: undefined } : { meta: SlotMeta<K> }

/**
 * Registration of one component into a declared slot.
 *
 * `inject` runs once when the entry mounts. It closes over the registering plugin's `ctx` and returns the plain
 * data and callbacks the component receives as props. Components never receive `ctx`.
 */
export type SlotRegistration<K extends SlotName, I extends object = object> = {
  name: K
  /** Child slots this entry owns. Only these names may be rendered inside the entry's subtree. */
  children?: SlotChildren
  /** Lower values shadow higher ones in the same cell (`single`, `keyed`, `list` id) and run first in a `chain`. */
  priority?: number
  inject?: (owner: SlotOwner<K>) => I
} & KindOptions<K> &
  MetaOptions<K>

/** Read-only description of one registered entry, without its component. */
export interface SlotEntryInfo<K extends SlotName = SlotName> {
  readonly id?: string
  readonly key?: string
  readonly order: number
  readonly priority: number
  readonly meta: SlotMeta<K>
}

/**
 * Compile-time registry of reusable factories. A factory is one component, with its own child slots, that any entry
 * may render through `<SlotFactory>` without declaring it. Use it where several owners show the same assembly.
 */
export interface FactoryMap {}
export type FactoryName = keyof FactoryMap & string
export type FactoryOwner<K extends FactoryName> = FactoryMap[K] extends { owner: infer O extends object } ? O : object

/** Registration of a factory's single definition. */
export interface FactoryRegistration<K extends FactoryName, I extends object = object> {
  name: K
  children?: SlotChildren
  inject?: (owner: FactoryOwner<K>) => I
}

/** @internal */
export interface SlotEntry {
  readonly component: Component
  readonly id?: string
  readonly key?: string
  readonly order: number
  readonly priority: number
  readonly meta: unknown
  readonly children: Readonly<Record<string, SlotKind>>
  readonly select?: (owner: object) => unknown
  readonly inject?: (owner: object) => object
}

interface SlotRecord {
  kind?: SlotKind
  declaredBy?: SlotEntry | 'built-in'
  entries: SlotEntry[]
  listeners: Set<() => void>
}

type Disposer = () => void
type InjectResult = void | Disposer | readonly Disposer[]

const cellOf = (kind: SlotKind, entry: SlotEntry) =>
  kind === 'keyed' ? entry.key : kind === 'list' ? entry.id : undefined

/**
 * Cordis service `slots`: the registry that feature plugins contribute Vue components to.
 *
 * Every registration and declaration follows the lifetime of the calling plugin. Removing an entry collapses every
 * slot it declared, together with the entries registered into those slots.
 */
export class SlotService extends Service {
  private readonly records = new Map<string, SlotRecord>()
  private readonly factories = new Map<string, SlotEntry>()
  /** Incremented on every mutation so renderers re-read the registry. */
  readonly version = shallowRef(0)

  constructor(ctx: Context) {
    super(ctx, 'slots')
    const root = this.record('root')
    root.kind = 'single'
    root.declaredBy = 'built-in'
  }

  /**
   * Contribute a component to a declared slot.
   *
   * @throws when the slot is undeclared, a declared child is already owned, a cell is occupied at the same priority,
   * or a kind-specific option is missing.
   * @returns a disposer that removes the entry and collapses its children. It is also bound to the caller's lifetime.
   */
  register<K extends SlotName, I extends object = object>(
    options: SlotRegistration<K, I>,
    component: Component
  ): Disposer {
    const record = this.records.get(options.name)
    if (!record?.kind) throw new Error(`slot "${options.name}" is not declared`)
    const raw = options as SlotRegistration<K, I> & {
      id?: string
      key?: string
      order?: number
      select?: (owner: object) => unknown
      meta?: unknown
    }
    const kind = record.kind
    if (kind === 'list' && raw.id === undefined) throw new Error(`list slot "${options.name}" requires an id`)
    if (kind === 'keyed' && raw.key === undefined) throw new Error(`keyed slot "${options.name}" requires a key`)
    if (kind === 'chain' && raw.select === undefined) throw new Error(`chain slot "${options.name}" requires select`)
    const priority = options.priority ?? 0
    if (kind !== 'chain') {
      const cell = kind === 'keyed' ? raw.key : kind === 'list' ? raw.id : undefined
      if (record.entries.some((entry) => cellOf(kind, entry) === cell && entry.priority === priority)) {
        throw new Error(
          `slot "${options.name}"${cell === undefined ? '' : ` cell "${cell}"`} already has an entry at priority ${priority}`
        )
      }
    }
    const children = this.claim(options.children)
    const entry: SlotEntry = {
      component,
      ...(raw.id === undefined ? {} : { id: raw.id }),
      ...(raw.key === undefined ? {} : { key: raw.key }),
      order: raw.order ?? 0,
      priority,
      meta: raw.meta,
      children,
      ...(raw.select === undefined ? {} : { select: raw.select }),
      ...(options.inject === undefined ? {} : { inject: options.inject as (owner: object) => object })
    }
    // Stable sort: priority decides each cell's winner; ties keep registration order.
    record.entries = [...record.entries, entry].sort((a, b) => a.priority - b.priority)
    this.declare(entry)
    return this.ctx.effect(() => () => this.remove(options.name, entry), `slots: ${options.name}`)
  }

  /**
   * Register the one definition of a factory. Any entry may render it with `<SlotFactory>`.
   * @throws when the factory already has a definition or a declared child is already owned.
   * @returns a disposer that removes the definition and collapses its children.
   */
  registerFactory<K extends FactoryName, I extends object = object>(
    options: FactoryRegistration<K, I>,
    component: Component
  ): Disposer {
    if (this.factories.has(options.name)) throw new Error(`slot factory "${options.name}" already has a definition`)
    const entry: SlotEntry = {
      component,
      order: 0,
      priority: 0,
      meta: undefined,
      children: this.claim(options.children),
      // Renderers hold owners as plain objects; the factory's declaration fixes their shape.
      ...(options.inject === undefined ? {} : { inject: (owner: object) => options.inject!(owner as FactoryOwner<K>) })
    }
    this.factories.set(options.name, entry)
    this.declare(entry)
    return this.ctx.effect(
      () => () => {
        if (this.factories.get(options.name) !== entry) return
        this.factories.delete(options.name)
        this.collapse(entry)
        this.changed()
      },
      `slots factory: ${options.name}`
    )
  }

  /** @internal */
  factory(name: string): SlotEntry | undefined {
    return this.factories.get(name)
  }

  /** Check that no other entry owns the children being declared. */
  private claim(children: SlotChildren | undefined): Record<string, SlotKind> {
    const claimed: Record<string, SlotKind> = { ...children }
    for (const child of Object.keys(claimed)) {
      if (this.records.get(child)?.kind) throw new Error(`slot "${child}" is already declared`)
    }
    return claimed
  }

  private declare(entry: SlotEntry): void {
    const declared: SlotRecord[] = []
    for (const [child, childKind] of Object.entries(entry.children)) {
      const childRecord = this.record(child)
      childRecord.kind = childKind
      childRecord.declaredBy = entry
      declared.push(childRecord)
    }
    this.changed()
    // Listeners may register into the new children, so notify only after every child is declared.
    for (const childRecord of declared) this.notify(childRecord)
  }

  /**
   * Run `callback` for every lifetime of a declaration, including one that already exists. The disposers it returns
   * run when the declaring entry is removed, and the callback runs again if the slot is declared again.
   * Use this to contribute to a slot that another plugin declares.
   */
  inject<K extends SlotName>(name: K, callback: () => InjectResult): Disposer {
    const record = this.record(name)
    let active: Disposer[] | undefined
    const release = () => {
      const disposers = active
      active = undefined
      for (const dispose of disposers?.toReversed() ?? []) dispose()
    }
    const sync = () => {
      if (record.kind && !active) {
        const result = callback()
        active = typeof result === 'function' ? [result] : result ? [...result] : []
      } else if (!record.kind && active) {
        release()
      }
    }
    return this.ctx.effect(() => {
      record.listeners.add(sync)
      sync()
      return () => {
        record.listeners.delete(sync)
        release()
      }
    }, `slots.inject: ${name}`)
  }

  /** Whether a slot is currently declared. */
  declared(name: string): boolean {
    return this.records.get(name)?.kind !== undefined
  }

  /** Read the kind a slot is declared with, or `undefined` while undeclared. */
  kind(name: string): SlotKind | undefined {
    return this.records.get(name)?.kind
  }

  /** Describe the entries of a slot in render order, without their components. */
  describe<K extends SlotName>(name: K): SlotEntryInfo<K>[] {
    return this.entries(name).map((entry) => ({
      ...(entry.id === undefined ? {} : { id: entry.id }),
      ...(entry.key === undefined ? {} : { key: entry.key }),
      order: entry.order,
      priority: entry.priority,
      meta: entry.meta as SlotMeta<K>
    }))
  }

  /**
   * The entries that render for a slot: one winner per cell for `single`, `keyed` and `list` in `order`, and every
   * entry for `chain` in priority order. Empty while the slot is undeclared.
   * @internal
   */
  entries(name: string): readonly SlotEntry[] {
    const record = this.records.get(name)
    if (!record?.kind) return []
    if (record.kind === 'chain') return record.entries
    const seen = new Set<string | undefined>()
    const kind = record.kind
    const winners = record.entries.filter((entry) => {
      const cell = cellOf(kind, entry)
      if (seen.has(cell)) return false
      seen.add(cell)
      return true
    })
    return winners.sort((a, b) => a.order - b.order)
  }

  private remove(name: string, entry: SlotEntry): void {
    const record = this.records.get(name)
    if (!record?.entries.includes(entry)) return
    record.entries = record.entries.filter((item) => item !== entry)
    this.collapse(entry)
    this.changed()
  }

  private collapse(entry: SlotEntry): void {
    for (const child of Object.keys(entry.children)) {
      const record = this.records.get(child)
      if (!record || record.declaredBy !== entry) continue
      const doomed = record.entries
      record.kind = undefined
      record.declaredBy = undefined
      record.entries = []
      for (const dead of doomed) this.collapse(dead)
      this.notify(record)
    }
  }

  private record(name: string): SlotRecord {
    let record = this.records.get(name)
    if (!record) {
      record = { entries: [], listeners: new Set() }
      this.records.set(name, record)
    }
    return record
  }

  private notify(record: SlotRecord): void {
    for (const listener of record.listeners) listener()
  }

  private changed(): void {
    this.version.value++
  }
}
