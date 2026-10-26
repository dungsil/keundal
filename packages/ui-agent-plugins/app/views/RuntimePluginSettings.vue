<script setup lang="ts">
import type { RuntimePluginInfo, RuntimePluginSource } from '@keundal/chat/platform'
import { useText } from '../locale'

const props = defineProps<{
  isAvailable: () => boolean
  isInstallAvailable: () => boolean
  list: () => Promise<RuntimePluginInfo[]>
  setEnabled: (module: string, enabled: boolean) => Promise<void>
  install: (source: RuntimePluginSource) => Promise<void>
  remove: (module: string) => Promise<void>
}>()
const { t, locale } = useText()
const available = ref(false)
const installAvailable = ref(false)
const plugins = ref<RuntimePluginInfo[]>([])
const busy = ref(false)
const error = ref('')
const sourceType = ref<RuntimePluginSource['type']>('npm')
const sourceValue = ref('')
const trusted = ref(false)
const deleting = ref<string | null>(null)
const sourceItems = computed(() => [
  { label: 'npm', value: 'npm' },
  { label: 'JSR', value: 'jsr' },
  { label: t('runtime.zip'), value: 'zip' },
  { label: t('runtime.path'), value: 'path' }
])
const localSource = computed(() => sourceType.value === 'zip' || sourceType.value === 'path')

async function installPlugin() {
  if (!installAvailable.value || !trusted.value || !sourceValue.value.trim()) return
  await run(async () => {
    await props.install({ type: sourceType.value, value: sourceValue.value.trim() })
    sourceValue.value = ''
    trusted.value = false
  })
}

async function requestDelete(module: string) {
  deleting.value = module
  await nextTick()
  document.getElementById(`runtime-plugin-confirm-delete-${encodeURIComponent(module)}`)?.focus()
}

async function cancelDelete(module: string) {
  deleting.value = null
  await nextTick()
  document.getElementById(`runtime-plugin-delete-${encodeURIComponent(module)}`)?.focus()
}

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    try {
      plugins.value = await props.list()
    } catch (cause) {
      error.value ||= cause instanceof Error ? cause.message : String(cause)
    }
    busy.value = false
  }
}

onMounted(() => {
  available.value = props.isAvailable()
  installAvailable.value = props.isInstallAvailable()
  if (available.value) void run(async () => {})
})
</script>

<template>
  <ClientOnly>
    <section class="space-y-6" aria-labelledby="runtime-plugin-title" :aria-busy="busy">
      <h2 id="runtime-plugin-title" class="text-lg font-semibold text-highlighted">{{ t('runtime.title') }}</h2>
      <UAlert v-if="error" color="error" :title="error" role="alert" :ui="{ title: 'break-words' }" />
      <p v-if="!available" class="text-sm text-muted">{{ t('runtime.unavailable') }}</p>
      <template v-else>
        <form v-if="installAvailable" class="space-y-4 rounded-lg border border-default p-3" @submit.prevent="installPlugin">
          <h3 class="text-sm font-semibold">{{ t('runtime.install') }}</h3>
          <div class="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
            <UFormField :label="t('runtime.sourceType')" name="runtime-source-type">
              <USelect v-model="sourceType" :items="sourceItems" :disabled="busy" class="w-full" />
            </UFormField>
            <UFormField :label="t(localSource ? 'runtime.absolutePath' : 'runtime.package')" name="runtime-source-value">
              <UInput v-model="sourceValue" :disabled="busy" class="w-full" :aria-describedby="localSource ? 'runtime-plugin-local-path' : undefined" />
            </UFormField>
          </div>
          <p v-if="localSource" id="runtime-plugin-local-path" class="text-sm text-muted">{{ t('runtime.localPath') }}</p>
          <UAlert color="warning" variant="subtle" icon="i-lucide-shield-alert" :title="t('runtime.trustTitle')" :description="t('runtime.trustWarning')" />
          <UCheckbox v-model="trusted" :label="t('runtime.trust')" :disabled="busy" />
          <UButton type="submit" :label="t('runtime.install')" icon="i-lucide-download" :loading="busy" :disabled="busy || !trusted || !sourceValue.trim()" />
        </form>
        <p v-else class="text-sm text-muted">{{ t('runtime.bundled') }}</p>
        <ul class="divide-y divide-default rounded-lg border border-default">
          <li v-for="plugin in plugins" :key="plugin.module" class="space-y-2 p-3">
            <div class="flex items-center gap-3">
              <div class="min-w-0 flex-1 space-y-1">
                <p class="text-sm font-medium break-words">{{ plugin.metadata?.name[locale] || plugin.module }}</p>
                <p v-if="plugin.metadata?.description[locale]" class="text-sm text-muted break-words">{{ plugin.metadata.description[locale] }}</p>
                <p v-if="plugin.source" class="text-xs text-muted break-all">{{ t('runtime.source') }}: {{ sourceItems.find(item => item.value === plugin.source?.type)?.label }} · {{ plugin.source.value }}</p>
                <p v-if="plugin.source && plugin.version" class="text-xs text-muted break-words">{{ t('runtime.version') }}: {{ plugin.version }}</p>
                <p class="text-xs text-muted" role="status">{{ t(plugin.required ? 'runtime.required' : plugin.error ? 'runtime.failed' : plugin.enabled ? 'runtime.enabled' : 'runtime.disabled') }}</p>
              </div>
              <USwitch
                :model-value="plugin.enabled"
                :disabled="busy || plugin.required"
                :checked-icon="plugin.required ? 'i-lucide-lock-keyhole' : undefined"
                :aria-label="t('runtime.enable', { name: plugin.metadata?.name[locale] || plugin.module })"
                :aria-description="plugin.required ? t('runtime.requiredDescription') : undefined"
                @update:model-value="run(() => setEnabled(plugin.module, $event))"
              />
            </div>
            <UAlert v-if="plugin.error" color="error" :title="plugin.error" :ui="{ title: 'break-words' }" />
            <template v-if="installAvailable && plugin.source && !plugin.required">
              <div v-if="deleting === plugin.module" class="flex flex-wrap items-center gap-3">
                <p class="text-sm">{{ t('runtime.deleteHelp') }}</p>
                <UButton :label="t('common.cancel')" color="neutral" variant="ghost" :disabled="busy" @click="cancelDelete(plugin.module)" />
                <UButton
                  :id="`runtime-plugin-confirm-delete-${encodeURIComponent(plugin.module)}`"
                  :label="t('common.delete')"
                  :aria-label="t('runtime.remove', { name: plugin.metadata?.name[locale] || plugin.module })"
                  color="error"
                  :disabled="busy"
                  @click="run(async () => { await remove(plugin.module); deleting = null })"
                />
              </div>
              <UButton
                v-else
                :id="`runtime-plugin-delete-${encodeURIComponent(plugin.module)}`"
                :label="t('common.delete')"
                :aria-label="t('runtime.remove', { name: plugin.metadata?.name[locale] || plugin.module })"
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                :disabled="busy"
                @click="requestDelete(plugin.module)"
              />
            </template>
          </li>
        </ul>
      </template>
    </section>
  </ClientOnly>
</template>
