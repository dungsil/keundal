import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'browser',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true
})
