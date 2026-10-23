export async function importPluginDirectory(files: readonly Pick<File, 'webkitRelativePath' | 'size' | 'text'>[]) {
  const root = files.find(file => /^[^/]+\/plugin\.json$/.test(file.webkitRelativePath))?.webkitRelativePath.split('/')[0]
  if (!root) throw new Error('Select a plugin folder containing plugin.json at its root.')
  const entries = files.filter((file) => {
    const path = file.webkitRelativePath.slice(root.length + 1)
    return file.webkitRelativePath.startsWith(`${root}/`)
      && (path === 'plugin.json' || path === 'mcp.json' || /^skills\/[^/]+\/SKILL\.md$/.test(path))
  })
  if (entries.reduce((size, file) => size + file.size, 0) > 4 * 1024 * 1024)
    throw new Error('Plugin text files must be 4 MiB or smaller.')
  return Object.fromEntries(await Promise.all(entries.map(async file => [
    file.webkitRelativePath.slice(root.length + 1), await file.text()
  ]))) as Record<string, string>
}
