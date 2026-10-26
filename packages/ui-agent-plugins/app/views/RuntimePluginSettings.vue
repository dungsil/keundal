<script setup lang="ts">
import type { RuntimePluginInfo } from '@keundal/chat/platform'
import { useText } from '../locale'

const props = defineProps<{
  isAvailable: () => boolean
  list: () => Promise<RuntimePluginInfo[]>
  setEnabled: (module: string, enabled: boolean) => Promise<void>
}>()
const { t } = useText()
const available = ref(false)
const plugins = ref<RuntimePluginInfo[]>([])
const busy = ref(false)
const error = ref('')

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
        <p class="text-sm text-muted">{{ t('runtime.bundled') }}</p>
        <ul class="divide-y divide-default rounded-lg border border-default">
          <li v-for="plugin in plugins" :key="plugin.module" class="space-y-2 p-3">
            <div class="flex items-center gap-3">
              <div class="min-w-0 flex-1 space-y-1">
                <p class="text-sm font-medium break-all">{{ plugin.module }}</p>
                <p class="text-xs text-muted" role="status">{{ t(plugin.required ? 'runtime.required' : plugin.error ? 'runtime.failed' : plugin.enabled ? 'runtime.enabled' : 'runtime.disabled') }}</p>
              </div>
              <USwitch :model-value="plugin.enabled" :disabled="busy || plugin.required" :aria-label="t('runtime.enable', { name: plugin.module })" @update:model-value="run(() => setEnabled(plugin.module, $event))" />
            </div>
            <UAlert v-if="plugin.error" color="error" :title="plugin.error" :ui="{ title: 'break-words' }" />
          </li>
        </ul>
      </template>
    </section>
  </ClientOnly>
</template>
