import { renameSync } from 'node:fs'

import { defineConfig } from 'tsdown'
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/sandbox.ts', 'src/sandbox-child.ts'],
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'node24',
    outDir: 'dist',
    dts: true,
    sourcemap: true,
    clean: true
  },
  {
    entry: ['src/sandbox-worker.ts'],
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'node24',
    outDir: 'dist/worker',
    deps: { alwaysBundle: () => true },
    // The worker must run without exposing the host's node_modules tree.
    outputOptions: { codeSplitting: false },
    dts: false,
    sourcemap: false,
    clean: false,
    onSuccess() {
      // This is an opaque child-process program, never a module for Nitro to transform or execute.
      renameSync('dist/worker/sandbox-worker.js', 'dist/worker/sandbox-worker.txt')
    }
  }
])
