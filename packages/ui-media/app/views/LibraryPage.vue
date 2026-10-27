<script setup lang="ts">
import { useLocalStorage, useMounted } from '@vueuse/core'
import type {
  MediaClip,
  MediaDownloadJob,
  MediaDownloadRequest,
  MediaItem,
  SubtitleTrack,
  TranslateSubtitlesRequest,
  TranslateSubtitlesResult
} from '@keundal/media'
import type { TranscribeMediaRequest, TranscribeMediaResult } from '@keundal/transcription'

import { useText } from '../locale'

const props = defineProps<{
  available: () => boolean
  /** 데스크톱은 로컬 도구를 실행할 수 있으므로 다운로드와 전사를 제공합니다. */
  desktop: () => boolean
  items: (path: string) => Promise<readonly MediaItem[]>
  videoUrl: (request: { libraryPath: string; itemId: string }) => Promise<string>
  createLibrary: (request: { path: string; name?: string }) => Promise<{ path: string }>
  startDownload: (request: MediaDownloadRequest) => Promise<MediaDownloadJob>
  downloads: () => Promise<readonly MediaDownloadJob[]>
  exportClips: (request: {
    libraryPath: string
    itemId: string
    clips: readonly MediaClip[]
    outputDirectory: string
    burnSubtitles?: boolean
    trackId?: string
    watermark?: string | null
  }) => Promise<readonly { clipId: string; name: string; path: string }[]>
  exportFcpxml: (request: {
    libraryPath: string
    itemId: string
    clips: readonly MediaClip[]
    outputPath: string
    title?: string
  }) => Promise<{ path: string; clipCount: number }>
  transcribe: (request: TranscribeMediaRequest) => Promise<TranscribeMediaResult>
  translate: (request: TranslateSubtitlesRequest) => Promise<TranslateSubtitlesResult>
  saveSubtitle: (request: { libraryPath: string; itemId: string; track: SubtitleTrack }) => Promise<void>
  llmModels: () => string[]
}>()

const { t } = useText()
const mounted = useMounted()
const available = computed(() => mounted.value && props.available())
const isDesktop = computed(() => mounted.value && props.desktop())

const libraryPath = useLocalStorage('keundal:media-library', '')
const mediaItems = ref<readonly MediaItem[]>([])
const selected = ref<MediaItem | null>(null)
const videoSrc = ref('')
const currentMs = ref(0)
const trackId = ref('')
const busy = ref('')
const error = ref('')
const note = ref('')

const downloadUrl = ref('')
const downloadFolder = ref('')
const transcribeLanguage = ref('')
const transcribeModel = ref('')
const translateLanguage = ref('ko')
const translateModel = ref('')
const clips = ref<MediaClip[]>([])
const clipName = ref('')
const clipStart = ref('')
const clipEnd = ref('')
const exportFolder = ref('')
const fcpxmlPath = ref('')
const burnIn = ref(false)
const watermark = ref('')
const downloadJobs = ref<readonly MediaDownloadJob[]>([])

const message = (value: unknown) => (value instanceof Error ? value.message : String(value))
const tracks = computed(() => selected.value?.subtitleTracks ?? [])
const track = computed(() => tracks.value.find((entry) => entry.id === trackId.value) ?? tracks.value[0] ?? null)
const activeSegment = computed(
  () => track.value?.segments.find((entry) => currentMs.value >= entry.startMs && currentMs.value < entry.endMs) ?? null
)

async function load() {
  if (!available.value || libraryPath.value.trim().length === 0) return
  error.value = ''
  try {
    mediaItems.value = await props.items(libraryPath.value.trim())
  } catch (failure) {
    error.value = t('media.libraryFailed', { message: message(failure) })
  }
}

async function createCurrentLibrary() {
  if (libraryPath.value.trim().length === 0) return
  busy.value = 'library'
  error.value = ''
  try {
    const library = await props.createLibrary({ path: libraryPath.value.trim() })
    libraryPath.value = library.path
    await load()
  } catch (failure) {
    error.value = t('media.libraryFailed', { message: message(failure) })
  } finally {
    busy.value = ''
  }
}

async function selectItem(item: MediaItem) {
  selected.value = item
  trackId.value = item.subtitleTracks[0]?.id ?? ''
  currentMs.value = 0
  note.value = ''
  videoSrc.value = ''
  try {
    videoSrc.value = await props.videoUrl({ libraryPath: libraryPath.value.trim(), itemId: item.id })
  } catch (failure) {
    error.value = t('media.actionFailed', { action: t('media.playback'), message: message(failure) })
  }
}

function onTimeUpdate(event: Event) {
  currentMs.value = (event.target as HTMLVideoElement).currentTime * 1000
}

async function runTranscribe() {
  const item = selected.value
  if (!item) return
  busy.value = 'transcribe'
  error.value = ''
  note.value = ''
  try {
    const result = await props.transcribe({
      filePath: item.video.path,
      ...(transcribeLanguage.value.trim() ? { language: transcribeLanguage.value.trim() } : {}),
      ...(transcribeModel.value.trim() ? { model: transcribeModel.value.trim() } : {})
    })
    await props.saveSubtitle({
      libraryPath: libraryPath.value.trim(),
      itemId: item.id,
      track: {
        id: 'original',
        kind: 'original',
        language: (result.language ?? transcribeLanguage.value.trim()) || 'und',
        segments: result.segments.map((segment) => ({ ...segment, speaker: null }))
      }
    })
    await load()
    const updated = mediaItems.value.find((entry) => entry.id === item.id)
    if (updated) await selectItem(updated)
    note.value = t('media.transcribeDone', { count: result.segments.length })
  } catch (failure) {
    error.value = t('media.actionFailed', { action: t('media.transcribe'), message: message(failure) })
  } finally {
    busy.value = ''
  }
}

async function runTranslate() {
  const item = selected.value
  const source = track.value
  if (!item || !source) return
  busy.value = 'translate'
  error.value = ''
  note.value = ''
  try {
    const result = await props.translate({
      track: source,
      targetLanguage: translateLanguage.value.trim(),
      model: translateModel.value.trim(),
      title: item.title
    })
    await props.saveSubtitle({
      libraryPath: libraryPath.value.trim(),
      itemId: item.id,
      track: result.track
    })
    await load()
    const updated = mediaItems.value.find((entry) => entry.id === item.id)
    if (updated) await selectItem(updated)
    trackId.value = result.track.id
    note.value = t('media.translateDone', { failed: result.failed })
  } catch (failure) {
    error.value = t('media.actionFailed', { action: t('media.translate'), message: message(failure) })
  } finally {
    busy.value = ''
  }
}

async function runDownload() {
  busy.value = 'download'
  error.value = ''
  note.value = ''
  try {
    const job = await props.startDownload({
      url: downloadUrl.value.trim(),
      outputDirectory: downloadFolder.value.trim()
    })
    downloadJobs.value = [job, ...downloadJobs.value.filter((entry) => entry.jobId !== job.jobId)]
    ensurePolling()
    note.value = t('media.downloadQueued', { state: job.state })
  } catch (failure) {
    error.value = t('media.actionFailed', { action: t('media.download'), message: message(failure) })
  } finally {
    busy.value = ''
  }
}

function addClip() {
  const startMs = Math.round(Number(clipStart.value) * 1_000)
  const endMs = Math.round(Number(clipEnd.value) * 1_000)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    error.value = t('media.clipInvalid')
    return
  }
  error.value = ''
  clips.value = [
    ...clips.value,
    {
      id: `clip-${clips.value.length + 1}`,
      name: clipName.value.trim() || t('media.clipDefault', { index: clips.value.length + 1 }),
      startMs,
      endMs
    }
  ]
}

function removeClip(id: string) {
  clips.value = clips.value.filter((clip) => clip.id !== id)
}

async function runExport() {
  const item = selected.value
  if (!item || clips.value.length === 0) return
  busy.value = 'export'
  error.value = ''
  note.value = ''
  try {
    const files = await props.exportClips({
      libraryPath: libraryPath.value.trim(),
      itemId: item.id,
      clips: clips.value,
      outputDirectory: exportFolder.value.trim(),
      ...(burnIn.value && track.value ? { burnSubtitles: true, trackId: track.value.id } : {}),
      ...(watermark.value.trim() ? { watermark: watermark.value.trim() } : {})
    })
    note.value = t('media.exportDone', { count: files.length })
  } catch (failure) {
    error.value = t('media.actionFailed', { action: t('media.export'), message: message(failure) })
  } finally {
    busy.value = ''
  }
}

async function runFcpxml() {
  const item = selected.value
  if (!item || clips.value.length === 0) return
  busy.value = 'fcpxml'
  error.value = ''
  note.value = ''
  try {
    const written = await props.exportFcpxml({
      libraryPath: libraryPath.value.trim(),
      itemId: item.id,
      clips: clips.value,
      outputPath: fcpxmlPath.value.trim()
    })
    note.value = t('media.fcpxmlDone', { count: written.clipCount })
  } catch (failure) {
    error.value = t('media.actionFailed', { action: t('media.fcpxml'), message: message(failure) })
  } finally {
    busy.value = ''
  }
}

onMounted(async () => {
  await load()
  translateModel.value = props.llmModels()[0] ?? ''
})
watch(libraryPath, load)

let timer: ReturnType<typeof setInterval> | undefined

async function refreshDownloads() {
  try {
    downloadJobs.value = await props.downloads()
  } catch {
    // 진행률은 부가 정보이므로 실패해도 화면을 막지 않습니다.
  }
}

/** 내려받기를 시작한 뒤 끝날 때까지 2초마다 상태를 갱신합니다. */
function ensurePolling() {
  if (timer !== undefined) return
  timer = setInterval(() => {
    void refreshDownloads().then(() => {
      const running = downloadJobs.value.some(
        (job) => job.state !== 'completed' && job.state !== 'failed' && job.state !== 'cancelled'
      )
      if (running || timer === undefined) return
      clearInterval(timer)
      timer = undefined
    })
  }, 2_000)
}

onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
})
</script>

<template>
  <div class="mx-auto w-full max-w-5xl space-y-6 p-4">
    <h1 class="text-lg font-semibold">{{ t('media.title') }}</h1>

    <UAlert v-if="mounted && !available" color="neutral" variant="subtle" :description="t('media.unavailable')" />
    <UAlert v-else-if="error" color="error" variant="subtle" :description="error" />
    <UAlert v-else-if="note" color="neutral" variant="subtle" :description="note" />

    <template v-if="available">
      <div class="flex items-end gap-2">
        <UFormField :label="t('media.libraryPath')" class="flex-1">
          <UInput v-model="libraryPath" class="w-full font-mono" />
        </UFormField>
        <UButton :loading="busy === 'library'" :label="t('media.libraryCreate')" @click="createCurrentLibrary" />
        <UButton variant="subtle" :label="t('media.libraryOpen')" @click="load" />
      </div>

      <div class="grid gap-4 md:grid-cols-[16rem_1fr]">
        <ul class="space-y-1">
          <li v-for="item in mediaItems" :key="item.id">
            <button
              type="button"
              class="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated"
              :class="selected?.id === item.id ? 'bg-elevated' : ''"
              @click="selectItem(item)"
            >
              {{ item.title }}
              <span v-if="!item.video.present" class="block text-xs text-muted">{{ t('media.videoMissing') }}</span>
            </button>
          </li>
          <li v-if="mediaItems.length === 0" class="px-2 text-sm text-muted">{{ t('media.noItems') }}</li>
        </ul>

        <div class="space-y-3">
          <div v-if="videoSrc" class="relative overflow-hidden rounded-lg bg-black">
            <video :src="videoSrc" controls class="w-full" @timeupdate="onTimeUpdate" />
            <p
              v-if="activeSegment"
              class="pointer-events-none absolute inset-x-4 bottom-4 rounded bg-black/70 px-2 py-1 text-center text-sm text-white"
            >
              {{ activeSegment.text }}
            </p>
          </div>
          <p v-else class="text-sm text-muted">{{ t('media.selectHint') }}</p>

          <div v-if="selected && tracks.length > 0" class="flex items-center gap-2">
            <USelect
              v-model="trackId"
              :items="tracks.map((entry) => ({ label: `${entry.language} (${entry.kind})`, value: entry.id }))"
              class="w-48"
            />
            <span class="text-sm text-muted">{{ t('media.trackLines', { count: track?.segments.length ?? 0 }) }}</span>
          </div>
          <p v-else-if="selected" class="text-sm text-muted">{{ t('media.noTracks') }}</p>

          <form v-if="selected && isDesktop" class="flex flex-wrap items-end gap-2" @submit.prevent="runTranscribe">
            <UFormField :label="t('media.transcribeLanguage')">
              <UInput v-model="transcribeLanguage" placeholder="ko" class="w-24" />
            </UFormField>
            <UFormField :label="t('media.transcribeModel')">
              <UInput v-model="transcribeModel" placeholder="large-v3-turbo-q5_0" class="w-56 font-mono" />
            </UFormField>
            <UButton type="submit" :loading="busy === 'transcribe'" :label="t('media.transcribeRun')" />
          </form>

          <form v-if="selected && track" class="flex flex-wrap items-end gap-2" @submit.prevent="runTranslate">
            <UFormField :label="t('media.translateLanguage')">
              <UInput v-model="translateLanguage" placeholder="ko" class="w-24" />
            </UFormField>
            <UFormField :label="t('media.translateModel')">
              <UInput v-model="translateModel" placeholder="gpt-4.1-mini" class="w-56 font-mono" />
            </UFormField>
            <UButton type="submit" :loading="busy === 'translate'" :label="t('media.translateRun')" />
          </form>

          <form v-if="isDesktop" class="flex flex-wrap items-end gap-2 border-t border-default pt-3" @submit.prevent="runDownload">
            <UFormField :label="t('media.downloadUrl')" class="flex-1">
              <UInput v-model="downloadUrl" class="w-full" />
            </UFormField>
            <UFormField :label="t('media.downloadFolder')">
              <UInput v-model="downloadFolder" class="w-64 font-mono" />
            </UFormField>
            <UButton type="submit" :loading="busy === 'download'" :label="t('media.downloadStart')" />
          </form>

          <div v-if="downloadJobs.length > 0" class="space-y-1">
            <h2 class="text-sm font-medium">{{ t('media.downloadJobs') }}</h2>
            <ul class="space-y-1 text-sm">
              <li v-for="job in downloadJobs" :key="job.jobId">
                <span class="text-muted">{{ job.state }}</span>
                <template v-if="job.percent !== null"> · {{ job.percent }}%</template>
                <template v-if="job.title"> · {{ job.title }}</template>
                <span v-if="job.message" class="text-muted"> · {{ job.message }}</span>
              </li>
            </ul>
          </div>

          <div v-if="selected" class="space-y-2 border-t border-default pt-3">
            <h2 class="text-sm font-medium">{{ t('media.studio') }}</h2>
            <div class="flex flex-wrap items-end gap-2">
              <UFormField :label="t('media.clipName')">
                <UInput v-model="clipName" class="w-40" />
              </UFormField>
              <UFormField :label="t('media.clipStart')">
                <UInput v-model="clipStart" placeholder="0.0" class="w-24" />
              </UFormField>
              <UFormField :label="t('media.clipEnd')">
                <UInput v-model="clipEnd" placeholder="5.0" class="w-24" />
              </UFormField>
              <UButton type="button" variant="subtle" :label="t('media.clipAdd')" @click="addClip" />
            </div>
            <ul class="space-y-1">
              <li v-for="clip in clips" :key="clip.id" class="flex items-center justify-between gap-2 text-sm">
                <span>
                  {{ clip.name }} · {{ (clip.startMs / 1000).toFixed(1) }}s–{{ (clip.endMs / 1000).toFixed(1) }}s
                </span>
                <UButton size="xs" variant="ghost" :label="t('media.clipRemove')" @click="removeClip(clip.id)" />
              </li>
              <li v-if="clips.length === 0" class="text-sm text-muted">{{ t('media.clipEmpty') }}</li>
            </ul>
            <div v-if="isDesktop" class="flex flex-wrap items-end gap-2">
              <UFormField :label="t('media.exportFolder')" class="flex-1">
                <UInput v-model="exportFolder" class="w-full font-mono" />
              </UFormField>
              <UFormField :label="t('media.watermark')">
                <UInput v-model="watermark" class="w-40" />
              </UFormField>
              <UCheckbox v-model="burnIn" :label="t('media.burnIn')" />
              <UButton
                :disabled="clips.length === 0 || !exportFolder.trim()"
                :loading="busy === 'export'"
                :label="t('media.exportRun')"
                @click="runExport"
              />
            </div>
            <div class="flex flex-wrap items-end gap-2">
              <UFormField :label="t('media.fcpxmlPath')" class="flex-1">
                <UInput v-model="fcpxmlPath" class="w-full font-mono" />
              </UFormField>
              <UButton
                :disabled="clips.length === 0 || !fcpxmlPath.trim()"
                :loading="busy === 'fcpxml'"
                :label="t('media.fcpxmlRun')"
                @click="runFcpxml"
              />
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
