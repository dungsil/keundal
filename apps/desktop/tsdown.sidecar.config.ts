import { cpSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import { build, defineConfig } from 'tsdown'

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
  outputOptions: { codeSplitting: false },
  clean: true,
  async onSuccess() {
    await build({
      config: false,
      entry: ['sidecar/sandbox-worker.ts'],
      tsconfig: 'tsconfig.sidecar.json',
      format: 'esm',
      fixedExtension: false,
      platform: 'node',
      target: 'node24',
      outDir: 'dist-sidecar',
      dts: false,
      deps: { alwaysBundle: () => true },
      outputOptions: { codeSplitting: false },
      clean: false
    })
    // npm is a runtime resource, not a bundled library; its CLI resolves its own dependencies.
    cpSync(dirname(createRequire(import.meta.url).resolve('desktop-npm/package.json')), 'dist-sidecar/npm', { recursive: true })
  }
})
