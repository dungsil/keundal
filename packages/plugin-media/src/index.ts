import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import library from '@keundal/plugin-library-fs'
import download from '@keundal/plugin-media-download'
import exporter from '@keundal/plugin-media-export'
import tools from '@keundal/plugin-media-tools'
import shell from '@keundal/plugin-shell-local'
import translation from '@keundal/plugin-subtitle-translate'
import transcription from '@keundal/plugin-transcription-whisper'
import type { Context } from 'cordis'

import { mediaHttpPlugin } from './http.js'

export interface MediaConfig {
  readonly dataDir?: string
  readonly libraryRoot?: string
}

export const metadata = {
  name: { en: 'Media library', ko: '미디어 자료실' },
  description: {
    en: 'Downloads, transcribes, translates and exports local media.',
    ko: '영상을 내려받고 전사·자막 번역·클립 내보내기를 제공합니다.'
  }
}

export const name = 'media'
export const inject = ['hostHttp', 'llm']

/** All media effects, including the shell and HTTP routes, belong to this plugin. */
export async function apply(ctx: Context, config: MediaConfig = {}): Promise<void> {
  if (config.dataDir !== undefined && (typeof config.dataDir !== 'string' || !config.dataDir.trim())) {
    throw new TypeError('dataDir must be a non-empty string')
  }
  const dataDir = resolve(config.dataDir ?? join(homedir(), '.keundal', 'media'))
  await mkdir(dataDir, { recursive: true })
  // Media must neither replace nor inherit an agent's restricted shell provider.
  const scope = ctx.isolate('shell')
  await scope.plugin(shell, { cwd: dataDir, timeoutMs: 24 * 60 * 60 * 1000 })
  await scope.plugin(library, config.libraryRoot === undefined ? {} : { root: config.libraryRoot })
  await scope.plugin(tools, { dataDir })
  await scope.plugin(download, { workDirectory: join(dataDir, 'work') })
  await scope.plugin(transcription, { dataDir })
  await scope.plugin(translation)
  await scope.plugin(exporter, { workDirectory: join(dataDir, 'work') })
  await scope.plugin(mediaHttpPlugin)
}

export default { name, inject, apply }
