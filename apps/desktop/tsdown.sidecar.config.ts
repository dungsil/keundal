import { cpSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['sidecar/main.ts'],
  tsconfig: 'tsconfig.sidecar.json',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'node24',
  outDir: 'dist-sidecar',
  dts: false,
  sourcemap: true,
  deps: { alwaysBundle: () => true },
  clean: true,
  onSuccess() {
    // npm is a runtime resource, not a bundled library; its CLI resolves its own dependencies.
    cpSync(dirname(createRequire(import.meta.url).resolve('desktop-npm/package.json')), 'dist-sidecar/npm', { recursive: true })
  }
})
