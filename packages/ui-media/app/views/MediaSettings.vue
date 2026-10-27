<script setup lang="ts">
import { useMounted } from '@vueuse/core'
import type { MediaItem, MediaToolName, MediaToolStatus } from '@keundal/media'
import type { SpeechModelStatus } from '@keundal/transcription'

import { useText } from '../locale'

const props = defineProps<{
  /** 이 실행 방식이 미디어 기능을 제공하는지 알려줍니다. */
  available: () => boolean
  tools: () => Promise<readonly MediaToolStatus[]>
  installTool: (name: MediaToolName) => Promise<MediaToolStatus>
  models: () => Promise<readonly SpeechModelStatus[]>
  installModel: (id: string) => Promise<SpeechModelStatus>
  createLibrary: (request: { path: string; name?: string }) => Promise<{ path: string }>
  items: (path: string) => Promise<readonly MediaItem[]>
}>()

const { t } = useText()
const mounted = useMounted()
// 플랫폼은 브라우저에서만 있으므로 마운트 전에는 사용할 수 없음으로 봅니다.
const available = computed(() => mounted.value && props.available())
const toolStates = ref<readonly MediaToolStatus[]>([])
const modelStates = ref<readonly SpeechModelStatus[]>([])
const libraryPath = ref('')
const libraryItems = ref<readonly MediaItem[]>([])
const busy = ref('')
const failure = ref('')

const message = (value: unknown) => (value instanceof Error ? value.message : String(value))
const megabytes = (bytes: number) => Math.round(bytes / 1_000_000)

async function load() {
  if (!available.value) return
  failure.value = ''
  try {
    const [nextTools, nextModels] = await Promise.all([props.tools(), props.models()])
    toolStates.value = nextTools
    modelStates.value = nextModels
  } catch (error) {
    failure.value = t('media.loadFailed', { message: message(error) })
  }
}

onMounted(load)

async function installDownloadTool(name: MediaToolName) {
  busy.value = `tool:${name}`
  failure.value = ''
  try {
    await props.installTool(name)
    await load()
  } catch (error) {
    failure.value = t('media.toolInstallFailed', { name, message: message(error) })
  } finally {
    busy.value = ''
  }
}

async function installSpeechModel(id: string) {
  busy.value = `model:${id}`
  failure.value = ''
  try {
    await props.installModel(id)
    await load()
  } catch (error) {
    failure.value = t('media.modelInstallFailed', { name: id, message: message(error) })
  } finally {
    busy.value = ''
  }
}

async function openLibrary(create: boolean) {
  busy.value = 'library'
  failure.value = ''
  try {
    const path = create
      ? (await props.createLibrary({ path: libraryPath.value.trim() })).path
      : libraryPath.value.trim()
    libraryItems.value = await props.items(path)
  } catch (error) {
    failure.value = t('media.libraryFailed', { message: message(error) })
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <section class="space-y-6">
    <h2 class="text-base font-semibold">{{ t('media.title') }}</h2>

    <UAlert v-if="mounted && !available" color="neutral" variant="subtle" :description="t('media.unavailable')" />
    <UAlert v-else-if="failure" color="error" variant="subtle" :description="failure" />

    <template v-if="available">
      <div class="space-y-2">
        <h3 class="text-sm font-medium">{{ t('media.tools') }}</h3>
        <ul class="space-y-2">
          <li v-for="tool in toolStates" :key="tool.name" class="flex items-center justify-between gap-3">
            <span class="font-mono text-sm">{{ tool.name }}</span>
            <span class="text-sm text-muted">
              {{ tool.installed ? t('media.toolInstalled') : t('media.toolMissing') }}
              <template v-if="tool.version">· {{ t('media.toolVersion', { version: tool.version }) }}</template>
            </span>
            <UButton
              size="xs"
              variant="subtle"
              :loading="busy === `tool:${tool.name}`"
              :label="t('media.toolInstall', { name: tool.name })"
              @click="installDownloadTool(tool.name)"
            />
          </li>
        </ul>
      </div>

      <div class="space-y-2">
        <h3 class="text-sm font-medium">{{ t('media.models') }}</h3>
        <ul class="space-y-2">
          <li v-for="model in modelStates" :key="model.id" class="flex items-center justify-between gap-3">
            <span class="text-sm">{{ model.label }}</span>
            <span class="text-sm text-muted">{{ t('media.modelBytes', { size: megabytes(model.bytes) }) }}</span>
            <span class="text-sm text-muted">
              {{ model.installed ? t('media.modelInstalled') : t('media.modelMissing') }}
            </span>
            <UButton
              size="xs"
              variant="subtle"
              :loading="busy === `model:${model.id}`"
              :label="t('media.modelInstall', { name: model.label })"
              @click="installSpeechModel(model.id)"
            />
          </li>
        </ul>
      </div>

      <div class="space-y-2">
        <h3 class="text-sm font-medium">{{ t('media.library') }}</h3>
        <UFormField :label="t('media.libraryPath')">
          <UInput v-model="libraryPath" class="w-full font-mono" />
        </UFormField>
        <div class="flex gap-2">
          <UButton
            size="xs"
            :loading="busy === 'library'"
            :disabled="!libraryPath.trim()"
            :label="t('media.libraryCreate')"
            @click="openLibrary(true)"
          />
          <UButton
            size="xs"
            variant="subtle"
            :loading="busy === 'library'"
            :disabled="!libraryPath.trim()"
            :label="t('media.libraryOpen')"
            @click="openLibrary(false)"
          />
        </div>
        <p class="text-sm text-muted">{{ t('media.libraryItems', { count: libraryItems.length }) }}</p>
        <ul class="space-y-1">
          <li v-for="item in libraryItems" :key="item.id" class="text-sm">
            {{ item.title }}
            <span v-if="!item.video.present" class="text-muted">· {{ item.video.path }}</span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
