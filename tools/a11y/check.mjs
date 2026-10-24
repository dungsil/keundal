import console from 'node:console'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { scenarioTitles } from './scenarios.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const inventory = JSON.parse(await readFile(new URL('./components.json', import.meta.url), 'utf8'))
// UI plugins keep their components in `app/views`, outside Nuxt's global component directories.
const plugins = (await readdir(resolve(root, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('ui-'))
  .map((entry) => `packages/${entry.name}/app/views`)
const directories = ['packages/ui/app/components', 'packages/chat-app/app/components', ...plugins]
const files = (
  await Promise.all(
    directories.map(async (directory) => {
      const entries = await readdir(resolve(root, directory), { recursive: true }).catch((error) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      return entries.filter((file) => file.endsWith('.vue')).map((file) => `${directory}/${file.replaceAll('\\', '/')}`)
    })
  )
).flat()
const errors = []
for (const file of files) {
  const entry = inventory[file]
  if (!entry) {
    errors.push(`Unclassified component: ${file}`)
    continue
  }
  if (entry.exemption) {
    if (entry.scenario || entry.test || entry.exemption.trim().length < 30) errors.push(`Invalid exemption: ${file}`)
    continue
  }
  if (!/^@a11y:[a-z-]+$/.test(entry.scenario ?? '') || !entry.test?.endsWith('.spec.ts')) {
    errors.push(`Invalid scenario declaration: ${file}`)
    continue
  }
  const path = resolve(root, entry.test)
  if (!relative(root, path).startsWith('apps/web/tests/browser/')) {
    errors.push(`Invalid test path: ${file}`)
    continue
  }
  try {
    const source = await readFile(path, 'utf8')
    const titles = scenarioTitles(source, path)
    if (!titles.some((title) => title.split(/\s+/).includes(entry.scenario))) {
      errors.push(`Missing executable scenario ${entry.scenario}: ${file}`)
    }
  } catch {
    errors.push(`Missing test file: ${entry.test}`)
  }
}
for (const file of Object.keys(inventory)) if (!files.includes(file)) errors.push(`Stale component: ${file}`)
if (errors.length) throw new Error(errors.join('\n'))
console.log(
  `Accessibility inventory: ${files.length} components classified; ${Object.values(inventory).filter((entry) => entry.exemption).length} explicit exemptions.`
)
