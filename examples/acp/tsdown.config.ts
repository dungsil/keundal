import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  dts: false,
  sourcemap: true,
  clean: true
})
