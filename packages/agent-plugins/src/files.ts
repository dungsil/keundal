import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export async function contained(root: string, path: string, kind: 'file' | 'directory'): Promise<string> {
  const actual = await realpath(resolve(root, path))
  const rel = relative(root, actual)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path escapes plugin boundary')
  const info = await stat(actual)
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new Error(`expected ${kind}`)
  return actual
}
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
