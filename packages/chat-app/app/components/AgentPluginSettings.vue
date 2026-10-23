<script setup lang="ts">
import type { AgentPluginInfo } from '@keundal/chat/platform'
import { importPluginDirectory } from '../../shared/utils/plugin-import'

const { t } = useLocale()
const { $chatPlatform, $chatStore } = useNuxtApp()
const manager = $chatPlatform.plugins
const plugins = ref<AgentPluginInfo[]>([])
const error = ref('')
const busy = ref(false)
const input = ref<HTMLInputElement | null>(null)
const permissionsForm = ref<HTMLFormElement | null>(null)
const selected = ref<AgentPluginInfo | null>(null)
const deleting = ref<string | null>(null)
const scopes = ref<Record<string, { tools: string, resources: string }>>({})
const stop = () => $chatStore.stop()
const scope = (value: string) => value.trim() === '*' ? '*' as const : value.split('\n').map(item => item.trim()).filter(Boolean)
const text = (value: '*' | readonly string[] | undefined) => value === '*' ? '*' : value?.join('\n') ?? ''

async function run(action: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    await action()
    plugins.value = await manager!.list()
    if (selected.value) selected.value = plugins.value.find(plugin => plugin.name === selected.value!.name) ?? null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
onMounted(() => {
  if (manager) void run(async () => {})
})

async function importDirectory(event: Event) {
  const target = event.target as HTMLInputElement
  if (!target.files?.length) return
  await run(async () => manager!.import(await importPluginDirectory(Array.from(target.files!)), stop))
  target.value = ''
}
async function requestDelete(name: string) {
  deleting.value = name
  await nextTick()
  document.getElementById(`plugin-confirm-delete-${encodeURIComponent(name)}`)?.focus()
}
async function cancelDelete(name: string) {
  deleting.value = null
  await nextTick()
  document.getElementById(`plugin-delete-${encodeURIComponent(name)}`)?.focus()
}
async function edit(plugin: AgentPluginInfo) {
  selected.value = plugin
  scopes.value = Object.fromEntries(plugin.servers.map(server => [server.name, {
    tools: text(plugin.permissions[server.name]?.tools),
    resources: text(plugin.permissions[server.name]?.resources)
  }]))
  await nextTick()
  permissionsForm.value?.querySelector('textarea')?.focus()
}
async function closeEdit(name: string) {
  selected.value = null
  await nextTick()
  document.getElementById(`plugin-permissions-${encodeURIComponent(name)}`)?.focus()
}
async function savePermissions() {
  const plugin = selected.value!
  await run(async () => {
    await manager!.configure(plugin.name, {
      enabled: plugin.enabled,
      permissions: Object.fromEntries(Object.entries(scopes.value).map(([name, value]) => [name, {
        tools: scope(value.tools), resources: scope(value.resources)
      }]))
    }, stop)
    selected.value = null
  })
  if (!selected.value) await closeEdit(plugin.name)
}
</script>

<template>
  <section class="space-y-6" aria-labelledby="plugin-settings-title">
    <div class="space-y-2">
      <h2 id="plugin-settings-title" class="text-lg font-semibold text-highlighted">
        {{ t('plugin.title') }}
      </h2>
      <p class="text-sm text-muted">
        {{ t(manager ? 'plugin.description' : 'plugin.unavailable') }}
      </p>
    </div>
    <template v-if="manager">
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-lucide-shield-alert"
        :title="t('plugin.trustTitle')"
        :description="t('plugin.notice')"
      />
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="text-sm font-semibold">
          {{ t('plugin.installed') }}
        </h3>
        <input
          ref="input"
          type="file"
          webkitdirectory
          multiple
          class="hidden"
          :aria-label="t('plugin.import')"
          @change="importDirectory"
        >
        <UButton
          :label="t('plugin.import')"
          icon="i-lucide-folder-plus"
          :loading="busy"
          @click="input?.click()"
        />
      </div>
      <div v-if="!plugins.length && !busy" class="rounded-lg border border-dashed border-default px-4 py-8 text-center">
        <UIcon name="i-lucide-blocks" class="size-7 text-dimmed" />
        <p class="mt-2 text-sm font-medium">
          {{ t('plugin.empty') }}
        </p>
        <p class="mt-1 text-sm text-muted">
          {{ t('plugin.emptyHelp') }}
        </p>
      </div>
      <ul v-else class="space-y-4">
        <li v-for="plugin in plugins" :key="plugin.name" class="space-y-4 rounded-lg border border-default p-4">
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1 space-y-1">
              <p class="text-sm font-semibold break-words">
                {{ plugin.name }} <span class="font-normal text-muted">{{ plugin.version }}</span>
              </p>
              <p v-if="plugin.description" class="text-sm text-muted break-words">
                {{ plugin.description }}
              </p>
            </div>
            <USwitch
              :model-value="plugin.enabled"
              :disabled="busy"
              :aria-label="t('plugin.enable', { name: plugin.name })"
              @update:model-value="run(() => manager!.configure(plugin.name, { enabled: $event, permissions: plugin.permissions }, stop))"
            />
          </div>
          <p class="text-sm text-muted break-words">
            {{ t('plugin.skills') }}: {{ plugin.skills.join(', ') || t('plugin.none') }}
          </p>
          <div v-if="plugin.servers.length" class="space-y-2">
            <p class="text-sm font-medium">
              {{ t('plugin.servers') }}
            </p>
            <p v-for="server in plugin.servers" :key="server.name" class="text-sm text-muted break-all">
              {{ server.name }} · {{ server.url }}
            </p>
            <UButton
              :id="`plugin-permissions-${encodeURIComponent(plugin.name)}`"
              :label="t('plugin.permissions')"
              :aria-label="`${t('plugin.permissions')} ${plugin.name}`"
              color="neutral"
              variant="outline"
              :disabled="busy"
              @click="edit(plugin)"
            />
          </div>
          <UAlert
            v-for="(diagnostic, index) in plugin.diagnostics"
            :key="index"
            color="warning"
            variant="subtle"
            :title="[diagnostic.component, diagnostic.entry].filter(Boolean).join(' · ')"
            :description="diagnostic.message"
            :ui="{ title: 'break-words', description: 'break-words' }"
          />
          <div v-if="deleting === plugin.name" class="flex flex-wrap items-center gap-3">
            <p class="text-sm">
              {{ t('plugin.deleteHelp') }}
            </p>
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="busy"
              @click="cancelDelete(plugin.name)"
            />
            <UButton
              :id="`plugin-confirm-delete-${encodeURIComponent(plugin.name)}`"
              :label="t('common.delete')"
              :aria-label="`${t('common.delete')} ${plugin.name}`"
              color="error"
              :disabled="busy"
              @click="run(async () => { await manager!.remove(plugin.name, stop); deleting = null })"
            />
          </div>
          <UButton
            v-else
            :id="`plugin-delete-${encodeURIComponent(plugin.name)}`"
            :label="t('common.delete')"
            :aria-label="`${t('common.delete')} ${plugin.name}`"
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            :disabled="busy"
            @click="requestDelete(plugin.name)"
          />
        </li>
      </ul>
      <form v-if="selected" ref="permissionsForm" class="space-y-4 rounded-lg border border-default p-4" @submit.prevent="savePermissions">
        <h3 class="font-semibold break-words">
          {{ selected.name }} · {{ t('plugin.permissions') }}
        </h3>
        <p class="text-sm text-muted">
          {{ t('mcp.permissions') }}
        </p>
        <fieldset v-for="server in selected.servers" :key="server.name" class="min-w-0 space-y-3">
          <legend class="mb-2 w-full text-sm font-medium break-words">
            {{ server.name }}
          </legend>
          <UFormField :label="t('mcp.tools')" :name="`${server.name}-tools`">
            <UTextarea v-model="scopes[server.name]!.tools" class="w-full" :disabled="busy" />
          </UFormField>
          <UFormField :label="t('mcp.resources')" :name="`${server.name}-resources`">
            <UTextarea v-model="scopes[server.name]!.resources" class="w-full" :disabled="busy" />
          </UFormField>
        </fieldset>
        <div class="flex gap-2">
          <UButton type="submit" :label="t('common.save')" :loading="busy" />
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="busy"
            @click="closeEdit(selected.name)"
          />
        </div>
      </form>
      <p class="text-xs text-muted">
        {{ t('plugin.persistence') }}
      </p>
    </template>
    <UAlert
      v-if="error"
      color="error"
      :title="error"
      role="alert"
    />
  </section>
</template>
