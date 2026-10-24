import type { Context } from 'cordis'
import type {} from '@keundal/ui-composer/slots'
import type {} from '@keundal/ui-runtime'
import { lazyView } from '@keundal/ui-slots'

export const name = 'ui-dictation'
export const inject = ['slots', 'chatRuntime']

const DictateButton = lazyView(() => import('./views/DictateButton.vue'), [
  'state',
  'setState',
  'setPreview',
  'disabled',
  'appendTranscript',
  'ensureConfigured',
  'transcriptionSampleRate',
  'transcribe'
])

/** Replace the composer's submit button with a microphone control while the prompt is empty. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('composer.dictation', () => ctx.slots.register({
    name: 'composer.dictation',
    inject: () => ({
      ensureConfigured: (model: string) => runtime.ensureConfigured(model),
      transcriptionSampleRate: () => runtime.platform.transcription.sampleRate,
      transcribe: (audio: ReadableStream<Float32Array>, signal: AbortSignal) =>
        runtime.platform.transcription.start(runtime.settings.value, audio, signal)
    })
  }, DictateButton))
}
