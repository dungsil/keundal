import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['sidecar/main.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'node24',
  outDir: 'dist-sidecar',
  dts: false,
  sourcemap: true,
  deps: { alwaysBundle: () => true },
  clean: true
})
