import type { NativeInvoke } from '@keundal/chat/platform'
import type { SkillFiles, SkillFileSource } from '@keundal/chat/skills'
export function createNativeSkillSource(invoke: NativeInvoke): SkillFileSource {
  return {
    list: () => invoke<SkillFiles>('list_skill_files'),
    read: (path) => invoke<string>('read_skill_file', { path })
  }
}
