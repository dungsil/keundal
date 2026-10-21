import config from '@keundal/tsdown'
import { defineConfig } from 'tsdown'

export default defineConfig({ ...config, entry: ['src/index.ts', 'src/http.ts', 'src/contracts.ts'] })
