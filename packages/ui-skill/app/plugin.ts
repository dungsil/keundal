import type { Context } from 'cordis'
import type { SkillSettings } from '@keundal/chat/skills'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui/app/contracts/settings.ts'
import { sharedText } from '@keundal/ui/app/utils/locale.ts'

import SkillSettingsSection from './views/SkillSettings.vue'

export const name = 'ui-skill'
export const inject = ['slots', 'chatRuntime']

export const metadata = {
  name: { en: 'Skill settings', ko: '스킬 설정' },
  description: {
    en: 'Manages skill settings and available skill files.',
    ko: '스킬 설정과 사용할 수 있는 스킬 파일을 관리합니다.'
  }
}

/** Add the skill management section to the settings page. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'skills',
    order: 110,
    meta: { label: sharedText('skill.title'), icon: 'i-lucide-book-open', group: 'plugins' },
    // The platform exists only in the browser, so each callback reads it when it runs.
    inject: () => ({
      capabilities: runtime.capabilities,
      loadSettings: () => runtime.platform.skills.load(),
      saveSettings: (next: SkillSettings) => runtime.platform.skills.save(next),
      listFiles: () => runtime.platform.skills.listFiles()
    })
  }, SkillSettingsSection))
}
