import type { MemoryAdapter } from '@keundal/memory'
import { StoredMemoryService, StoredProjectMemoryService } from '@keundal/memory-store'
import type { Context } from 'cordis'

export type { MemoryAdapter, MemoryAdapterSaveOptions } from '@keundal/memory'
export { StoredMemoryService, StoredProjectMemoryService } from '@keundal/memory-store'

export interface MemoryPluginConfig {
  adapter: MemoryAdapter
}

export function memoryPlugin(ctx: Context, config: MemoryPluginConfig): void {
  const scoped = new StoredMemoryService(ctx, config.adapter)
  new StoredProjectMemoryService(ctx, scoped)
}

export default memoryPlugin
