import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/app.ts', 'src/main.ts'],
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  dts: { entry: ['src/index.ts', 'src/app.ts'] },
  sourcemap: true,
  deps: { alwaysBundle: () => true },
  clean: true
})
