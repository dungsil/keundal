import { defineConfig } from 'tsdown'

export default defineConfig([
  { entry: ['src/index.ts'], platform: 'node', target: 'node24', fixedExtension: false, dts: true, clean: true },
  {
    entry: ['src/guest.ts'],
    platform: 'node',
    target: 'node24',
    fixedExtension: false,
    deps: { alwaysBundle: () => true },
    outputOptions: { codeSplitting: false },
    outDir: 'dist/guest',
    dts: false,
    clean: false
  }
])
