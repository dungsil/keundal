const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_MARKDOWN_BYTES = 1024 * 1024

export async function importSkillFile(file: Pick<File, 'name' | 'size' | 'text' | 'arrayBuffer'>) {
  const { parseSkillMarkdown } = await import('@keundal/skill-markdown')
  if (!file.name.toLowerCase().endsWith('.zip')) return parseSkillMarkdown(await file.text())
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP files must be 10 MiB or smaller.')

  const { unzipSync, strFromU8 } = await import('fflate')
  let matches = 0
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter(entry) {
      const parts = entry.name.split('/')
      if (parts.includes('__MACOSX') || parts.at(-1) !== 'SKILL.md') return false
      if (++matches > 1) throw new Error('ZIP must contain exactly one SKILL.md file.')
      if (entry.originalSize > MAX_MARKDOWN_BYTES) throw new Error('SKILL.md must be 1 MiB or smaller.')
      return true
    }
  })
  const markdown = Object.values(files)[0]
  if (!markdown) throw new Error('ZIP must contain a SKILL.md file.')
  return parseSkillMarkdown(strFromU8(markdown))
}
