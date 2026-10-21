import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  clean: true
})
