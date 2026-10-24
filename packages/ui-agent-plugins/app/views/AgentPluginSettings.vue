<script setup lang="ts">
import type { AgentPluginInfo, AgentPluginSettings } from '@keundal/chat/platform'

import { importPluginDirectory } from '../lib/plugin-import'
import { useText } from '../locale'

const props = defineProps<{
  /** The connection can manage browser plugins. */
  isAvailable: () => boolean
  list: () => Promise<AgentPluginInfo[]>
  importFiles: (files: Record<string, string>) => Promise<void>
  configure: (name: string, settings: AgentPluginSettings) => Promise<void>
  remove: (name: string) => Promise<void>
}>()

const { t } = useText()
// The platform exists only in the browser, so availability is read after mounting.
const available = ref(false)
const plugins = ref<AgentPluginInfo[]>([])
const error = ref('')
const busy = ref(false)
const input = ref<HTMLInputElement | null>(null)
const permissionsForm = ref<HTMLFormElement | null>(null)
const selected = ref<AgentPluginInfo | null>(null)
const deleting = ref<string | null>(null)
const scopes = ref<Record<string, { tools: string, resources: string }>>({})
const scope = (value: string) => value.trim() === '*' ? '*' as const : value.split('\n').map(item => item.trim()).filter(Boolean)
const text = (value: '*' | readonly string[] | undefined) => value === '*' ? '*' : value?.join('\n') ?? ''

async function run(action: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    await action()
    plugins.value = await props.list()
    if (selected.value) selected.value = plugins.value.find(plugin => plugin.name === selected.value!.name) ?? null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
onMounted(() => {
  available.value = props.isAvailable()
  if (available.value) void run(async () => {})
})

async function importDirectory(event: Event) {
  const target = event.target as HTMLInputElement
  if (!target.files?.length) return
  await run(async () => props.importFiles(await importPluginDirectory(Array.from(target.files!))))
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
    await props.configure(plugin.name, {
      enabled: plugin.enabled,
      permissions: Object.fromEntries(Object.entries(scopes.value).map(([name, value]) => [name, {
        tools: scope(value.tools), resources: scope(value.resources)
      }]))
    })
    selected.value = null
  })
  if (!selected.value) await closeEdit(plugin.name)
}
</script>

<template>
  <ClientOnly>
    <section class="space-y-4" aria-labelledby="plugin-settings-title">
      <h2 id="plugin-settings-title" class="text-lg font-semibold text-highlighted">
        {{ t('plugin.title') }}
      </h2>
      <p v-if="!available" class="text-sm text-muted">
        {{ t('plugin.unavailable') }}
      </p>
      <template v-if="available">
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
        <p v-if="!plugins.length && !busy && !error" class="text-sm text-muted">
          {{ t('plugin.empty') }}
        </p>
        <ul v-else-if="plugins.length" class="space-y-3">
          <li v-for="plugin in plugins" :key="plugin.name" class="space-y-3 rounded-lg border border-default p-3">
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
                @update:model-value="run(() => configure(plugin.name, { enabled: $event, permissions: plugin.permissions }))"
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
                @click="run(async () => { await remove(plugin.name); deleting = null })"
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
        <form v-if="selected" ref="permissionsForm" class="space-y-3 rounded-lg border border-default p-3" @submit.prevent="savePermissions">
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
  </ClientOnly>
</template>
