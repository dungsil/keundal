import type {} from '@keundal/ui-slots'
import type { LocalizedText } from '@keundal/ui/app/utils/locale.ts'

/** Navigation data of one settings section. The entry's `key` is the path segment under `/settings/`. */
export interface SettingsSectionMeta {
  label: LocalizedText
  icon: string
  /** `general` sections come first; `plugins` sections are listed under the plugin heading. */
  group: 'general' | 'plugins'
  /** A query parameter that selects this section when `/settings` opens without a section. */
  query?: string
}

declare module '@keundal/ui-slots' {
  interface SlotMap {
    /** One section of the settings page, selected by key and listed in `order`. */
    'settings.section': { kind: 'keyed'; owner: Record<string, never>; meta: SettingsSectionMeta }
  }
}
