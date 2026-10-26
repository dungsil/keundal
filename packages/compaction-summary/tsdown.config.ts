import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: ['src/index.ts', 'src/controller.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  clean: true
})
