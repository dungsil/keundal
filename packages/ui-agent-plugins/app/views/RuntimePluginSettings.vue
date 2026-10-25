<script setup lang="ts">
import type { RuntimePluginInfo, RuntimePluginSpec } from '@keundal/chat/platform'
import { useText } from '../locale'

const props = defineProps<{
  isAvailable: () => boolean
  source: () => 'browser' | 'node'
  list: () => Promise<RuntimePluginInfo[]>
  install: (spec: RuntimePluginSpec) => Promise<void>
  setEnabled: (module: string, enabled: boolean) => Promise<void>
  remove: (module: string) => Promise<void>
}>()
const { t } = useText()
const available = ref(false)
const node = ref(false)
const plugins = ref<RuntimePluginInfo[]>([])
const busy = ref(false)
const error = ref('')
const adding = ref(false)
const module = ref('')
const exportName = ref('')
const config = ref('{}')
const trusted = ref(false)
const deleting = ref<string>()
const moduleInput = ref<{ inputRef?: HTMLInputElement } | null>(null)

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

async function openInstall() {
  adding.value = true
  trusted.value = false
  await nextTick()
  moduleInput.value?.inputRef?.focus()
}

async function closeInstall() {
  adding.value = false
  await nextTick()
  document.getElementById('runtime-plugin-add')?.focus()
}

async function requestDelete(module: string) {
  deleting.value = module
  await nextTick()
  document.getElementById(`runtime-plugin-confirm-${encodeURIComponent(module)}`)?.focus()
}

async function cancelDelete(module: string) {
  deleting.value = undefined
  await nextTick()
  document.getElementById(`runtime-plugin-delete-${encodeURIComponent(module)}`)?.focus()
}

async function submitInstall() {
  if (!trusted.value || !module.value.trim()) return
  await run(async () => {
    const value: unknown = JSON.parse(config.value)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(t('runtime.configObject'))
    await props.install({
      module: module.value.trim(),
      ...(exportName.value.trim() ? { export: exportName.value.trim() } : {}),
      config: value as Record<string, unknown>
    })
    await closeInstall()
    module.value = ''
    exportName.value = ''
    config.value = '{}'
  })
}

onMounted(() => {
  available.value = props.isAvailable()
  if (available.value) {
    node.value = props.source() === 'node'
    void run(async () => {})
  }
})
</script>

<template>
  <ClientOnly>
    <section class="space-y-4" aria-labelledby="runtime-plugin-title" :aria-busy="busy">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 id="runtime-plugin-title" class="text-lg font-semibold text-highlighted">
          {{ t('runtime.title') }}
        </h2>
        <UButton v-if="available" id="runtime-plugin-add" :label="t('runtime.add')" icon="i-lucide-plus" :disabled="busy || adding" @click="openInstall" />
      </div>
      <UAlert v-if="error" color="error" :title="error" role="alert" :ui="{ title: 'break-words' }" />
      <p v-if="!available" class="text-sm text-muted">{{ t('runtime.unavailable') }}</p>
      <template v-else>
        <UAlert color="warning" variant="subtle" icon="i-lucide-shield-alert" :title="t('runtime.trustTitle')" :description="t(node ? 'runtime.nodeTrust' : 'runtime.browserTrust')" />
        <form v-if="adding" class="space-y-4 rounded-lg border border-default p-4" @submit.prevent="submitInstall">
          <UFormField :label="t(node ? 'runtime.nodeModule' : 'runtime.browserModule')" name="runtime-module" required>
            <UInput ref="moduleInput" v-model="module" class="w-full" :disabled="busy" :placeholder="node ? '@example/keundal-plugin@1.0.0' : 'https://example.com/plugin.mjs'" required />
          </UFormField>
          <UFormField :label="t('runtime.export')" name="runtime-export">
            <UInput v-model="exportName" class="w-full" placeholder="default" :disabled="busy" />
          </UFormField>
          <UFormField :label="t('runtime.config')" name="runtime-config">
            <UTextarea v-model="config" class="w-full font-mono" :rows="3" :disabled="busy" />
          </UFormField>
          <UCheckbox v-model="trusted" :label="t('runtime.trustConsent')" :disabled="busy" />
          <div class="flex gap-2">
            <UButton type="submit" :label="t('runtime.install')" :loading="busy" :disabled="!trusted || !module.trim()" />
            <UButton :label="t('common.cancel')" color="neutral" variant="ghost" :disabled="busy" @click="closeInstall" />
          </div>
          <p class="text-xs text-muted">{{ t(node ? 'runtime.nodeInstall' : 'runtime.browserInstall') }}</p>
        </form>
        <p v-if="!plugins.length && !busy" class="text-sm text-muted">{{ t('runtime.empty') }}</p>
        <ul v-if="plugins.length" class="space-y-3">
          <li v-for="plugin in plugins" :key="plugin.module" class="space-y-3 rounded-lg border border-default p-4">
            <div class="flex items-start gap-3">
              <div class="min-w-0 flex-1 space-y-1">
                <p class="text-sm font-medium break-all">{{ plugin.module }}</p>
                <p class="text-xs text-muted" role="status">{{ t(plugin.error ? 'runtime.failed' : plugin.enabled ? 'runtime.enabled' : 'runtime.disabled') }}</p>
                <p v-if="plugin.export" class="text-xs text-muted break-all">{{ t('runtime.export') }}: {{ plugin.export }}</p>
              </div>
              <USwitch :model-value="plugin.enabled" :disabled="busy" :aria-label="t('runtime.enable', { name: plugin.module })" @update:model-value="run(() => setEnabled(plugin.module, $event))" />
            </div>
            <UAlert v-if="plugin.error" color="error" :title="plugin.error" :ui="{ title: 'break-words' }" />
            <div v-if="deleting === plugin.module" class="flex flex-wrap items-center gap-3">
              <p class="text-sm">{{ t('runtime.removeConfirm') }}</p>
              <UButton :label="t('common.cancel')" color="neutral" variant="ghost" :disabled="busy" @click="cancelDelete(plugin.module)" />
              <UButton :id="`runtime-plugin-confirm-${encodeURIComponent(plugin.module)}`" :label="t('common.delete')" color="error" :disabled="busy" :aria-label="t('runtime.remove', { name: plugin.module })" @click="run(async () => { await remove(plugin.module); deleting = undefined })" />
            </div>
            <UButton v-else :id="`runtime-plugin-delete-${encodeURIComponent(plugin.module)}`" :label="t('common.delete')" color="error" variant="ghost" icon="i-lucide-trash-2" :disabled="busy" :aria-label="t('runtime.remove', { name: plugin.module })" @click="requestDelete(plugin.module)" />
          </li>
        </ul>
        <p class="text-xs text-muted">{{ t('runtime.persistence') }}</p>
      </template>
    </section>
  </ClientOnly>
</template>
